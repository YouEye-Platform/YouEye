/**
 * Market Settings Page (Admin Only)
 *
 * Redirects to the Control Panel-owned Market surface.
 */

import { redirect } from "next/navigation";

export default function MarketSettingsPage() {
  redirect("/market");
}
