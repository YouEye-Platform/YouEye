import { redirect } from "next/navigation";
import { AppsEmbedClient } from "@/app/embed/apps/client";
import { PageHeader } from "@/components/settings-shell/page-header";
import { getSession } from "@/lib/auth/session";

export default async function AppManagementSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  return (
    <>
      <PageHeader title="App Management" description="Manage installed YouEye apps." />
      <AppsEmbedClient />
    </>
  );
}
