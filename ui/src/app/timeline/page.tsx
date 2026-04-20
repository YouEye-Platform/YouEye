/**
 * Timeline Page
 *
 * Chronological view of all user history, future events, and imports.
 * All data is encrypted at rest and requires PIN to decrypt.
 */

import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getBranding } from "@/lib/db/queries/branding";
import { getUserWordartOverride } from "@/lib/db/queries/settings";
import { Navbar } from "@/components/layout/navbar";
import { FontPreloadLink } from "@/components/layout/font-preload";
import { TimelineFeed } from "@/components/timeline/timeline-feed";
import { hasPIN, hasActivePINSession } from "@/lib/crypto/pin-session";
import { getTranslations } from "next-intl/server";

export default async function TimelinePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const t = await getTranslations('timeline');

  const [branding, pinExists, sessionActive, wordartOverride] = await Promise.all([
    getBranding(),
    hasPIN(session.userId),
    hasPIN(session.userId).then((exists) =>
      exists ? hasActivePINSession(session.userId) : false
    ),
    getUserWordartOverride(session.userId),
  ]);

  // Preload the font being used for the site name
  const activeStyle = wordartOverride ?? branding.site_name_style;
  const fontFamily = activeStyle?.fontFamily ?? "Inter";

  return (
    <div className="min-h-screen bg-background">
      <FontPreloadLink fontFamily={fontFamily} />
      <Navbar
        username={session.name || session.username}
        email={session.email}
        isAdmin={session.isAdmin}
        siteName={branding.site_name}
        siteNameStyle={wordartOverride ?? branding.site_name_style}
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
