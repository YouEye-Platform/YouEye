import { redirect } from "next/navigation";
import { GeneralClient } from "@/components/settings-shell/general-client";
import { getSession } from "@/lib/auth/session";
import { installedRelease, releaseDetails } from "@/lib/releases/installed-release";

export default async function GeneralSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  // The box's version is its installed release document's version; the details line adds the release's git tree
  // (for support).
  const release = await installedRelease();
  return <GeneralClient release={release ? { version: release.version, details: releaseDetails(release) } : undefined} />;
}
