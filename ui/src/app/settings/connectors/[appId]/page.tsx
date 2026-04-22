import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { ConnectorDetail } from "@/components/settings/connector-detail";

export default async function AppConnectorSettingsPage({
  params,
}: {
  params: Promise<{ appId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { appId } = await params;
  const directAccessEmbedUrl = getSignedEmbedUrl(`app-network/${appId}`, "", true);

  return <ConnectorDetail appId={appId} directAccessEmbedUrl={directAccessEmbedUrl} />;
}
