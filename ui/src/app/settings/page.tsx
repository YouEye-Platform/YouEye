/**
 * Settings Page — Profile Section (Default)
 *
 * Shows profile information with ability to update display name and avatar.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { ProfileSettings } from "@/components/settings/profile-settings";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <ProfileSettings
      userId={session.userId}
      username={session.username ?? ""}
      name={session.name ?? ""}
      email={session.email ?? ""}
      isAdmin={session.isAdmin ?? false}
    />
  );
}
