import { redirect } from "next/navigation";
import { AboutClient } from "@/components/settings-shell/about-client";
import { getSession } from "@/lib/auth/session";
import { controlPanelVersion } from "@/lib/build-version";

export default async function AboutSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  // The running Control Panel ("Server interface") version comes from the
  // build's version.json — it is not exposed by /api/health/services.
  return <AboutClient cpVersion={controlPanelVersion()} />;
}
