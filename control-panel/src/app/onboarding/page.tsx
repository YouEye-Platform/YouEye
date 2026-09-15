import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { OnboardingClient } from "@/components/onboarding/onboarding-client";

export default async function OnboardingPage() {
  const session = await getSession();
  if (!session) redirect("/login?redirect=/onboarding");
  if (session.authMethod === "pam" || session.authMethod === "cli") redirect("/settings");
  return <OnboardingClient username={session.username} />;
}
