import { NextRequest, NextResponse } from "next/server";
import { getBridgeToken } from "@/lib/admin/bridge-client";
import { findUserByUsername, updateUserProfile } from "@/lib/db/queries/users";
import { getUserSettings } from "@/lib/db/queries/settings";
import { listThemes, createTheme, getUserActiveTheme, setUserActiveTheme, getDefaultTheme } from "@/lib/db/queries/themes";
import { generateCSSVariables } from "@/lib/themes/css-generator";
import { getUserAppsWithConfig, updateAppBranding, updateAppConfig, updateDrawerSections, updateUserAppBranding } from "@/lib/db/queries/apps";
import { getDrawerPrefs, saveDrawerPrefs, saveUserWordartOverride, getUserWordartOverride, deleteUserWordartOverride } from "@/lib/db/queries/settings";
import { getBranding } from "@/lib/db/queries/branding";
import { deleteNotification, getUnreadCount, getUserNotifications, markAllNotificationsRead, markNotificationRead } from "@/lib/db/queries/notifications";
import { getAppPermissions, revokePermission } from "@/lib/db/queries/permissions";
import { describePermission } from "@/lib/permissions/descriptors";
import { hasPIN, hasActivePINSession, createPIN, changePIN, endPINSession } from "@/lib/crypto/pin-session";
import { db, ensureSchema } from "@/db";
import { userSettings } from "@/db/schema";
import { eq } from "drizzle-orm";

const SUPPORTED_LOCALES = ["en", "ru", "es", "de", "fr"];

function validateToken(request: NextRequest): boolean {
  const provided = request.headers.get("X-UI-Bridge-Token");
  const expected = getBridgeToken();
  return !!provided && expected !== null && provided === expected;
}

async function getBridgeUser(request: NextRequest) {
  if (!validateToken(request)) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const username = request.headers.get("X-YouEye-Username");
  if (!username) return { error: NextResponse.json({ error: "Missing user" }, { status: 400 }) };
  const user = await findUserByUsername(username);
  if (!user) return { error: NextResponse.json({ error: "User not found" }, { status: 404 }) };
  const isAdmin = request.headers.get("X-YouEye-Is-Admin") === "true" || user.isAdmin;
  return { user, isAdmin };
}

async function setUserLanguage(userId: string, language: string | null) {
  if (language !== null && !SUPPORTED_LOCALES.includes(language)) {
    return NextResponse.json({ error: "Unsupported language" }, { status: 400 });
  }

  await ensureSchema();
  const existing = await getUserSettings(userId);
  const merged = { ...existing };
  if (language === null) delete merged.language;
  else merged.language = language;

  const rows = await db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1);
  if (rows.length === 0) {
    await db.insert(userSettings).values({ userId, settings: merged });
  } else {
    await db.update(userSettings).set({ settings: merged, updatedAt: new Date() }).where(eq(userSettings.userId, userId));
  }
  return NextResponse.json({ language, status: "saved" });
}

async function getActiveThemePayload(userId: string) {
  const [active, settings] = await Promise.all([getUserActiveTheme(userId), getUserSettings(userId)]);
  const mode = (settings.themeMode as string) ?? "system";
  const theme = active?.theme ?? await getDefaultTheme();
  if (!theme) return null;
  return {
    id: theme.id,
    name: theme.name,
    colors: theme.colors,
    isPreset: theme.isPreset,
    cssVariables: generateCSSVariables(theme.colors),
    mode,
  };
}

function getPublicHost(request: NextRequest): string {
  return request.headers.get("X-YouEye-Public-Host")
    || request.headers.get("x-forwarded-host")
    || request.headers.get("host")
    || "";
}

function getPublicProto(request: NextRequest): string {
  return request.headers.get("X-YouEye-Public-Proto")
    || request.headers.get("x-forwarded-proto")
    || "https";
}

function hasSettingsPanel(manifest: Record<string, unknown> | null | undefined): boolean {
  if (!manifest) return false;
  const capabilities = manifest.capabilities as Record<string, unknown> | undefined;
  return capabilities?.settings_panel === true
    || manifest.settings_panel === true
    || typeof manifest.settings === "object";
}

