import { redirect } from "next/navigation";
import { SystemClient } from "@/components/settings-shell/system-client";
import { getSession } from "@/lib/auth/session";
import { controlPanelVersion } from "@/lib/build-version";
import { spineClient } from "@/lib/spine/client";

export default async function SystemSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  // The running Spine (selected on State, or the seed baked into the image).
  let spine: { running: string; seed: string } | undefined;
  try {
    const status = await spineClient.getSpineStatus();
    spine = { running: status.version, seed: status.spine.seed.version };
  } catch { /* older Spine or not an appliance */ }
  // The running Control Panel ("Server interface") version — not in /api/health/services.
  return <SystemClient cpVersion={controlPanelVersion()} spine={spine} />;
}
