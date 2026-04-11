/**
 * Containers Settings Page (Admin Only)
 *
 * Lists Incus containers with start/stop/restart actions.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { ContainerSettings } from "@/components/settings/admin/container-settings";

export default async function ContainersSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  return <ContainerSettings />;
}
