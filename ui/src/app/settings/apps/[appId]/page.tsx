import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { AppSettingsDetail } from "@/components/settings/app-settings-detail";

export default async function AppSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ appId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { appId } = await params;
  const { tab } = await searchParams;
  const directAccessEmbedUrl = getSignedEmbedUrl(`app-network/${appId}`, "", true);

  return (
    <AppSettingsDetail
      appId={appId}
      directAccessEmbedUrl={directAccessEmbedUrl}
      isAdmin={session.isAdmin}
      initialTab={tab}
    />
  );
}
