/**
 * System Settings Page (Admin Only)
 *
 * Embeds CP's system dashboard via iframe.
 * Auth is handled by signed embed token (HMAC with bridge key).
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { AdminEmbed } from "@/components/settings/admin-embed";

export default async function SystemSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  const signedUrl = getSignedEmbedUrl("system", session.username, true, { theme: "dark" });
  if (!signedUrl) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Bridge token not configured. Cannot load admin settings.
      </div>
    );
  }

  return <AdminEmbed signedUrl={signedUrl} title="System Settings" />;
}
