import { AppsClient } from "@/components/settings-shell/apps-client";
import { getSession } from "@/lib/auth/session";

export default async function AppsSettingsPage() {
  const session = await getSession();
  const hasUserContext = session?.authMethod !== "pam" && session?.authMethod !== "cli";
  return <AppsClient isAdmin={session?.isAdmin ?? false} hasUserContext={hasUserContext} />;
}
