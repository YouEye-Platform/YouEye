/**
 * DNS Settings Page (Admin Only)
 *
 * Pi-Hole DNS stats and control.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { DnsSettings } from "@/components/settings/admin/dns-settings";

export default async function DnsSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  return <DnsSettings />;
}
