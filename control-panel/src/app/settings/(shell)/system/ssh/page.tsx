import { redirect } from "next/navigation";
import { RemoteAccessClient } from "@/components/settings-shell/remote-access-client";
import { getSession } from "@/lib/auth/session";

export default async function SSHSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");
  return <RemoteAccessClient />;
}
