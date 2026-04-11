/**
 * Notifications Page
 *
 * Full notifications view with filtering, search, and bulk actions.
 */

import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getBranding } from "@/lib/db/queries/branding";
import { Navbar } from "@/components/layout/navbar";
import { NotificationsList } from "@/components/notifications/notifications-list";
import { getTranslations } from "next-intl/server";

export default async function NotificationsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const [branding, t] = await Promise.all([
    getBranding(),
    getTranslations("notifications"),
  ]);

  return (
    <div className="relative min-h-screen bg-background">
      <Navbar
        username={session.name || session.username}
        email={session.email}
        isAdmin={session.isAdmin}
        siteName={branding.site_name}
        siteNameStyle={branding.site_name_style}
        logoUrl={branding.logo_url}
      />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-2xl font-bold mb-6">{t("pageTitle")}</h1>
        <NotificationsList />
      </main>
    </div>
  );
}
