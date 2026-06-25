import { LanguageClient } from "@/components/settings-shell/language-client";
import { getSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";

export default async function LanguageSettingsPage() {
  const session = await getSession();
  if (session?.authMethod === "pam" || session?.authMethod === "cli") {
    redirect("/settings/system");
  }

  return <LanguageClient isAdmin={session?.isAdmin ?? false} />;
}
