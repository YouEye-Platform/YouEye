import { redirect } from "next/navigation";
import { SystemEmbedClient } from "@/app/embed/system/client";
import { PageHeader } from "@/components/settings-shell/page-header";
import { getSession } from "@/lib/auth/session";

export default async function SystemSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  return (
    <>
      <PageHeader title="System" description="Review server health and platform status." />
      <SystemEmbedClient />
    </>
  );
}
