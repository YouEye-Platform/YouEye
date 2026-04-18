import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getUserSettings } from "@/lib/db/queries/settings";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { UserLanguageSettings } from "@/components/settings/user-language-settings";
import { AdminEmbed } from "@/components/settings/admin-embed";

export default async function LanguagePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const settings = await getUserSettings(session.userId);
  const currentUserLang = (settings.language as string) || null;

  const systemLangUrl = session.isAdmin
    ? getSignedEmbedUrl("language", session.username, true, { theme: "dark" })
    : null;

  return (
    <div className="space-y-8">
      <UserLanguageSettings currentLanguage={currentUserLang} />

      {session.isAdmin && systemLangUrl && (
        <div className="border-t pt-8">
          <AdminEmbed signedUrl={systemLangUrl} title="System Language" minHeight={300} />
        </div>
      )}
    </div>
  );
}
