import { redirect } from "next/navigation";
import { BackupEmbedClient } from "@/app/embed/backup/client";
import { PageHeader } from "@/components/settings-shell/page-header";
import { getSession } from "@/lib/auth/session";

export default async function BackupSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  return (
    <>
      <PageHeader title="Backup" description="Create and restore platform backups." />
      <BackupEmbedClient />
    </>
  );
}
