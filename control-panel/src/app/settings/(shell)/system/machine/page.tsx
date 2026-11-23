import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/auth/session";
import { ConsoleAccessCard } from "@/components/settings-shell/console-access-card";
import { HostNetworkCard } from "@/components/settings-shell/host-network-card";
import { PageHeader } from "@/components/settings-shell/page-header";

/** This machine: its own network adapter and who may sign in at its console (from the System page). */
export default async function SystemMachinePage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");
  const systemPages = await getTranslations("systemPages");
  return (
    <div className="space-y-8">
      <PageHeader title={systemPages("machine.title")} description={systemPages("machine.description")} />
      <HostNetworkCard />
      <ConsoleAccessCard />
    </div>
  );
}
