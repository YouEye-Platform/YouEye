import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { CapabilityDetail } from "@/components/settings/capability-detail";

export default async function CapabilitySettingsPage({
  params,
}: {
  params: Promise<{ capability: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { capability } = await params;

  return <CapabilityDetail capability={decodeURIComponent(capability)} />;
}
