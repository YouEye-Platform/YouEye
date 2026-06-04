import { redirect } from "next/navigation";
import { BrandingEmbedClient } from "@/app/embed/branding/client";
import { PageHeader } from "@/components/settings-shell/page-header";
import { WordArtClient } from "@/components/settings-shell/wordart-client";
import { getSession } from "@/lib/auth/session";

export default async function BrandingSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/settings/login");

  return (
    <div className="space-y-8">
      <div>
        <PageHeader title="Branding" description="Customize your personal site-name style." />
        <WordArtClient />
      </div>
      {session.isAdmin && (
        <section className="border-t pt-8">
          <PageHeader title="Server Branding" description="Set the default branding for the instance." />
          <BrandingEmbedClient />
        </section>
      )}
    </div>
  );
}
