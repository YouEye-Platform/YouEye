import AppsPage from "@/app/(dashboard)/apps/page";
import { PageHeader } from "@/components/settings-shell/page-header";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

export default async function AppManagementSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  return (
    <div className="space-y-6">
      <PageHeader title="App Management" description="Manage installed YouEye apps." />
      <AppsPage />
    </div>
  );
}
