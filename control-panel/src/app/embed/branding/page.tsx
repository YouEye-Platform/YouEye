import { validateEmbedSession } from "@/lib/embed/session-auth";
import { EmbedAuthError } from "@/components/embed/auth-error";
import { BrandingEmbedClient } from "./client";

export default async function BrandingEmbedPage() {
  const auth = await validateEmbedSession("admin");

  if (!auth.authorized) {
    return <EmbedAuthError reason={auth.reason || "Unauthorized"} showSignIn={!auth.authenticated} />;
  }

  return <BrandingEmbedClient />;
}
