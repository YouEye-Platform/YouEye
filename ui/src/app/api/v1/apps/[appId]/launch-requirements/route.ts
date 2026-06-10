/**
 * App Launch Requirements API
 *
 * GET — Resolve manifest-declared first-launch permission requirements.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveServiceAuth } from "@/lib/auth/service";
import { getApp } from "@/lib/db/queries/app-management";
import { getPermissionDecision } from "@/lib/db/queries/permissions";
import {
  buildPermissionApproval,
  normalizePermissionAppId,
  permissionAppMatches,
  publicBaseUrl,
} from "@/lib/permissions/approval";
import { describePermission } from "@/lib/permissions/descriptors";
import { normalizeAppSurfaces } from "@/lib/surfaces/normalize";
import { getUserSettings } from "@/lib/db/queries/settings";
import { collectInternetPermissions } from "@/lib/internet/scopes";

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function collectLaunchPermissions(manifest: Record<string, unknown> | null): string[] {
  const permissions = new Set<string>();
  for (const permission of stringArray(manifest?.permissions)) {
    permissions.add(permission);
  }
  for (const surface of normalizeAppSurfaces(manifest)) {
    for (const permission of surface.permissions) {
      permissions.add(permission);
    }
  }
  for (const permission of collectInternetPermissions(manifest)) {
    permissions.add(permission);
  }
  return [...permissions].sort();
}

function collectLaunchConnections(connections: Record<string, unknown> | null): string[] {
  const available = Array.isArray(connections?.available) ? connections.available : [];
  const permissions = new Set<string>();
  for (const item of available) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.installed !== true) continue;
    if (typeof record.appId !== "string" || record.appId.length === 0) continue;
    permissions.add(`connection:${record.appId.replace(/^app-/, "").replace(/^ye-/, "")}`);
  }
  return [...permissions].sort();
}

interface LaunchPreference {
  key: string;
  type: string;
  label: string;
  description?: string;
  required: boolean;
  default?: unknown;
  choices?: Array<{ value: string; label: string }>;
  source: "preferences" | "launchPreferences" | "settings.schema";
}

function preferenceArray(value: unknown, source: LaunchPreference["source"]): LaunchPreference[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .filter((item) => typeof item.key === "string" && item.key.length > 0)
    .map((item) => ({
      key: item.key as string,
      type: typeof item.type === "string" && item.type.length > 0 ? item.type : "string",
      label: typeof item.label === "string" && item.label.length > 0 ? item.label : item.key as string,
      description: typeof item.description === "string" ? item.description : undefined,
      required: item.required === true,
      default: item.default,
      choices: Array.isArray(item.choices)
        ? item.choices
            .filter((choice): choice is Record<string, unknown> => typeof choice === "object" && choice !== null)
            .filter((choice) => typeof choice.value === "string" && typeof choice.label === "string")
            .map((choice) => ({ value: choice.value as string, label: choice.label as string }))
        : undefined,
      source,
    }));
}

function collectLaunchPreferences(manifest: Record<string, unknown> | null): LaunchPreference[] {
  const settings = manifest?.settings;
  const settingsSchema = typeof settings === "object" && settings !== null
    ? (settings as Record<string, unknown>).schema
    : undefined;
  const preferences = [
    ...preferenceArray(manifest?.preferences, "preferences"),
    ...preferenceArray(manifest?.launchPreferences, "launchPreferences"),
    ...preferenceArray(settingsSchema, "settings.schema"),
  ];
  const byKey = new Map<string, LaunchPreference>();
  for (const preference of preferences) {
    if (!byKey.has(preference.key)) byKey.set(preference.key, preference);
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function hasPreferenceValue(settings: Record<string, unknown>, preference: LaunchPreference): boolean {
  const value = settings[preference.key];
  if (value === undefined || value === null) return preference.default !== undefined;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function buildPreferencesResponse(
  appId: string,
  manifestAppId: string,
  requiredPreferences: LaunchPreference[],
  missingPreferences: LaunchPreference[],
  request: NextRequest
) {
  const settingsPath = `/settings/apps/${encodeURIComponent(manifestAppId)}?tab=app-settings`;
  const settingsApiPath = `/api/v1/apps/${encodeURIComponent(manifestAppId)}/user-settings`;
  const base = publicBaseUrl(request);
  return {
    preferences_required: missingPreferences.length > 0,
    app_settings_url: settingsPath,
    app_settings_url_absolute: base ? `${base}${settingsPath}` : settingsPath,
    app_settings_api: settingsApiPath,
    app_settings_api_absolute: base ? `${base}${settingsApiPath}` : settingsApiPath,
    required_preferences: requiredPreferences,
    missing_preferences: missingPreferences,
    app_id: appId,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  const serviceUser = session ? null : await resolveServiceAuth(request);
  if (!session && !serviceUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { appId } = await params;
  const serviceAppId = request.headers.get("x-youeye-app");
  if (serviceUser && serviceAppId && !permissionAppMatches(appId, serviceAppId)) {
    return NextResponse.json(
      { error: "service app cannot inspect launch requirements for another app" },
      { status: 403 }
    );
  }

  const manifestAppId = normalizePermissionAppId(serviceUser && serviceAppId ? serviceAppId : appId);
  const grantAppId = serviceUser && serviceAppId ? serviceAppId : appId;
  const app = await getApp(manifestAppId);
  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  const manifest = (app.manifest as Record<string, unknown> | null) ?? null;
  const required = [
    ...collectLaunchPermissions(manifest),
    ...collectLaunchConnections((app.connections as Record<string, unknown> | null) ?? null),
  ].sort();
  const requiredPreferences = collectLaunchPreferences(manifest).filter((preference) => preference.required);
  const userId = (session?.userId ?? serviceUser?.id)!;
  const [checks, allUserSettings] = await Promise.all([
    Promise.all(
    required.map(async (permission) => ({
      permission,
      decision: await getPermissionDecision(userId, grantAppId, permission),
    }))
    ),
    getUserSettings(userId),
  ]);
  const appSettings = (allUserSettings[manifestAppId] as Record<string, unknown> | undefined) ?? {};
  const missing = checks.filter((check) => check.decision === null).map((check) => check.permission);
  const denied = checks.filter((check) => check.decision === false).map((check) => check.permission);
  const missingPreferences = requiredPreferences.filter((preference) => !hasPreferenceValue(appSettings, preference));

  if (missing.length > 0 || missingPreferences.length > 0) {
    const preferences = buildPreferencesResponse(
      grantAppId,
      manifestAppId,
      requiredPreferences,
      missingPreferences,
      request
    );
    const returnTo = request.nextUrl.searchParams.get("return_to");
    const approval = missing.length > 0
      ? buildPermissionApproval(grantAppId, missing, "persistent", request, returnTo)
      : { success: false, approval_required: false };
    return NextResponse.json(
      {
        first_launch_complete: false,
        app_id: grantAppId,
        manifest_app_id: app.id,
        required_permissions: required.map((permission) => describePermission(permission)),
        granted_permissions: checks
          .filter((check) => check.decision === true)
          .map((check) => describePermission(check.permission)),
        denied_permissions: denied.map((permission) => describePermission(permission)),
        ...preferences,
        ...approval,
      },
      { status: 202 }
    );
  }

  return NextResponse.json({
    success: true,
    first_launch_complete: true,
    app_id: grantAppId,
    manifest_app_id: app.id,
    required_permissions: required.map((permission) => describePermission(permission)),
    granted_permissions: checks
      .filter((check) => check.decision === true)
      .map((check) => describePermission(check.permission)),
    denied_permissions: denied.map((permission) => describePermission(permission)),
    missing_permissions: [],
    preferences_required: false,
    required_preferences: requiredPreferences,
    missing_preferences: [],
  });
}
