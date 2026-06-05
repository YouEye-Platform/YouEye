import { redirect } from "next/navigation";

export default async function AppManagementSettingsPage() {
  redirect("/settings/app-management");
}
