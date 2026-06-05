import { redirect } from "next/navigation";
import HealthPage from "@/app/(dashboard)/health/page";
import { PageHeader } from "@/components/settings-shell/page-header";
import { getSession } from "@/lib/auth/session";

export default async function SystemSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  return (
    <>
      <PageHeader title="System" description="Review server health and platform status." />
      <HealthPage />
    </>
  );
}
