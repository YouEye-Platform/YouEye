import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { AppSettingsDetail } from "@/components/settings/app-settings-detail";

export default async function AppSettingsPage({
  params,
}: {
  params: Promise<{ appId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { appId } = await params;
  const directAccessEmbedUrl = getSignedEmbedUrl(`app-network/${appId}`, "", true);

  return (
    <AppSettingsDetail
      appId={appId}
      directAccessEmbedUrl={directAccessEmbedUrl}
      isAdmin={session.isAdmin}
    />
  );
}
