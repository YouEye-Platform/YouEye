import { redirect } from "next/navigation";

export default async function ContainersSettingsPage() {
  redirect("/settings/system");
}
