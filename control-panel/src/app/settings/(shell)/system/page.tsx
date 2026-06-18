import { redirect } from "next/navigation";
import { SystemClient } from "@/components/settings-shell/system-client";
import { getSession } from "@/lib/auth/session";
import pkg from "../../../../../package.json";

export default async function SystemSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  // The running Control Panel ("Server interface") version — not in /api/health/services.
  return <SystemClient cpVersion={pkg.version} />;
}
