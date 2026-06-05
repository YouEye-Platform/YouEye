import { redirect } from "next/navigation";
import { SystemClient } from "@/components/settings-shell/system-client";
import { getSession } from "@/lib/auth/session";

export default async function SystemSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  return <SystemClient />;
}