function buildAppUrl(
  subdomain: string | null,
  containerUrl: string | null,
  appId: string,
  host: string,
  ssoEntryUrl: string | null,
  proto = "https"
): string {
  if (!subdomain) return containerUrl ?? `/app/${appId}`;
  const baseDomain = host.replace(/:\d+$/, "");
  const baseUrl = `${proto}://${subdomain}.${baseDomain}`;
  return ssoEntryUrl ? `${baseUrl}${ssoEntryUrl}` : baseUrl;
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await getBridgeUser(request);
  if (auth.error) return auth.error;
  const { user } = auth;
  const path = (await context.params).path.join("/");

  if (path === "profile") {
    return NextResponse.json({
      userId: user.id,
      username: user.username,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      bio: user.bio,
      timezone: user.timezone,
      email: user.email,
      isAdmin: user.isAdmin,
      image: user.image,
    });
  }

  if (path === "header/config") {
    const host = getPublicHost(request);
    const proto = getPublicProto(request);
    const [branding, wordartOverride, appsData, drawerPrefs, settings, unreadCount, notifications] = await Promise.all([
      getBranding(),
      getUserWordartOverride(user.id),
      getUserAppsWithConfig(user.id),
      getDrawerPrefs(user.id),
      getUserSettings(user.id),
      getUnreadCount(user.id),
      getUserNotifications(user.id, 20),
    ]);

    return NextResponse.json({
      branding: {
        site_name: branding.site_name,
        site_name_style: wordartOverride ?? branding.site_name_style,
        logo_url: branding.logo_url,
        favicon_url: branding.favicon_url,
        accent_color: branding.accent_color,
      },
      navigation: {
        home_url: "/",
        apps: appsData.apps.map((a) => ({
          id: a.id,
          name: a.customName ?? a.name,
          original_name: a.name,
          icon: a.icon,
          custom_icon_url: a.customIconUrl,
          visible: a.visible,
          order: a.displayOrder,
          section_id: a.sectionId,
          status: a.status,
          url: buildAppUrl(a.subdomain, a.containerUrl, a.id, host, a.ssoEntryUrl, proto),
          subdomain: a.subdomain ?? null,
          containerUrl: a.containerUrl ?? null,
          hasSettingsPanel: hasSettingsPanel(a.manifest),
        })),
        sections: appsData.sections.map((s) => ({
          id: s.sectionId,
          name: s.name,
          order: s.displayOrder,
          collapsed: s.collapsed,
        })),
      },
      drawer_prefs: drawerPrefs,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
        is_admin: user.isAdmin,
        avatar_url: user.image,
      },
      notifications: {
        unread_count: unreadCount,
        items: notifications.map((n) => ({
          id: n.id,
          type: n.type,
          title: n.title,
          message: n.message,
          appId: n.appId,
          read: n.read,
          createdAt: n.createdAt,
          action: n.action,
        })),
      },
      theme: {
        mode: (settings.themeMode as string) ?? "system",
      },
    });
  }

  if (path === "notifications") {
    const notifications = await getUserNotifications(user.id, 20);
    const unreadCount = await getUnreadCount(user.id);
    return NextResponse.json({
      unread_count: unreadCount,
      notifications: notifications.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        message: n.message,
        appId: n.appId,
        read: n.read,
        createdAt: n.createdAt,
        action: n.action,
      })),
    });
  }

  if (path === "language") {
    const settings = await getUserSettings(user.id);
    const language = typeof settings.language === "string" && SUPPORTED_LOCALES.includes(settings.language)
      ? settings.language
      : null;
    return NextResponse.json({ language });
  }

  if (path === "wordart") {
    return NextResponse.json({ wordart: await getUserWordartOverride(user.id) });
  }

  if (path === "themes") {
    return NextResponse.json(await listThemes());
  }

  if (path === "themes/active") {
    const active = await getActiveThemePayload(user.id);
    if (!active) return NextResponse.json({ error: "No themes available" }, { status: 404 });
    return NextResponse.json(active);
  }

  if (path === "apps/drawer") {
    const host = getPublicHost(request);
    const proto = getPublicProto(request);
    const data = await getUserAppsWithConfig(user.id);
    return NextResponse.json({
      apps: data.apps.map((a) => ({
        id: a.id,
        name: a.customName ?? a.name,
        original_name: a.name,
        icon: a.icon,
        custom_icon_url: a.customIconUrl,
        visible: a.visible,
        order: a.displayOrder,
        section_id: a.sectionId,
        status: a.status,
        url: buildAppUrl(a.subdomain, a.containerUrl, a.id, host, a.ssoEntryUrl, proto),
        subdomain: a.subdomain ?? null,
        containerUrl: a.containerUrl ?? null,
        hasSettingsPanel: hasSettingsPanel(a.manifest),
      })),
      sections: data.sections.map((s) => ({
        id: s.sectionId,
        name: s.name,
        order: s.displayOrder,
        collapsed: s.collapsed,
      })),
    });
  }

  if (path === "apps/drawer/prefs") {
    return NextResponse.json(await getDrawerPrefs(user.id));
  }

  if (path === "pin/status") {
    const has_pin = await hasPIN(user.id);
    return NextResponse.json({
      has_pin,
      session_active: has_pin ? await hasActivePINSession(user.id) : false,
    });
  }

  if (path.startsWith("permissions/app/")) {
    const appId = decodeURIComponent(path.slice("permissions/app/".length));
    const permissions = await getAppPermissions(user.id, appId);
    return NextResponse.json({
      app_id: appId,
      permissions: permissions.map((permission) => ({
        id: `${appId}:${permission.permission}`,
        appId,
        permission: permission.permission,
        descriptor: describePermission(permission.permission),
        granted: permission.granted,
        grantType: permission.grant_type,
        grantedAt: permission.granted_at,
      })),
    });
  }

  if (path.startsWith("apps/branding/user/")) {
    const appId = decodeURIComponent(path.slice("apps/branding/user/".length));
    const data = await getUserAppsWithConfig(user.id);
    const app = data.apps.find((item) => item.id === appId);
    if (!app) return NextResponse.json({ error: "App not found" }, { status: 404 });
    return NextResponse.json({
      appId,
      brandingWordart: app.brandingWordart,
      headerDisplayMode: app.headerDisplayMode,
      customName: app.customName,
      customIconUrl: app.customIconUrl,
      originalName: app.name,
      originalIcon: app.icon,
      adminBrandingWordart: app.adminBrandingWordart,
      adminHeaderDisplayMode: app.adminHeaderDisplayMode,
    });
  }

  if (path.startsWith("apps/branding/server/")) {
    if (!auth.isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const appId = decodeURIComponent(path.slice("apps/branding/server/".length));
    const data = await getUserAppsWithConfig(user.id);
    const app = data.apps.find((item) => item.id === appId);
    if (!app) return NextResponse.json({ error: "App not found" }, { status: 404 });
    return NextResponse.json({
      appId,
      brandingWordart: app.adminBrandingWordart,
      headerDisplayMode: app.adminHeaderDisplayMode,
      originalName: app.name,
      originalIcon: app.icon,
    });
  }

  if (path === "accounts") {
    return NextResponse.json({ oauthAccounts: [] });
  }

  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const auth = await getBridgeUser(request);
  if (auth.error) return auth.error;
  const path = (await context.params).path.join("/");
  if (path !== "profile") return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json();
  const patch: { firstName?: string | null; lastName?: string | null; bio?: string | null; timezone?: string | null } = {};
  if ("firstName" in body) patch.firstName = body.firstName || null;
  if ("lastName" in body) patch.lastName = body.lastName || null;
  if ("bio" in body) patch.bio = body.bio || null;
  if ("timezone" in body) patch.timezone = body.timezone || null;
  const updated = await updateUserProfile(auth.user.id, patch);
  return NextResponse.json(updated);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const auth = await getBridgeUser(request);
  if (auth.error) return auth.error;
  const { user, isAdmin } = auth;
  const path = (await context.params).path.join("/");
  const body = await request.json();

  if (path === "language") return setUserLanguage(user.id, body.language ?? null);

  if (path === "notifications") {
    await markAllNotificationsRead(user.id);
    return NextResponse.json({ success: true });
  }

  if (path.startsWith("notifications/")) {
    const notificationId = path.slice("notifications/".length);
    const updated = await markNotificationRead(notificationId, user.id);
    return updated
      ? NextResponse.json({ success: true, notification: updated })
      : NextResponse.json({ error: "Notification not found" }, { status: 404 });
  }

  if (path === "wordart") {
    if (!body.wordart || typeof body.wordart !== "object") return NextResponse.json({ error: "Invalid wordart data" }, { status: 400 });
    await saveUserWordartOverride(user.id, body.wordart);
    return NextResponse.json({ wordart: body.wordart });
  }

  if (path === "themes/active") {
    if (body.mode && !body.themeId) {
      if (!["dark", "light", "system"].includes(body.mode)) return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
      const existing = await getUserSettings(user.id);
      const merged = { ...existing, themeMode: body.mode };
      const rows = await db.select().from(userSettings).where(eq(userSettings.userId, user.id)).limit(1);
      if (rows.length === 0) await db.insert(userSettings).values({ userId: user.id, settings: merged });
      else await db.update(userSettings).set({ settings: merged, updatedAt: new Date() }).where(eq(userSettings.userId, user.id));
      return NextResponse.json({ ok: true, mode: body.mode });
    }
    if (!body.themeId) return NextResponse.json({ error: "themeId or mode is required" }, { status: 400 });
    const pref = await setUserActiveTheme(user.id, body.themeId);
    if (!pref) return NextResponse.json({ error: "Theme not found" }, { status: 404 });
    const active = await getActiveThemePayload(user.id);
    return NextResponse.json(active);
  }

  if (path === "apps/drawer/prefs") {
    await saveDrawerPrefs(user.id, {
      columns: typeof body.columns === "number" ? Math.min(Math.max(body.columns, 2), 6) : undefined,
      iconScale: typeof body.iconScale === "number" ? Math.min(Math.max(body.iconScale, 0.5), 2) : undefined,
      maxHeight: typeof body.maxHeight === "number" ? Math.min(Math.max(body.maxHeight, 200), 800) : undefined,
    });
    return NextResponse.json(await getDrawerPrefs(user.id));
  }

  if (path === "apps/drawer/sections") {
    if (!Array.isArray(body.sections)) return NextResponse.json({ error: "Missing sections array" }, { status: 400 });
    const sections = await updateDrawerSections(user.id, body.sections);
    return NextResponse.json({ sections });
  }

  if (path.startsWith("apps/drawer/")) {
    const appId = path.slice("apps/drawer/".length);
    const updated = await updateAppConfig(user.id, appId, body);
    return NextResponse.json(updated);
  }

  if (path.startsWith("apps/branding/user/")) {
    const appId = decodeURIComponent(path.slice("apps/branding/user/".length));
    await updateUserAppBranding(user.id, appId, {
      brandingWordart: body.brandingWordart,
      headerDisplayMode: body.headerDisplayMode,
      customName: body.customName,
      customIconUrl: body.customIconUrl,
    });
    return NextResponse.json({ ok: true });
  }

  if (path.startsWith("apps/branding/server/")) {
    if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const appId = decodeURIComponent(path.slice("apps/branding/server/".length));
    const row = await updateAppBranding(appId, {
      brandingWordart: body.brandingWordart,
      headerDisplayMode: body.headerDisplayMode,
    });
    if (!row) return NextResponse.json({ error: "App not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  if (path === "themes") {
    if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const theme = await createTheme({ name: body.name, colors: body.colors, createdBy: user.id });
    return NextResponse.json(theme, { status: 201 });
  }

  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await getBridgeUser(request);
  if (auth.error) return auth.error;
  const path = (await context.params).path.join("/");
  const body = await request.json().catch(() => ({}));

  if (path === "pin/create") {
    const result = await createPIN(auth.user.id, body.pin);
    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  }

  if (path === "pin/change") {
    const success = await changePIN(auth.user.id, body.current_pin, body.new_pin);
    return NextResponse.json({ success }, { status: success ? 200 : 400 });
  }

  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const auth = await getBridgeUser(request);
  if (auth.error) return auth.error;
  const path = (await context.params).path.join("/");

  if (path === "wordart") {
    await deleteUserWordartOverride(auth.user.id);
    return NextResponse.json({ wordart: null });
  }

  if (path.startsWith("notifications/")) {
    const notificationId = path.slice("notifications/".length);
    await deleteNotification(notificationId, auth.user.id);
    return NextResponse.json({ success: true });
  }

  if (path.startsWith("permissions/app/")) {
    const appId = decodeURIComponent(path.slice("permissions/app/".length));
    const body = await request.json().catch(() => ({}));
    if (body.permission) {
      await revokePermission(auth.user.id, appId, body.permission);
      return NextResponse.json({ success: true });
    }
    const permissions = await getAppPermissions(auth.user.id, appId);
    for (const permission of permissions) {
      await revokePermission(auth.user.id, appId, permission.permission);
    }
    return NextResponse.json({ success: true, revoked: permissions.length });
  }

  if (path.startsWith("apps/branding/user/")) {
    const appId = decodeURIComponent(path.slice("apps/branding/user/".length));
    await updateUserAppBranding(auth.user.id, appId, {
      brandingWordart: null,
      headerDisplayMode: null,
      customName: null,
      customIconUrl: null,
    });
    return NextResponse.json({ ok: true });
  }

  if (path === "pin/session") {
    await endPINSession(auth.user.id);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
