/**
 * App Gateway — Platform Info
 *
 * GET /api/apps/v1/platform
 *
 * Returns platform metadata to authenticated apps.
 * Apps authenticate with Bearer token (validated by hash lookup).
 * This endpoint replaces the old CP-hosted equivalent —
 * apps now talk to YE-UI, never to CP.
 */

import { NextResponse } from "next/server";
import { validateAppToken } from "@/lib/auth/app-token";
import { db, ensureSchema } from "@/db";
import { systemSettings } from "@/db/schema";
import { eq } from "drizzle-orm";

async function getSystemSetting(key: string): Promise<unknown | null> {
  const [row] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, key));
  return row?.value ?? null;
}

export async function GET(request: Request) {
  const identity = await validateAppToken(request);
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  await ensureSchema();

  const externalUrl = process.env.UI_EXTERNAL_URL || "https://localhost";
  const domain = externalUrl.replace(/^https?:\/\//, "");

  let version = "0.0.0";
  try {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const pkgPath = join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    version = pkg.version || version;
  } catch {}


  const [siteName, language] = await Promise.all([
    getSystemSetting("site_name"),
    getSystemSetting("language"),
  ]);

  let timezone = "UTC";
  try {
    const { readFileSync } = await import("fs");
    timezone = readFileSync("/etc/timezone", "utf-8").trim() || "UTC";
  } catch {}

  return NextResponse.json({
    version,
    domain,
    locale: (language as string) ?? "en",
    timezone,
    site_name: (siteName as string) ?? "YouEye",
    container_domain: "youeye",
  });
}
