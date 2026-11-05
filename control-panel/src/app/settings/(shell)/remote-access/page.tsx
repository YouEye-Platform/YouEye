import { redirect } from "next/navigation";
export default async function RemoteAccessSettingsPage() {
  redirect("/settings/system/ssh");
}
