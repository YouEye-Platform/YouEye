/**
 * App Market — Full Page
 *
 * Embeds the Control Panel's marketplace UI via iframe.
 * Layout provides the YouEye navbar and auth gate.
 */

import { getSession } from "@/lib/auth";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { AdminEmbed } from "@/components/settings/admin-embed";

export default async function AppMarketPage() {
  // Layout already gates auth — session is guaranteed here
  const session = await getSession();

  const signedUrl = session
    ? getSignedEmbedUrl("market", session.username, true)
    : null;

  if (!signedUrl) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-12 text-center text-muted-foreground">
        Bridge token not configured. Cannot load App Market.
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <AdminEmbed signedUrl={signedUrl} title="App Market" minHeight={600} />
    </div>
  );
}
