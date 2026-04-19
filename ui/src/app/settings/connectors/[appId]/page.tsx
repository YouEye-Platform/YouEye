import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { ConnectorDetail } from "@/components/settings/connector-detail";

export default async function AppConnectorSettingsPage({
  params,
}: {
  params: Promise<{ appId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { appId } = await params;

  return <ConnectorDetail appId={appId} />;
}
