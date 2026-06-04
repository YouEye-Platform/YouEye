import { redirect } from "next/navigation";
import { DnsEmbedClient } from "@/app/embed/dns/client";
import { PageHeader } from "@/components/settings-shell/page-header";
import { getSession } from "@/lib/auth/session";

export default async function DnsSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  return (
    <>
      <PageHeader title="DNS" description="Manage Pi-hole DNS settings." />
      <DnsEmbedClient />
    </>
  );
}
