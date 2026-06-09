import type { NextRequest } from "next/server";
import { describePermission } from "./descriptors";

export function normalizePermissionAppId(appId: string): string {
  return appId.replace(/^ye-/, "");
}

export function permissionAppMatches(left: string, right: string): boolean {
  return normalizePermissionAppId(left) === normalizePermissionAppId(right);
}

export function publicBaseUrl(request?: Request | NextRequest): string {
  if (process.env.UI_EXTERNAL_URL) return process.env.UI_EXTERNAL_URL.replace(/\/$/, "");

  const headers = request?.headers;
  const host = headers?.get("x-forwarded-host") || headers?.get("host");
  if (!host) return "";
  const proto = headers?.get("x-forwarded-proto") || "https";
  return `${proto}://${host}`;
}

export function buildPermissionApproval(
  appId: string,
  permissions: string[],
  grantType?: unknown,
  request?: Request | NextRequest
) {
  const params = new URLSearchParams();
  params.set("app_id", appId);
  for (const permission of permissions) params.append("permission", permission);
  if (typeof grantType === "string" && grantType.length > 0) params.set("grant_type", grantType);

  const approvalPath = `/permissions/approve?${params.toString()}`;
  const base = publicBaseUrl(request);

  return {
    success: false,
    approval_required: true,
    app_id: appId,
    requested: permissions,
    permissions: permissions.map((permission) => describePermission(permission)),
    approval_url: approvalPath,
    approval_url_absolute: base ? `${base}${approvalPath}` : approvalPath,
  };
}
