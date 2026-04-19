/**
 * App Market — Full Page
 *
 * Embeds the Control Panel's marketplace UI via iframe.
 * Replaces the old /app-store page that used bridge API calls.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { AdminEmbed } from "@/components/settings/admin-embed";

export default async function AppMarketPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/");

  const signedUrl = getSignedEmbedUrl("market", session.username, true);
  if (!signedUrl) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-12 text-center text-muted-foreground">
        Bridge token not configured. Cannot load App Market.
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <AdminEmbed signedUrl={signedUrl} title="App Market" minHeight={500} />
    </div>
  );
}
