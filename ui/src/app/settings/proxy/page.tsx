/**
 * Proxy Settings Page (Admin Only)
 *
 * Read-only view of Caddy reverse proxy routes.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { ProxySettings } from "@/components/settings/admin/proxy-settings";

export default async function ProxySettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  return <ProxySettings />;
}
