import { redirect } from "next/navigation";
import { AboutClient } from "@/components/settings-shell/about-client";
import { getSession } from "@/lib/auth/session";
import { installedRelease, releaseDetails } from "@/lib/releases/installed-release";

export default async function AboutSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  // The box's version is its installed release document's version; the
  // details line adds the release's git tree (for support, with Copy).
  const release = await installedRelease();
  return <AboutClient release={release ? { version: release.version, details: releaseDetails(release) } : undefined} />;
}
