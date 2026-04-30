import { validateEmbedSession } from "@/lib/embed/session-auth";
import { AvatarEmbedClient } from "./client";

export default async function AvatarEmbedPage() {
  // Avatar picker is non-sensitive (emoji grid). Skip auth requirement so it
  // works during onboarding when the user has no CP session yet. The parent
  // page (UI onboarding) handles avatar saving via postMessage.
  const auth = await validateEmbedSession("user");
  return <AvatarEmbedClient username={auth.session?.username || ""} />;
}
