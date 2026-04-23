/**
 * Header Config API
 *
 * GET /api/header/config — Returns full header configuration
 * Used by native apps and YE-UI itself for consistent header rendering.
 * Includes branding, navigation, user info, notifications, and theme.
 *
 * Authentication:
 * - Session cookie (ye-ui-session) for browser requests
 * - X-YouEye-App + X-YouEye-User headers for service-to-service (Incus internal)
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getBranding } from "@/lib/db/queries/branding";
import { getUnreadCount } from "@/lib/db/queries/notifications";
import { getUserAppsWithConfig } from "@/lib/db/queries/apps";
import { getUserActiveTheme, getDefaultTheme } from "@/lib/db/queries/themes";
import { generateCompactCSS } from "@/lib/themes/css-generator";
import { getUserSettings, getDrawerPrefs } from "@/lib/db/queries/settings";
import { resolveServiceAuth } from "@/lib/auth/service";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET(request: NextRequest) {
  // Try session auth first, fall back to service-to-service headers
  let userId: string | null = null;
  let username = "";
  let name = "";
  let email = "";
  let isAdmin = false;

  const session = await getSession();
  if (session) {
    userId = session.userId;
    username = session.username;
    name = session.name ?? session.username;
    email = session.email;
    isAdmin = session.isAdmin;
  } else {
    // Try service-to-service auth
    const serviceUser = await resolveServiceAuth(request);
    if (serviceUser) {
      userId = serviceUser.id;
      username = serviceUser.username;
      name = serviceUser.name;
      email = serviceUser.email;
      isAdmin = serviceUser.isAdmin;
    }
  }

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [branding, unreadCount, appsData, activeThemeData, userSettingsData, userImageRow, drawerPrefs] =
    await Promise.all([
      getBranding(),
      getUnreadCount(userId),
      getUserAppsWithConfig(userId),
      getUserActiveTheme(userId),
      getUserSettings(userId),
      db.select({ image: users.image }).from(users).where(eq(users.id, userId)).limit(1),
      getDrawerPrefs(userId),
    ]);

  const sections = appsData.sections.map((s) => ({
    id: s.sectionId,
    name: s.name,
    order: s.displayOrder,
  }));

  // Derive base domain for subdomain app URLs.
  // Service-to-service calls arrive on the internal Incus hostname (e.g. youeye-ui.youeye:3000),
  // so use the configured external URL instead when the request comes from a native app.
  const uiExternalUrl = process.env.UI_EXTERNAL_URL || process.env.BASE_URL || process.env.NEXTAUTH_URL || "";
  const isServiceCall = !!request.headers.get("x-youeye-app");
  let baseDomain: string;
  if (isServiceCall && uiExternalUrl) {
    try {
      baseDomain = new URL(uiExternalUrl).hostname;
    } catch {
      baseDomain = (request.headers.get("host") ?? "").replace(/:\d+$/, "");
    }
  } else {
    baseDomain = (request.headers.get("host") ?? "").replace(/:\d+$/, "");
  }

  const apps = appsData.apps.map((a) => {
    let url: string | null;
    if (a.subdomain) {
      const baseUrl = `https://${a.subdomain}.${baseDomain}`;
      url = a.ssoEntryUrl ? `${baseUrl}${a.ssoEntryUrl}` : baseUrl;
    } else {
      url = a.containerUrl;
    }
    return {
      id: a.id,
      name: a.name,
      custom_name: a.customName,
      icon: a.icon,
      custom_icon_url: a.customIconUrl,
      url,
      order: a.displayOrder,
      section: a.sectionId,
      status: a.status,
      visible: a.visible,
    };
  });

  // Resolve theme — use user's active or default
  let themeResponse: {
    id?: string;
    name?: string;
    cssVariables?: string;
    mode: string;
  } = { mode: "system" };

  // Get mode from user settings
  const themeMode =
    (userSettingsData.themeMode as string) ?? "system";

  if (activeThemeData) {
    themeResponse = {
      id: activeThemeData.theme.id,
      name: activeThemeData.theme.name,
      cssVariables: generateCompactCSS(activeThemeData.theme.colors),
      mode: themeMode,
    };
  } else {
    const defaultTheme = await getDefaultTheme();
    if (defaultTheme) {
      themeResponse = {
        id: defaultTheme.id,
        name: defaultTheme.name,
        cssVariables: generateCompactCSS(defaultTheme.colors),
        mode: themeMode,
      };
    } else {
      themeResponse = { mode: themeMode };
    }
  }

  // Derive UI base URL from environment
  const uiBaseUrl = process.env.UI_EXTERNAL_URL || process.env.BASE_URL || process.env.NEXTAUTH_URL || "";

  return NextResponse.json({
    branding: {
      site_name: branding.site_name,
      site_name_style: branding.site_name_style,
      logo_url: branding.logo_url,
      favicon_url: branding.favicon_url,
      accent_color: branding.accent_color,
    },
    navigation: {
      home_url: "/",
      apps,
      sections,
    },
    user: {
      id: userId,
      name,
      username,
      email,
      is_admin: isAdmin,
      avatar_url: userImageRow[0]?.image
        ? `${uiBaseUrl}${userImageRow[0].image}`
        : null,
    },
    notifications: {
      unread_count: unreadCount,
      endpoint: "/api/v1/notifications",
    },
    settings_url: "/settings",
    ui_base_url: uiBaseUrl,
    theme: themeResponse,
    user_menu: {
      platform_items: [
        { key: "dashboard", label: "Dashboard", icon: "LayoutDashboard", url: uiBaseUrl || "/" },
        { key: "timeline", label: "Timeline", icon: "Clock", url: `${uiBaseUrl}/timeline` },
        { key: "notifications", label: "Notifications", icon: "Bell", url: `${uiBaseUrl}/notifications` },
        { key: "settings", label: "Settings", icon: "Settings", url: `${uiBaseUrl}/settings` },
      ],
      logout_url: "/api/auth/logout",
    },
    drawer_prefs: drawerPrefs,
  });
}
