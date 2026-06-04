import { redirect } from "next/navigation";
import { ContainersEmbedClient } from "@/app/embed/containers/client";
import { PageHeader } from "@/components/settings-shell/page-header";
import { getSession } from "@/lib/auth/session";

export default async function ContainersSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  return (
    <>
      <PageHeader title="Containers" description="Inspect and control YouEye containers." />
      <ContainersEmbedClient />
    </>
  );
}
