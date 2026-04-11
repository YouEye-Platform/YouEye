/**
 * System Settings Page (Admin Only)
 *
 * Displays system info from the Control Panel bridge:
 * host info, CPU/memory/disk usage, container summary.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { SystemSettings } from "@/components/settings/admin/system-settings";

export default async function SystemSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  return <SystemSettings />;
}
