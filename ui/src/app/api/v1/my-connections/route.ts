/**
 * App Connections Discovery — GET /api/v1/my-connections
 *
 * Called by native apps (via Canvas getConnections()) to discover their
 * active bridges, internet access, and available backends.
 *
 * Auth: Authorization: Bearer <YOUEYE_APP_TOKEN> must match X-YouEye-App.
 * Requires an active acting user, app admission and that user's connection grants.
 *
 * Data source: `apps.connections` JSONB column, pushed by the Control Panel via
 * POST /api/ui-bridge/app-connections whenever bridge state changes.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema } from "@/db";
import { apps } from "@/db/schema";
import { eq } from "drizzle-orm";
import { validateAppToken } from "@/lib/auth/app-token";
import { resolveServiceAuth } from "@/lib/auth/service";
import { checkPermission } from "@/lib/db/queries/permissions";
import { evaluateUiUserAdmission } from '@/lib/admission/store';

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const rawAppId = request.headers.get("x-youeye-app");
  if (!rawAppId) {
    return NextResponse.json(
      { error: "Missing X-YouEye-App header" },
      { status: 401 },
    );
  }

  // Service identity uses the exact canonical installed ID.
  const appId = rawAppId;

  const tokenResult = await validateAppToken(request);
  if (!tokenResult) {
    return NextResponse.json(
      { error: "Invalid or missing app token" },
      { status: 401 },
    );
  }

  const tokenAppId = tokenResult.appId;
  if (tokenAppId !== appId && tokenResult.appId !== rawAppId) {
    return NextResponse.json(
      { error: "App token does not match X-YouEye-App" },
      { status: 403 },
    );
  }

  try {
    await ensureSchema();
    const serviceUser = await resolveServiceAuth(request);
    if (!serviceUser) return NextResponse.json({ error: 'active_app_user_required' }, { status: 403 });

    // Look up the app and its connections data
    let rows = await db
      .select({ id: apps.id, connections: apps.connections })
      .from(apps)
      .where(eq(apps.id, appId))
      .limit(1);

    // Try raw ID if stripped didn't match
    if (rows.length === 0 && appId !== rawAppId) {
      rows = await db
        .select({ id: apps.id, connections: apps.connections })
        .from(apps)
        .where(eq(apps.id, rawAppId))
        .limit(1);
    }

    if (rows.length === 0) {
      return NextResponse.json(
        { error: `App "${rawAppId}" not registered` },
        { status: 403 },
      );
    }

    const connData = rows[0].connections as Record<string, unknown> | null;
    const available = ((connData?.available as unknown[]) ?? []) as Array<Record<string, unknown>>;
    const globalBridges = ((connData?.bridges as unknown[]) ?? []) as Array<Record<string, unknown>>;
    const grantedCandidates: Array<Record<string, unknown>> = [];

    if (serviceUser) {
      for (const candidate of available) {
        const targetAppId = typeof candidate.appId === "string" ? candidate.appId : "";
        if (!targetAppId || candidate.installed !== true) continue;
        if (!(await evaluateUiUserAdmission(targetAppId.replace(/^app-/, '').replace(/^ye-/, ''), serviceUser.id)).allowed) continue;
        const permission = `connection:${targetAppId.replace(/^app-/, "").replace(/^ye-/, "")}`;
        const granted = await checkPermission(serviceUser.id, appId, permission);
        if (!granted) continue;
        grantedCandidates.push({
          ...candidate,
          direction: candidate.direction ?? "one-way",
          active: true,
        });
      }
    }

    const byTarget = new Map<string, Record<string, unknown>>();
    if (serviceUser) {
      for (const bridge of globalBridges) {
        const target = typeof bridge.appId === "string" ? bridge.appId : "";
        if (!target || bridge.active === false) continue;
        if (!(await evaluateUiUserAdmission(target.replace(/^app-/, '').replace(/^ye-/, ''), serviceUser.id)).allowed) continue;
        const permission = `connection:${target.replace(/^app-/, "").replace(/^ye-/, "")}`;
        const granted = await checkPermission(serviceUser.id, appId, permission);
        if (granted) byTarget.set(target, bridge);
      }
      for (const candidate of grantedCandidates) {
        const target = typeof candidate.appId === "string" ? candidate.appId : "";
        if (target) byTarget.set(target, candidate);
      }
    }

    // Return the ConnectionStatus shape Canvas expects
    return NextResponse.json({
      bridges: [...byTarget.values()],
      internet: (connData?.internet as Record<string, unknown>) ?? {
        granted: false,
        hosts: [],
        blanket: false,
      },
      available: grantedCandidates,
    });
  } catch (err) {
    console.error("[my-connections] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
