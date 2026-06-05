import { AppearanceClient } from "@/components/settings-shell/appearance-client";
import { getSession } from "@/lib/auth/session";

export default async function AppearanceSettingsPage() {
  const session = await getSession();
  return <AppearanceClient isAdmin={session?.isAdmin ?? false} />;
}
