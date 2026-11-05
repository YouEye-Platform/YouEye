/**
 * Homepage (Dashboard)
 *
 * The main page users see after logging in.
 * Displays a widget grid with animated backgrounds and the user's
 * personalized widget layout.
 */

import { getSession } from "@/lib/auth";
import { getUserWidgets } from "@/lib/db/queries/widgets";
import { getUserBackground, getUserWordartOverride } from "@/lib/db/queries/settings";
import { getBranding } from "@/lib/db/queries/branding";
import { findUserById, hasCompletedOnboarding } from "@/lib/db/queries/users";
import { WidgetGrid } from "@/components/dashboard/widget-grid";
import { Navbar } from "@/components/layout/navbar";
import { FontPreloadLink } from "@/components/layout/font-preload";
import { redirect } from "next/navigation";
import { resolveTitle } from "@youeye/branding/appearance";

export default async function HomePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  // Check if user needs onboarding
  const onboarded = await hasCompletedOnboarding(session.userId);
  if (!onboarded) redirect("/onboarding");

  const [widgets, background, branding, user, wordartOverride] = await Promise.all([
    getUserWidgets(session.userId),
    getUserBackground(session.userId),
    getBranding(),
    findUserById(session.userId),
    getUserWordartOverride(session.userId),
  ]);

  // Use firstName for greeting widget, fall back to display name or username
  const greetingName = user?.firstName || session.name || session.username;

  // Preload the font being used for the site name
  const title = resolveTitle(branding, wordartOverride);
  const activeStyle = title.style;
  const fontFamily = activeStyle?.fontFamily ?? "Inter";

  return (
    <div className="relative min-h-screen">
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
      <main className="relative h-[calc(100vh-3.5rem)] overflow-hidden">
        <WidgetGrid
          widgets={widgets}
          username={greetingName}
          initialBackground={background}
        />
      </main>
    </div>
  );
}
