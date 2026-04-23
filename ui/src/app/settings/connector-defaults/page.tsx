import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { ConnectorDefaultsAdmin } from "@/components/settings/connector-defaults-admin";

export default async function ConnectorDefaultsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  return <ConnectorDefaultsAdmin />;
}
