import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { HealthClient } from "@/components/settings-shell/health-client";

export default async function SystemHealthPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");
  return <HealthClient />;
}
