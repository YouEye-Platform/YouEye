/**
 * App Drawer API
 *
 * GET /api/apps/drawer — Get user's customized app drawer
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getUserAppsWithConfig } from "@/lib/db/queries/apps";

function buildAppUrl(
  subdomain: string | null,
  containerUrl: string | null,
  appId: string,
  host: string,
  ssoEntryUrl: string | null
): string {
  if (!subdomain) return containerUrl ?? `/app/${appId}`;
  // Derive protocol + base domain from the request host
  const baseDomain = host.replace(/:\d+$/, "");
  const baseUrl = `https://${subdomain}.${baseDomain}`;
  return ssoEntryUrl ? `${baseUrl}${ssoEntryUrl}` : baseUrl;
}

function hasSettingsPanel(manifest: Record<string, unknown> | null | undefined): boolean {
  if (!manifest) return false;
  const capabilities = manifest.capabilities as Record<string, unknown> | undefined;
  return capabilities?.settings_panel === true
    || manifest.settings_panel === true;
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const host = request.headers.get("host") ?? "";
  const data = await getUserAppsWithConfig(session.userId);

  return NextResponse.json({
    apps: data.apps.map((a) => ({
      id: a.id,
      name: a.customName ?? a.name,
      original_name: a.name,
      icon: a.icon,
      custom_icon_url: a.customIconUrl,
      // `pinned` is the new name for `visible`: whether the app shows in the
      // quick drawer. The launcher ignores it (shows all). Both sent for back-compat.
      visible: a.visible,
      pinned: a.visible,
      order: a.displayOrder,
      section_id: a.sectionId,
      folder_id: a.folderId,
      // Registered apps (have containerUrl) with "unknown" status are assumed running
      status: (a.status === "unknown" || !a.status) && a.containerUrl ? "running" : (a.status ?? "unknown"),
      version: a.version ?? null,
      subdomain: a.subdomain ?? null,
      containerUrl: a.containerUrl ?? null,
      hasSettingsPanel: hasSettingsPanel(a.manifest),
      url: buildAppUrl(a.subdomain, a.containerUrl, a.id, host, a.ssoEntryUrl),
    })),
    sections: data.sections.map((s) => ({
      id: s.sectionId,
      name: s.name,
      order: s.displayOrder,
      collapsed: s.collapsed,
    })),
    folders: data.folders.map((f) => ({
      id: f.folderId,
      name: f.name,
      order: f.displayOrder,
    })),
  });
}
