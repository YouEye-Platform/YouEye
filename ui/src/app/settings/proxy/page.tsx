/**
 * Proxy Settings Page (Admin Only)
 *
 * Embeds CP's proxy routes view via iframe.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { AdminEmbed } from "@/components/settings/admin-embed";

export default async function ProxySettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  const signedUrl = getSignedEmbedUrl("proxy", session.username, true, { theme: "dark" });
  if (!signedUrl) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Bridge token not configured. Cannot load admin settings.
      </div>
    );
  }

  return <AdminEmbed signedUrl={signedUrl} title="Proxy Routes" />;
}
