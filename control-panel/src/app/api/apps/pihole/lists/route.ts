import { NextRequest, NextResponse } from "next/server";
import { getSession, verifyCSRFToken } from "@/lib/auth";
import { piholeRequest } from "@/lib/apps/pihole-api";

// Pi-Hole adlists (blocklists). Session-authed sibling of the other apps/pihole/*
// routes (the ui-bridge/dns/lists twin is embed-referer-gated and not usable from
// the Settings surface). FTL `/api/lists` returns per-list `number` = domain count.
interface Adlist {
  address: string;
  comment: string;
  enabled: boolean;
  type: string; // "block" | "allow"
  number?: number;
  status?: number;
  id?: number;
}

async function requireAdminCsrf(request: NextRequest) {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!session.isAdmin) return { error: NextResponse.json({ error: "Admin access required" }, { status: 403 }) };
  const csrfToken = request.headers.get("X-CSRF-Token");
  if (!csrfToken || !(await verifyCSRFToken(csrfToken)))
    return { error: NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 }) };
  return { error: null };
}

// GET — list adlists (auth only, like stats/queries/domains GET)
export async function GET() {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const data = await piholeRequest<{ lists: Adlist[] }>("/api/lists");
    return NextResponse.json({ lists: data.lists || [] });
  } catch (error) {
    console.error("Error getting Pi-Hole blocklists:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get blocklists" },
      { status: 500 },
    );
  }
}

// POST — add adlist (admin + CSRF)
export async function POST(request: NextRequest) {
  try {
    const guard = await requireAdminCsrf(request);
    if (guard.error) return guard.error;
    const { address, comment, type } = await request.json();
    if (!address || typeof address !== "string")
      return NextResponse.json({ error: "Address is required" }, { status: 400 });
    const listType = type === "allow" ? "allow" : "block";
    await piholeRequest(`/api/lists?type=${listType}`, {
      method: "POST",
      body: JSON.stringify({ address, comment: comment || "", enabled: true, groups: [0] }),
    });
    return NextResponse.json({ success: true, message: "Blocklist added" });
  } catch (error) {
    console.error("Error adding Pi-Hole blocklist:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to add blocklist" },
      { status: 500 },
    );
  }
}

// PATCH — toggle a list enabled/disabled (admin + CSRF). FTL PUT replaces the item.
export async function PATCH(request: NextRequest) {
  try {
    const guard = await requireAdminCsrf(request);
    if (guard.error) return guard.error;
    const { address, enabled, comment, type } = await request.json();
    if (!address || typeof address !== "string")
      return NextResponse.json({ error: "Address is required" }, { status: 400 });
    if (typeof enabled !== "boolean")
      return NextResponse.json({ error: "enabled (boolean) is required" }, { status: 400 });
    const listType = type === "allow" ? "allow" : "block";
    await piholeRequest(`/api/lists/${encodeURIComponent(address)}?type=${listType}`, {
      method: "PUT",
      body: JSON.stringify({ comment: comment || "", enabled, type: listType, groups: [0] }),
    });
    return NextResponse.json({ success: true, message: enabled ? "Blocklist enabled" : "Blocklist disabled" });
  } catch (error) {
    console.error("Error toggling Pi-Hole blocklist:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update blocklist" },
      { status: 500 },
    );
  }
}

// DELETE — remove adlist (admin + CSRF)
export async function DELETE(request: NextRequest) {
  try {
    const guard = await requireAdminCsrf(request);
    if (guard.error) return guard.error;
    const { address, type } = await request.json();
    if (!address || typeof address !== "string")
      return NextResponse.json({ error: "Address is required" }, { status: 400 });
    const listType = type === "allow" ? "allow" : "block";
    await piholeRequest(`/api/lists/${encodeURIComponent(address)}?type=${listType}`, { method: "DELETE" });
    return NextResponse.json({ success: true, message: "Blocklist removed" });
  } catch (error) {
    console.error("Error removing Pi-Hole blocklist:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to remove blocklist" },
      { status: 500 },
    );
  }
}
