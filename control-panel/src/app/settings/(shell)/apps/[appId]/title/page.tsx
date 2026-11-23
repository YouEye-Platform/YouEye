import { redirect } from "next/navigation";
import { AppTitleStudio } from "@/components/settings-shell/app-title-client";
import { getSession } from "@/lib/auth/session";

/** The title studio for one app: your title for it, or (`?scope=server`, admins) the default for everyone. */
export default async function AppTitlePage({
  params,
  searchParams,
}: {
  params: Promise<{ appId: string }>;
  searchParams: Promise<{ scope?: string }>;
}) {
  const { appId } = await params;
  const { scope } = await searchParams;
  const session = await getSession();
  const hasUserContext = session?.authMethod !== "pam" && session?.authMethod !== "cli";
  if (!hasUserContext) redirect(`/settings/apps/${encodeURIComponent(appId)}`);
  return <AppTitleStudio appId={appId} scope={scope === "server" && session?.isAdmin ? "server" : "user"} />;
}
