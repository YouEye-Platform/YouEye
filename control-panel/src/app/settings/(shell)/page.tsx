import { ProfileClient } from "@/components/settings-shell/profile-client";
import { getSession } from "@/lib/auth/session";

export default async function SettingsProfilePage() {
  const session = await getSession();

  return (
    <ProfileClient
      username={session?.username ?? ""}
      name=""
      email=""
      isAdmin={session?.isAdmin ?? false}
    />
  );
}
