import { LanguageClient } from "@/components/settings-shell/language-client";
import { getSession } from "@/lib/auth/session";

export default async function LanguageSettingsPage() {
  const session = await getSession();

  return <LanguageClient isAdmin={session?.isAdmin ?? false} />;
}
