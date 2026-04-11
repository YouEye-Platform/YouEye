/**
 * Users Settings Page (Admin Only)
 *
 * Displays user data from Authentik via the Control Panel bridge.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { UserSettings } from "@/components/settings/admin/user-settings";

export default async function UsersSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  return <UserSettings />;
}
