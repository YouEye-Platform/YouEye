import { redirect } from "next/navigation";
import { MarketEmbedClient } from "@/app/embed/market/client";
import { PageHeader } from "@/components/settings-shell/page-header";
import { getSession } from "@/lib/auth/session";

export default async function MarketSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  return (
    <>
      <PageHeader title="App Market" description="Browse and install YouEye apps." />
      <MarketEmbedClient />
    </>
  );
}
