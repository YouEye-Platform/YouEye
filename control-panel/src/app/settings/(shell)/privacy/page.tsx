import { redirect } from "next/navigation";
import { PrivacyClient } from "@/components/settings-shell/privacy-client";
import { getSession } from "@/lib/auth/session";

export default async function PrivacySettingsPage() {
  const session = await getSession();
  // Personal page — the local-admin (PAM/CLI) door only surfaces admin settings.
  if (session?.authMethod === "pam" || session?.authMethod === "cli") {
    redirect("/settings/system");
  }
  return <PrivacyClient isAdmin={session?.isAdmin ?? false} />;
}
