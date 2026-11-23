import { redirect } from "next/navigation";
import { NetworkClient } from "@/components/settings-shell/network-client";
import { networkTabFromParam } from "@/components/settings-shell/network-tabs";
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
  // No tab is "Address & HTTPS"; the old `domain` and `tls` values open it too.
  return <NetworkClient initialTab={networkTabFromParam(tab)} />;
}
