/**
 * Branding Settings Page (Admin Only)
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { BrandingSettings } from "@/components/settings/branding-settings";

export default async function BrandingPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  return <BrandingSettings />;
}
