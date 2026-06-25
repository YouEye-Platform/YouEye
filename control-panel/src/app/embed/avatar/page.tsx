import { validateEmbedSession } from "@/lib/embed/session-auth";
import { AvatarEmbedClient } from "./client";

export default async function AvatarEmbedPage({
  searchParams,
}: {
  searchParams: Promise<{ username?: string }>;
}) {
  // Avatar picker is non-sensitive (emoji grid). Skip auth requirement so it
  // works during onboarding when the user has no CP session yet. The parent
  // page (UI onboarding) handles avatar saving via postMessage.
  const auth = await validateEmbedSession("user");
  const params = await searchParams;
  // Prefer session username, fall back to URL param (passed by onboarding page)
  const username = auth.session?.username || params.username || "";
  return <AvatarEmbedClient username={username} />;
}
