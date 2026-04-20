import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db, ensureSchema } from "@/db";
import { apps } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ConnectorSetup } from "@/components/settings/connector-setup";

export default async function ConnectorSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ app?: string; capability?: string; redirect?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const params = await searchParams;
  const appId = params.app;
  const capability = params.capability;
  const redirectUri = params.redirect;

  if (!appId || !capability) {
    redirect("/settings/connectors");
  }

  await ensureSchema();
  const [app] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);

  if (!app) {
    redirect("/settings/connectors");
  }

  const manifest = app.manifest as Record<string, unknown> | null;
  const connectorReqs = (manifest?.connectors as {
    requires?: Array<{ capability: string }>;
  })?.requires ?? [];
  const validCapability = connectorReqs.some((r) => r.capability === capability);

  if (!validCapability) {
    redirect("/settings/connectors");
  }

  const validRedirect = redirectUri
    ? validateRedirectUri(redirectUri, app.subdomain)
    : null;

  return (
    <ConnectorSetup
      appId={appId}
      appName={app.name}
      capability={capability}
      redirectUri={validRedirect}
      userName={session.name || session.username || ""}
      userImage={session.image || null}
    />
  );
}

function validateRedirectUri(uri: string, appSubdomain: string | null): string | null {
  try {
    const url = new URL(uri);
    if (appSubdomain && url.hostname.startsWith(appSubdomain + ".")) {
      return uri;
    }
    const platformDomain = (process.env.UI_EXTERNAL_URL || '').replace(/^https?:\/\//, '');
    if (url.hostname === "localhost" || (platformDomain && url.hostname.endsWith(platformDomain))) {
      return uri;
    }
    return null;
  } catch {
    return null;
  }
}
