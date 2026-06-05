import { redirect } from "next/navigation";
import { Image, Palette } from "lucide-react";
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
          <div className="grid gap-4 md:grid-cols-2">
            <section className="rounded-lg border bg-card p-5">
              <Palette className="mb-3 h-5 w-5 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Default site identity</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Instance-wide branding is owned by Control Panel and pushed to UI through the bridge. The user-facing WordArt override above is already active for this account.
              </p>
            </section>
            <section className="rounded-lg border bg-card p-5">
              <Image className="mb-3 h-5 w-5 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Icons and favicon</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Root-domain settings and market now serve favicon aliases through Control Panel so branding works on path-mounted pages.
              </p>
            </section>
          </div>
        </section>
      )}
    </div>
  );
}
