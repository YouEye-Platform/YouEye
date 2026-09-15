import { redirect } from "next/navigation";
import { BackupClient } from "@/components/settings-shell/backup-client";
import { getSession } from "@/lib/auth/session";

export default async function BackupSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");
  return <BackupClient />;
}
