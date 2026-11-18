import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ControlHeader } from "@/components/control-surface/control-header";
import { SignInRedirect } from "@/components/market/sign-in-redirect";
import { getAuthModeForHost } from "@/lib/auth/mode";
import { getSession } from "@/lib/auth/session";

export async function MarketShell({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  // Signed out (or the sign-in has expired): sign in and come back to this exact page, query included, so an
  // "Add to YouEye" link survives the round trip. A server redirect here cannot know the page's address.
  if (!session) return <SignInRedirect sso={getAuthModeForHost((await headers()).get("host") || "") === "sso"} />;
  if (!session.isAdmin) redirect("/settings");
  const hasUserContext = session.authMethod !== "pam" && session.authMethod !== "cli";

  return (
    <div className="min-h-screen bg-background">
      <ControlHeader username={session.username} isAdmin={session.isAdmin} hasUserContext={hasUserContext} />
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
