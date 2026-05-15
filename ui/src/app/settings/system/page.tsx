/**
 * System Settings Page (Admin Only)
 *
 * Embeds the Control Panel's system dashboard via iframe.
 * Auth via session-based SSO — Control Panel validates user's session cookie.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { AdminEmbed } from "@/components/settings/admin-embed";

export default async function SystemSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  // Embed now uses session-based auth — Control Panel validates user's SSO session cookie
  const embedUrl = getSignedEmbedUrl("system", session.username, true);

  return <AdminEmbed signedUrl={embedUrl} title="System Settings" />;
}
