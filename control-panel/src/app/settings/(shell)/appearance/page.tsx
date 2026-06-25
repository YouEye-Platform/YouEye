import { AppearanceClient } from "@/components/settings-shell/appearance-client";
import { getSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";

export default async function AppearanceSettingsPage() {
  const session = await getSession();
  if (session?.authMethod === "pam" || session?.authMethod === "cli") {
    redirect("/settings/system");
  }
  return <AppearanceClient isAdmin={session?.isAdmin ?? false} />;
}
