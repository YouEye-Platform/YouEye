import { redirect } from "next/navigation";
import { PageHeader } from "@/components/settings-shell/page-header";
import { TlsCard } from "@/components/settings/tls-card";
import { getSession } from "@/lib/auth/session";

export default async function TlsSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  return (
    <>
      <PageHeader title="TLS" description="Review certificate status and HTTPS configuration." />
      <TlsCard />
    </>
  );
}
