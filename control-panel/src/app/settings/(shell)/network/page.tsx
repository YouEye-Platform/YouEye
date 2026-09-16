import { redirect } from "next/navigation";
import { NetworkClient } from "@/components/settings-shell/network-client";
import { getSession } from "@/lib/auth/session";

export default async function NetworkSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");
  // Resolve the tab server-side so the client renders the right tab on first
  // paint (no default-then-sync flash) without a hydration mismatch.
  const { tab } = await searchParams;
  const initialTab = tab === "routes" || tab === "domain" ? tab : tab === "tls" ? ("domain" as const) : ("dns" as const);
  return <NetworkClient initialTab={initialTab} />;
}
