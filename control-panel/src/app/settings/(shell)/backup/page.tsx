import { redirect } from "next/navigation";

export default async function BackupSettingsPage() {
  redirect("/settings/system");
}
