import { redirect } from "next/navigation";

export default async function ConnectorAppRedirect({
  params,
}: {
  params: Promise<{ appId: string }>;
}) {
  const { appId } = await params;
  redirect(`/settings/apps/${appId}`);
}
