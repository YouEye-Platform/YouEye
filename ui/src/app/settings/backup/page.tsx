/**
 * Backup & Restore Settings Page (Admin Only)
 *
 * Embeds CP's backup dashboard via iframe.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { AdminEmbed } from "@/components/settings/admin-embed";

export default async function BackupSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  // Embed now uses session-based auth — CP validates user's SSO session cookie
  const embedUrl = getSignedEmbedUrl("backup", session.username, true);

  return <AdminEmbed signedUrl={embedUrl} title="Backup & Restore" />;
}
