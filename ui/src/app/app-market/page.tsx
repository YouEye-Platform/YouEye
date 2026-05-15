/**
 * App Market — Full Page
 *
 * Embeds the Control Panel's marketplace UI via iframe.
 * Layout provides the YouEye navbar and auth gate.
 * Auth via session-based SSO — Control Panel validates user's session cookie.
 */

import { getSession } from "@/lib/auth";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { AdminEmbed } from "@/components/settings/admin-embed";

export default async function AppMarketPage() {
  // Layout already gates auth — session is guaranteed here
  const session = await getSession();

  // Embed now uses session-based auth — Control Panel validates user's SSO session cookie
  const embedUrl = session
    ? getSignedEmbedUrl("market", session.username, true)
    : "";

  return (
    <div className="w-full px-0 py-0">
      <AdminEmbed signedUrl={embedUrl} title="App Market" minHeight={600} />
    </div>
  );
}
