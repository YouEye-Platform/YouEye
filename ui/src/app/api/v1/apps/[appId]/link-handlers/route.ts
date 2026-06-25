/**
 * Link Handlers API — /api/v1/apps/[appId]/link-handlers
 *
 * GET — List link handlers for an app
 * POST — Add a link handler (admin only)
 * DELETE — Remove a link handler by type (admin only)
 *
 * Link handlers are stored in apps.manifest.linkHandlers (JSONB).
 * They define URL patterns/domains that an app can handle, allowing
 * the platform to route matching links to the appropriate app.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getApp, updateAppManifest } from "@/lib/db/queries/app-management";

interface LinkHandler {
  type: string;
  description: string;
  endpoint: string;
  triggers: string[];
}

function getLinkHandlers(manifest: Record<string, unknown>): LinkHandler[] {
  const raw = manifest?.linkHandlers;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (h): h is LinkHandler =>
      typeof h === "object" &&
      h !== null &&
      typeof h.type === "string" &&
      typeof h.description === "string" &&
      typeof h.endpoint === "string" &&
      Array.isArray(h.triggers)
  );
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { appId } = await params;
  const app = await getApp(appId);
  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  const handlers = getLinkHandlers(app.manifest ?? {});
  return NextResponse.json({ handlers });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Admin required" }, { status: 403 });
  }

  const { appId } = await params;
  const app = await getApp(appId);
  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  const body = await request.json();
  const { type, description, endpoint, triggers } = body;

  if (!type || typeof type !== "string") {
    return NextResponse.json({ error: "type is required" }, { status: 400 });
  }
  if (!description || typeof description !== "string") {
    return NextResponse.json({ error: "description is required" }, { status: 400 });
  }
  if (!triggers || !Array.isArray(triggers) || triggers.length === 0) {
    return NextResponse.json(
      { error: "triggers must be a non-empty array of domain patterns" },
      { status: 400 }
    );
  }

  const manifest = (app.manifest ?? {}) as Record<string, unknown>;
  const handlers = getLinkHandlers(manifest);

  // Prevent duplicate types
  if (handlers.some((h) => h.type === type)) {
    return NextResponse.json(
      { error: `Handler type "${type}" already exists` },
      { status: 409 }
    );
  }

  const newHandler: LinkHandler = {
    type: type.trim().toLowerCase().replace(/\s+/g, "-"),
    description: description.trim(),
    endpoint: (endpoint || `/${type}`).trim(),
    triggers: triggers.map((t: string) => t.trim().toLowerCase()).filter(Boolean),
  };

  handlers.push(newHandler);
  await updateAppManifest(appId, { ...manifest, linkHandlers: handlers });

  return NextResponse.json({ handler: newHandler }, { status: 201 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Admin required" }, { status: 403 });
  }

  const { appId } = await params;
  const app = await getApp(appId);
  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");
  if (!type) {
    return NextResponse.json({ error: "type query param required" }, { status: 400 });
  }

  const manifest = (app.manifest ?? {}) as Record<string, unknown>;
  const handlers = getLinkHandlers(manifest);
  const filtered = handlers.filter((h) => h.type !== type);

  if (filtered.length === handlers.length) {
    return NextResponse.json({ error: "Handler not found" }, { status: 404 });
  }

  await updateAppManifest(appId, { ...manifest, linkHandlers: filtered });
  return NextResponse.json({ ok: true });
}
