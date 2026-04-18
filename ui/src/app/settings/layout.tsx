/**
 * Settings Layout
 *
 * Unified settings page with sidebar navigation.
 * Includes the YouEye navbar at the top for consistent navigation.
 * Admin users see additional sections (Branding, Users, System, App Market).
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getBranding } from "@/lib/db/queries/branding";
import { getUserWordartOverride } from "@/lib/db/queries/settings";
import { Navbar } from "@/components/layout/navbar";
import { SettingsShell } from "@/components/settings/settings-shell";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const [branding, wordartOverride] = await Promise.all([
    getBranding(),
    getUserWordartOverride(session.userId),
  ]);

  return (
    <div className="min-h-screen bg-background">
      <Navbar
        username={session.name || session.username}
        email={session.email}
        isAdmin={session.isAdmin}
        siteName={branding.site_name}
        siteNameStyle={wordartOverride ?? branding.site_name_style}
        logoUrl={branding.logo_url}
      />
      <SettingsShell
        isAdmin={session.isAdmin ?? false}
        username={session.username ?? ""}
      >
        {children}
      </SettingsShell>
    </div>
  );
}
