/**
 * Per-App Connectors & Bridges Settings Page
 *
 * Shows connector capability selections (all users)
 * and bridge management iframe (admin only).
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getApp } from "@/lib/db/queries/app-management";
import { BridgeEmbed } from "@/components/settings/bridge-embed";

export default async function AppConnectorSettings({
  params,
}: {
  params: Promise<{ appId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { appId } = await params;
  const app = await getApp(appId);
  if (!app) redirect("/settings/apps");

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold">{app.name}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Manage connections and data sources for this app.
        </p>
      </div>

      {session.isAdmin && (
        <div className="border-t pt-6">
          <h3 className="text-lg font-medium mb-4">
            Direct App Access
          </h3>
          <p className="text-sm text-muted-foreground mb-4">
            Allow this app to communicate directly with other installed apps.
          </p>
          <BridgeEmbed appId={appId} />
        </div>
      )}
    </div>
  );
}
