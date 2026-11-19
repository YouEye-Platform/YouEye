import { redirect } from "next/navigation";
import { SystemClient } from "@/components/settings-shell/system-client";
import { getSession } from "@/lib/auth/session";
import { installedRelease } from "@/lib/releases/installed-release";

export default async function SystemSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  // Every part shows the installed release's version, never a build name baked into a file.
  return <SystemClient release={(await installedRelease())?.version} />;
}
