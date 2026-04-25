/**
 * TLS Settings Page (Admin Only)
 *
 * Embeds CP's TLS certificate management view via iframe.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { AdminEmbed } from "@/components/settings/admin-embed";

export default async function TlsSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  const embedUrl = getSignedEmbedUrl("tls", session.username, true);

  return <AdminEmbed signedUrl={embedUrl} title="TLS Certificates" />;
}
