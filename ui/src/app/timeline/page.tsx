/**
 * Timeline Page
 *
 * Chronological view of all user history, future events, and imports.
 * All data is encrypted at rest and requires PIN to decrypt.
 */

import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getBranding } from "@/lib/db/queries/branding";
import { Navbar } from "@/components/layout/navbar";
import { TimelineFeed } from "@/components/timeline/timeline-feed";
import { hasPIN, hasActivePINSession } from "@/lib/crypto/pin-session";
import { getTranslations } from "next-intl/server";

export default async function TimelinePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const t = await getTranslations('timeline');

  const [branding, pinExists, sessionActive] = await Promise.all([
    getBranding(),
    hasPIN(session.userId),
    hasPIN(session.userId).then((exists) =>
      exists ? hasActivePINSession(session.userId) : false
    ),
  ]);

  return (
    <div className="min-h-screen bg-background">
      <Navbar
        username={session.name || session.username}
        email={session.email}
        isAdmin={session.isAdmin}
        siteName={branding.site_name}
        siteNameStyle={branding.site_name_style}
        logoUrl={branding.logo_url}
      />
      <main className="max-w-4xl mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('description')}
          </p>
        </div>
        <TimelineFeed
          initialPinExists={pinExists}
          initialSessionActive={sessionActive}
        />
      </main>
    </div>
  );
}
