import { ProfileClient } from "@/components/settings-shell/profile-client";
import { getSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";

export default async function SettingsProfilePage() {
  const session = await getSession();
  if (session?.authMethod === "pam" || session?.authMethod === "cli") {
    redirect("/settings/system");
  }

  return (
    <ProfileClient
      username={session?.username ?? ""}
      name=""
      email=""
      isAdmin={session?.isAdmin ?? false}
    />
  );
}
