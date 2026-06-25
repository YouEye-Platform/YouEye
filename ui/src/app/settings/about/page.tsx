/**
 * About & Telemetry Settings Page
 *
 * Shows platform version info and provides usage report download.
 * Available to admins only (system-level data).
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { TelemetryExport } from "@/components/settings/telemetry-export";

export default async function AboutSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">About & Usage</h2>
        <p className="text-muted-foreground mt-1">
          Platform info and anonymous usage data for beta testing.
        </p>
      </div>

      <TelemetryExport />
    </div>
  );
}
