import { redirect } from "next/navigation";

export default async function DnsSettingsPage() {
  redirect("/settings/network?tab=dns");
}
