/**
 * Login Page
 *
 * Redirects immediately to Authentik SSO unless there's an error param.
 * Error param prevents infinite redirect loops when SSO callback fails.
 */

import { redirect } from "next/navigation";
import { getSession, isSSOConfigured } from "@/lib/auth";
import { LoginCard } from "@/components/auth/login-card";
import { getSiteName } from "@/lib/site-config";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // If already logged in, go to homepage
  try {
    const session = await getSession();
    if (session) redirect("/");
  } catch {
    // Not logged in, continue
  }

  const params = await searchParams;

  // Error from SSO callback — show error UI
  if (params.error) {
    const ssoConfigured = isSSOConfigured();
    const siteName = await getSiteName();
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <LoginCard error={params.error} ssoConfigured={ssoConfigured} siteName={siteName} />
      </div>
    );
  }

  // Happy path — go directly to Authentik
  redirect("/api/auth/sso");
}
