import { validateEmbedSession } from "@/lib/embed/session-auth";
import { EmbedAuthError } from "@/components/embed/auth-error";
import { ProfileIdentityClient } from "@/components/settings-shell/profile-identity-client";

export default async function ProfileEmbedPage() {
  // Any authenticated user can edit their own profile — not admin-only
  const auth = await validateEmbedSession("user");

  if (!auth.authorized) {
    return <EmbedAuthError reason={auth.reason || "Unauthorized"} showSignIn={!auth.authenticated} />;
  }

  return <ProfileIdentityClient username={auth.session!.username} isAdmin={auth.session!.isAdmin} />;
}
