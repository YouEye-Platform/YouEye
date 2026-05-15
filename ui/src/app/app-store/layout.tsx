/**
 * App Store Layout
 *
 * Standalone full-page layout for the app store experience.
 * Includes the main Navbar for consistent navigation.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getBranding } from "@/lib/db/queries/branding";
import { Navbar } from "@/components/layout/navbar";

export default async function AppStoreLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/");

  const branding = await getBranding();

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
      <main className="w-full">{children}</main>
    </div>
  );
}
