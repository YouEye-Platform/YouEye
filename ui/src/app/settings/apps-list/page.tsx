/**
 * Apps List Settings Page (Admin Only)
 *
 * Admin page showing all installed apps with versions,
 * container status, and update controls.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppsListSettings } from "@/components/settings/admin/apps-list-settings";

export default async function AppsListPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  return <AppsListSettings />;
}
