import { redirect } from "next/navigation";

export default async function AppSettingsRedirect({
  params,
}: {
  params: Promise<{ appId: string }>;
}) {
  const { appId } = await params;
  redirect(`/settings/connectors/${appId}`);
}
