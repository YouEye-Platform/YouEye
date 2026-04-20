import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { AdminEmbed } from "@/components/settings/admin-embed";

export default async function DnsSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  // Embed now uses session-based auth — CP validates user's SSO session cookie
  const embedUrl = getSignedEmbedUrl("dns", session.username, true);

  return <AdminEmbed signedUrl={embedUrl} title="DNS Settings" />;
}
