/**
 * Backup & Restore Settings Page (Admin Only)
 *
 * Displays backup configuration and history from the Control Panel bridge.
 * Supports per-app backup scheduling, backup history, and restore operations.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { BackupSettings } from "@/components/settings/admin/backup-settings";

export default async function BackupSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  return <BackupSettings />;
}
