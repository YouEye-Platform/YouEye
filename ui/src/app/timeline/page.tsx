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
import { resolveTitle } from "@youeye/branding/appearance";

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
  const title = resolveTitle(branding, wordartOverride);
  const activeStyle = title.style;
  const fontFamily = activeStyle?.fontFamily ?? "Inter";

  return (
    <div className="min-h-screen bg-background">
      <FontPreloadLink fontFamily={fontFamily} />
      <Navbar
        username={session.name || session.username}
        email={session.email}
        isAdmin={session.isAdmin}
        siteName={title.name}
        siteNameStyle={title.style}
        logoUrl={branding.logo_url}
        showLogo={branding.site_name_style?.showHeaderLogo === true}
      />
      <main className="max-w-[640px] mx-auto px-5 pt-7 pb-16">
        <div className="mb-5">
          <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
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
