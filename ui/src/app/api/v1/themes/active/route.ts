/**
 * Active Theme API
 *
 * GET /api/themes/active — Get the current user's active theme with CSS variables
 * PUT /api/themes/active — Set the current user's active theme or mode
 *
 * Authentication:
 * - Session cookie for browser requests
 * - X-YouEye-App + X-YouEye-User for service-to-service
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveServiceAuth } from "@/lib/auth/service";
import {
  getUserActiveTheme,
  setUserActiveTheme,
  getDefaultTheme,
} from "@/lib/db/queries/themes";
import { getUserSettings } from "@/lib/db/queries/settings";
import { generateCSSVariables } from "@/lib/themes/css-generator";
import { db, ensureSchema } from "@/db";
import { userSettings } from "@/db/schema";
import { eq } from "drizzle-orm";

async function resolveUserId(request: NextRequest): Promise<string | null> {
  const session = await getSession();
  if (session) return session.userId;

  const serviceUser = await resolveServiceAuth(request);
  if (serviceUser) return serviceUser.id;

  return null;
}

export async function GET(request: NextRequest) {
  const userId = await resolveUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [active, userSettingsData] = await Promise.all([
      getUserActiveTheme(userId),
      getUserSettings(userId),
    ]);
    const mode = (userSettingsData.themeMode as string) ?? "system";

    if (active) {
      return NextResponse.json({
        id: active.theme.id,
        name: active.theme.name,
        colors: active.theme.colors,
        isPreset: active.theme.isPreset,
        cssVariables: generateCSSVariables(active.theme.colors),
        mode,
      });
    }

    // No preference set — return the default theme (Zinc)
    const defaultTheme = await getDefaultTheme();
    if (defaultTheme) {
      return NextResponse.json({
        id: defaultTheme.id,
        name: defaultTheme.name,
        colors: defaultTheme.colors,
        isPreset: defaultTheme.isPreset,
        cssVariables: generateCSSVariables(defaultTheme.colors),
        mode,
      });
    }

    return NextResponse.json(
      { error: "No themes available" },
      { status: 404 }
    );
  } catch (error) {
    console.error("[themes] Failed to get active theme:", error);
    return NextResponse.json(
      { error: "Failed to get active theme" },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  const userId = await resolveUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    // Handle mode-only update (from native apps syncing theme toggle)
    if (body.mode && !body.themeId) {
      const mode = body.mode;
      if (!["dark", "light", "system"].includes(mode)) {
        return NextResponse.json(
          { error: "Invalid mode — must be dark, light, or system" },
          { status: 400 }
        );
      }

      // Save mode to user settings
      await ensureSchema();
      const existing = await getUserSettings(userId);
      const merged = { ...existing, themeMode: mode };

      const rows = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);

      if (rows.length === 0) {
        await db.insert(userSettings).values({
          userId,
          settings: merged,
        });
      } else {
        await db
          .update(userSettings)
          .set({ settings: merged, updatedAt: new Date() })
          .where(eq(userSettings.userId, userId));
      }

      return NextResponse.json({ ok: true, mode });
    }

    // Handle themeId update (existing behavior)
    const { themeId } = body as { themeId: string };

    if (!themeId) {
      return NextResponse.json(
        { error: "themeId or mode is required" },
        { status: 400 }
      );
    }

    const pref = await setUserActiveTheme(userId, themeId);
    if (!pref) {
      return NextResponse.json(
        { error: "Theme not found" },
        { status: 404 }
      );
    }

    // Re-fetch the full theme for CSS generation
    const active = await getUserActiveTheme(userId);
    if (!active) {
      return NextResponse.json(
        { error: "Failed to load theme" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      id: active.theme.id,
      name: active.theme.name,
      colors: active.theme.colors,
      isPreset: active.theme.isPreset,
      cssVariables: generateCSSVariables(active.theme.colors),
    });
  } catch (error) {
    console.error("[themes] Failed to set active theme:", error);
    return NextResponse.json(
      { error: "Failed to set active theme" },
      { status: 500 }
    );
  }
}
