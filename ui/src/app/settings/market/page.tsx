/**
 * App Market Settings Page (Admin Only)
 *
 * Redirects to the full-page App Store experience at /app-store.
 */

import { redirect } from "next/navigation";

export default function MarketSettingsPage() {
  redirect("/app-store");
}
