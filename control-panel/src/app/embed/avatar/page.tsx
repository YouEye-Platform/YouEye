import { validateEmbedSession } from "@/lib/embed/session-auth";
import { EmbedAuthError } from "@/components/embed/auth-error";
import { AvatarEmbedClient } from "./client";

export default async function AvatarEmbedPage() {
  const auth = await validateEmbedSession("user");

  if (!auth.authorized) {
    return <EmbedAuthError reason={auth.reason || "Unauthorized"} showSignIn={!auth.authenticated} />;
  }

  return <AvatarEmbedClient username={auth.session!.username} />;
}
