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

  const signedUrl = getSignedEmbedUrl("backup", session.username, true);
  if (!signedUrl) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Bridge token not configured. Cannot load admin settings.
      </div>
    );
  }

  return <AdminEmbed signedUrl={signedUrl} title="Backup & Restore" />;
}
