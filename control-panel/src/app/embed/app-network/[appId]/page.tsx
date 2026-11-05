import { validateEmbedSession } from "@/lib/embed/session-auth";
import { EmbedAuthError } from "@/components/embed/auth-error";
import { AppNetworkClient } from "./client";

export default async function AppNetworkEmbedPage({
  params,
}: {
  params: Promise<{ appId: string }>;
}) {
  const { appId } = await params;
  const auth = await validateEmbedSession("admin");

  if (!auth.authorized) {
    return <EmbedAuthError reason={auth.reason || "Unauthorized"} showSignIn={!auth.authenticated} />;
  }

  return <AppNetworkClient appId={appId} />;
}
