import { redirect } from "next/navigation";
import { ProxyEmbedClient } from "@/app/embed/proxy/client";
import { PageHeader } from "@/components/settings-shell/page-header";
import { getSession } from "@/lib/auth/session";

export default async function ProxySettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  return (
    <>
      <PageHeader title="Proxy" description="Manage Caddy routes." />
      <ProxyEmbedClient />
    </>
  );
}
