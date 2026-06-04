import { redirect } from "next/navigation";
import { TlsEmbedClient } from "@/app/embed/tls/client";
import { PageHeader } from "@/components/settings-shell/page-header";
import { getSession } from "@/lib/auth/session";

export default async function TlsSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  return (
    <>
      <PageHeader title="TLS" description="Review certificate status and HTTPS configuration." />
      <TlsEmbedClient />
    </>
  );
}
