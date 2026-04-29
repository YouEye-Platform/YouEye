/**
 * Unified Apps API — /api/v1/apps/unified
 *
 * Merges user drawer data (local DB) with CP bridge data (versions,
 * updates, system components). Regular users see their installed apps.
 * Admins also see system/infrastructure components and update status.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getUserAppsWithConfig } from "@/lib/db/queries/apps";

const CP_URL =
  process.env.CP_INTERNAL_URL || "http://youeye-control.youeye:3000";

interface BridgeApp {
  id: string;
  displayName: string;
  description: string;
  icon: string;
  category: "system" | "infrastructure" | "user";
  type: string;
  containers: Array<{ name: string; status: string; ip?: string }>;
  version?: string;
  status: string;
  updateAvailable: boolean;
  updateInfo?: string;
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const host = request.headers.get("host") ?? "";
  const baseDomain = host.replace(/:\d+$/, "");

  // Get user drawer apps from local DB
  const drawerData = await getUserAppsWithConfig(session.userId);
  const drawerApps = drawerData.apps.map((a) => {
    const subdomain = a.subdomain;
    const url = subdomain
      ? `https://${subdomain}.${baseDomain}`
      : a.containerUrl ?? `/app/${a.id}`;
    return {
      id: a.id,
      name: a.customName ?? a.name,
      originalName: a.name,
      icon: a.icon,
      customIconUrl: a.customIconUrl,
      subdomain: a.subdomain,
      status: a.status ?? "unknown",
      url,
      // These get enriched from bridge data below
      version: null as string | null,
      updateAvailable: false,
      updateInfo: null as string | null,
      category: "user" as string,
      type: "lxd" as string,
      description: "" as string,
    };
  });

  // For admins, also fetch system data from CP bridge
  let systemApps: Array<{
    id: string;
    name: string;
    icon: string;
    status: string;
    version: string | null;
    updateAvailable: boolean;
    updateInfo: string | null;
    category: string;
    type: string;
    description: string;
    subdomain: string | null;
    url: string | null;
  }> = [];

  let bridgeApps: BridgeApp[] = [];

  if (session.isAdmin) {
    try {
      const res = await fetch(`${CP_URL}/api/ui-bridge/apps`, {
        cache: "no-store",
        headers: { Referer: `${CP_URL}/embed/unified` },
      });
      if (res.ok) {
        const data = await res.json();
        bridgeApps = data.apps ?? [];
      }
    } catch {
      // CP unreachable — continue with drawer data only
    }

    // Enrich drawer apps with bridge data (versions, updates)
    for (const app of drawerApps) {
      const bridgeMatch = bridgeApps.find((b) => b.id === app.id);
      if (bridgeMatch) {
        app.status = bridgeMatch.status;
        app.version = bridgeMatch.version ?? null;
        app.updateAvailable = bridgeMatch.updateAvailable;
        app.updateInfo = bridgeMatch.updateInfo ?? null;
        app.category = bridgeMatch.category;
        app.type = bridgeMatch.type;
        app.description = bridgeMatch.description;
      }
    }

    // System and infrastructure apps (not in drawer)
    const drawerIds = new Set(drawerApps.map((a) => a.id));
    for (const ba of bridgeApps) {
      if (drawerIds.has(ba.id)) continue;
      systemApps.push({
        id: ba.id,
        name: ba.displayName,
        icon: ba.icon,
        status: ba.status,
        version: ba.version ?? null,
        updateAvailable: ba.updateAvailable,
        updateInfo: ba.updateInfo ?? null,
        category: ba.category,
        type: ba.type,
        description: ba.description,
        subdomain: null,
        url: null,
      });
    }
  }

  // Categorize: updates available, native (user), system/infrastructure
  const updatesAvailable = [
    ...drawerApps.filter((a) => a.updateAvailable),
    ...systemApps.filter((a) => a.updateAvailable),
  ];

  return NextResponse.json({
    apps: drawerApps,
    systemApps,
    updatesAvailable: updatesAvailable.map((a) => ({
      id: a.id,
      name: a.name,
      version: a.version,
      updateInfo: a.updateInfo,
      category: a.category,
    })),
    isAdmin: session.isAdmin,
  });
}
