import { redirect } from "next/navigation";
import { LanguageCard } from "@/components/settings/language-card";
import { LanguageClient } from "@/components/settings-shell/language-client";
import { PageHeader } from "@/components/settings-shell/page-header";
import { getSession } from "@/lib/auth/session";

export default async function LanguageSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/settings/login");

  return (
    <div className="space-y-8">
      <div>
        <PageHeader title="Language" description="Choose your language preference." />
        <LanguageClient />
      </div>
      {session.isAdmin && (
        <section className="border-t pt-8">
          <PageHeader title="System Language" description="Set the default language for the instance." />
          <LanguageCard />
        </section>
      )}
    </div>
  );
}
