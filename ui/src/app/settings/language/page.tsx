import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getUserSettings } from "@/lib/db/queries/settings";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { LanguageTabs } from "@/components/settings/language-tabs";

export default async function LanguagePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const settings = await getUserSettings(session.userId);
  const currentUserLang = (settings.language as string) || null;

  const systemLangUrl = session.isAdmin
    ? getSignedEmbedUrl("language", session.username, true)
    : null;

  return (
    <LanguageTabs
      currentLanguage={currentUserLang}
      isAdmin={session.isAdmin}
      serverLanguageUrl={systemLangUrl}
    />
  );
}
