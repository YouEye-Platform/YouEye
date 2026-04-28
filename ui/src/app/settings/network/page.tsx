/**
 * Network Settings Page (Admin Only)
 *
 * Tabbed page combining DNS (Pi-Hole) and TLS certificate management.
 * Each tab embeds the respective CP embed via iframe.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { NetworkTabs } from "./client";

export default async function NetworkSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  const dnsUrl = getSignedEmbedUrl("dns", session.username, true);
  const tlsUrl = getSignedEmbedUrl("tls", session.username, true);

  return <NetworkTabs dnsUrl={dnsUrl} tlsUrl={tlsUrl} />;
}
