import { redirect } from "next/navigation";

export default async function AppSettingsDetailPage({
  params,
}: {
  params: Promise<{ appId: string }>;
}) {
  const { appId } = await params;
  redirect(`/settings/apps?app=${encodeURIComponent(appId)}`);
}
