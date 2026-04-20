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
import { FontPreloadLink } from "@/components/layout/font-preload";
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

  // Preload user's custom font if different from system font
  const userFont = wordartOverride?.fontFamily;
  const systemFont = branding.site_name_style?.fontFamily ?? "Inter";
  const needsUserFontPreload = userFont && userFont !== systemFont;

  return (
    <div className="min-h-screen bg-background">
      {needsUserFontPreload && <FontPreloadLink fontFamily={userFont} />}
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
