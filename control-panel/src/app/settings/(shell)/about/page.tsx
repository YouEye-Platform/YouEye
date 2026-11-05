import { redirect } from "next/navigation";
import { AboutClient } from "@/components/settings-shell/about-client";
import { getSession } from "@/lib/auth/session";
import pkg from "../../../../../package.json";

export default async function AboutSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  // The running Control Panel ("Server interface") version is injected at build
  // time — it is not exposed by /api/health/services. Same pattern as System.
  return <AboutClient cpVersion={pkg.version} />;
}
