import { PageHeader } from "@/components/settings-shell/page-header";
import { ProfileIdentityClient } from "@/components/settings-shell/profile-identity-client";
import { ProfileLocalClient } from "@/components/settings-shell/profile-local-client";
import { getSession } from "@/lib/auth/session";

export default async function SettingsProfilePage() {
  const session = await getSession();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Profile"
        description="Manage your account name and avatar."
      />
      <ProfileIdentityClient
        username={session?.username ?? ""}
        isAdmin={session?.isAdmin ?? false}
      />
      <ProfileLocalClient />
    </div>
  );
}
