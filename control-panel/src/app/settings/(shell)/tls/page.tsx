import { redirect } from "next/navigation";

export default async function TlsSettingsPage() {
  redirect("/settings/network");
}
