import { redirect } from "next/navigation";

export default async function ProxySettingsPage() {
  redirect("/settings/network");
}
