/**
 * Notifications Page
 *
 * Full notifications view with filtering, search, and bulk actions.
 */

import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getBranding } from "@/lib/db/queries/branding";
import { getUserWordartOverride } from "@/lib/db/queries/settings";
import { Navbar } from "@/components/layout/navbar";
import { FontPreloadLink } from "@/components/layout/font-preload";
import { NotificationsList } from "@/components/notifications/notifications-list";
import { getTranslations } from "next-intl/server";
import { resolveTitle } from "@youeye/branding/appearance";

export default async function NotificationsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const [branding, t, wordartOverride] = await Promise.all([
    getBranding(),
    getTranslations("notifications"),
    getUserWordartOverride(session.userId),
  ]);

  // Preload the font being used for the site name
  const title = resolveTitle(branding, wordartOverride);
  const activeStyle = title.style;
  const fontFamily = activeStyle?.fontFamily ?? "Inter";

  return (
    <div className="relative min-h-screen bg-background">
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
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-2xl font-bold mb-6">{t("pageTitle")}</h1>
        <NotificationsList />
      </main>
    </div>
  );
}
