import { AppsClient } from "@/components/settings-shell/apps-client";
import { getSession } from "@/lib/auth/session";

export default async function AppSettingsDetailPage({
  params,
}: {
  params: Promise<{ appId: string }>;
}) {
  const { appId } = await params;
  const session = await getSession();
  return <AppsClient isAdmin={session?.isAdmin ?? false} initialAppId={appId} />;
}
