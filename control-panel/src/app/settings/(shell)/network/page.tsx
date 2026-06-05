import { redirect } from "next/navigation";
import { NetworkClient } from "@/components/settings-shell/network-client";
import { getSession } from "@/lib/auth/session";

export default async function NetworkSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");
  return <NetworkClient />;
}
