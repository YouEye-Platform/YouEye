/**
 * Settings Page — Profile Section (Default)
 *
 * Shows profile information with:
 * - Control Panel embed for account name editing (synced to Authentik)
 * - Local fields for bio, timezone, avatar
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { ProfileSettings } from "@/components/settings/profile-settings";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const profileEmbedUrl = getSignedEmbedUrl("profile", session.username ?? "", session.isAdmin ?? false);

  return (
    <ProfileSettings
      userId={session.userId}
      username={session.username ?? ""}
      name={session.name ?? ""}
      email={session.email ?? ""}
      isAdmin={session.isAdmin ?? false}
      profileEmbedUrl={profileEmbedUrl}
    />
  );
}
