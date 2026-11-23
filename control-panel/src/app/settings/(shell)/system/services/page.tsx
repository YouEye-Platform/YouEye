import { redirect } from "next/navigation";
import { SystemClient } from "@/components/settings-shell/system-client";
import { getSession } from "@/lib/auth/session";
import { installedRelease } from "@/lib/releases/installed-release";

export default async function SystemServicesPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  // The parts the release installed show its version, never a build name baked into a file.
  return <SystemClient view="services" release={(await installedRelease())?.version} />;
}
