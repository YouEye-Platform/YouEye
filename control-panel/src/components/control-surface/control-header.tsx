"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  Clock,
  Home,
  Package,
  LogOut,
  Settings,
  Shield,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SiteName } from "@/components/control-surface/site-name";
import { MobileAccountSheet } from "@/components/control-surface/mobile-account-sheet";
import { applyThemeMode, THEME_MODE_EVENT, type ThemeMode } from "@/lib/theme";
import type { SiteNameStyle } from "@/lib/wordart-presets";

interface ControlHeaderProps {
  username: string;
  isAdmin: boolean;
  hasUserContext?: boolean;
}

interface HeaderConfig {
  branding?: {
    site_name?: string;
    site_name_style?: SiteNameStyle | null;
    logo_url?: string | null;
  };
  user?: {
    name?: string | null;
    username?: string | null;
    email?: string | null;
    is_admin?: boolean;
    avatar_url?: string | null;
  };
  notifications?: {
    unread_count?: number;
  };
  theme?: {
    mode?: string;
  };
  ui_base_url?: string | null;
}

const EMBED_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation-by-user-activation";
type PlatformOverlayKind = "drawer" | "launcher" | "notifications";

function bridgeApi(path: string) {
  const prefix = typeof window !== "undefined" && window.location.pathname.startsWith("/market")
    ? "/market/api/ui-settings"
    : "/settings/api/ui-settings";
  return `${prefix}/${path.replace(/^\/+/, "")}`;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "YE";
}

function DotsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      {[4, 12, 20].map((cy) =>
        [4, 12, 20].map((cx) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2" />
        ))
      )}
    </svg>
  );
}

function PlatformOverlayFrame({
  kind,
  active,
  preload,
  uiBaseUrl,
  uiBaseOrigin,
  mode,
  isAdmin,
}: {
  kind: PlatformOverlayKind;
  active: boolean;
  preload: boolean;
  uiBaseUrl: string;
  uiBaseOrigin: string;
  mode: "light" | "dark";
  isAdmin: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [mounted, setMounted] = useState(active || preload);
  const [loaded, setLoaded] = useState(false);
  const src = useMemo(() => {
    if (!uiBaseUrl) return null;
    const params = new URLSearchParams({ mode });
    if (kind === "drawer" && isAdmin) params.set("admin", "true");
    return `${uiBaseUrl}/embed/${kind}?${params.toString()}`;
  }, [isAdmin, kind, mode, uiBaseUrl]);
  const targetOrigin = uiBaseOrigin || "*";

  useEffect(() => {
    if (active || preload) setMounted(true);
  }, [active, preload]);

  useEffect(() => {
    setLoaded(false);
  }, [src]);

  const postVisibility = useCallback(() => {
    if (!src) return;
    iframeRef.current?.contentWindow?.postMessage(
      { type: "youeye:overlay-visibility", kind, open: active },
      targetOrigin
    );
  }, [active, kind, src, targetOrigin]);

  useEffect(() => {
    if (!mounted || !loaded) return;
    postVisibility();
  }, [loaded, mounted, postVisibility]);

  if (!mounted || !src || typeof document === "undefined") return null;

  return createPortal(
    <iframe
      ref={iframeRef}
      src={src}
      className={`fixed inset-0 z-[60] h-screen w-screen border-0 bg-transparent transition-opacity duration-100 ${
        active && loaded ? "pointer-events-auto" : "pointer-events-none"
      }`}
      style={{ colorScheme: mode, opacity: active && loaded ? 1 : 0 }}
      title={`YouEye ${kind}`}
      sandbox={EMBED_SANDBOX}
      allow="clipboard-read; clipboard-write"
      onLoad={() => {
        setLoaded(true);
        window.setTimeout(postVisibility, 0);
      }}
    />,
    document.body
  );
}

export function ControlHeader({ username, isAdmin, hasUserContext = true }: ControlHeaderProps) {
  const [config, setConfig] = useState<HeaderConfig | null>(null);
  const [platformOverlay, setPlatformOverlay] = useState<PlatformOverlayKind | null>(null);
  const [prewarmOverlays, setPrewarmOverlays] = useState(false);
  const [embedMode, setEmbedMode] = useState<"light" | "dark">("light");
  const [systemPref, setSystemPref] = useState<"light" | "dark">("light");
  const saveThemeTimeout = useRef<NodeJS.Timeout | null>(null);

  const loadConfig = useCallback(async () => {
    if (!hasUserContext) {
      const res = await fetch("/api/setup/config", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      setConfig({
        branding: {
          site_name: data.site_name || "YouEye",
          site_name_style: null,
          logo_url: null,
        },
        user: {
          name: username,
          username,
          email: username,
          is_admin: isAdmin,
          avatar_url: null,
        },
        notifications: { unread_count: 0 },
        theme: { mode: "system" },
        ui_base_url: null,
      });
      return;
    }

    const res = await fetch(bridgeApi("header/config"), { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setConfig(data);
  }, [hasUserContext, isAdmin, username]);

  useEffect(() => {
    loadConfig().catch(() => {});
  }, [loadConfig]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemPref(mq.matches ? "dark" : "light");
    const handler = (event: MediaQueryListEvent) => setSystemPref(event.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const uiBaseUrl = config?.ui_base_url?.replace(/\/$/, "") ?? "";
  const uiBaseOrigin = (() => {
    if (!uiBaseUrl) return "";
    try {
      return new URL(uiBaseUrl).origin;
    } catch {
      return uiBaseUrl;
    }
  })();

  const resolveEmbedMode = useCallback((): "light" | "dark" => (
    document.documentElement.classList.contains("dark") ? "dark" : "light"
  ), []);

  const warmPlatformOverlays = useCallback(() => {
    if (!uiBaseUrl) return;
    setEmbedMode(resolveEmbedMode());
    setPrewarmOverlays(true);
  }, [resolveEmbedMode, uiBaseUrl]);

  const openPlatformOverlay = useCallback((kind: PlatformOverlayKind) => {
    warmPlatformOverlays();
    setPlatformOverlay(kind);
  }, [warmPlatformOverlays]);

  useEffect(() => {
    if (!hasUserContext || !uiBaseUrl) return;
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(warmPlatformOverlays, { timeout: 1200 });
      return () => idleWindow.cancelIdleCallback?.(handle);
    }
    const handle = window.setTimeout(warmPlatformOverlays, 600);
    return () => window.clearTimeout(handle);
  }, [hasUserContext, uiBaseUrl, warmPlatformOverlays]);

  useEffect(() => {
    if (!platformOverlay) return;
    warmPlatformOverlays();
  }, [platformOverlay, warmPlatformOverlays]);

  useEffect(() => {
    if (!uiBaseOrigin) return;
    function onMessage(event: MessageEvent) {
      if (event.origin !== uiBaseOrigin) return;
      if (event.data?.type === "youeye:close") {
        setPlatformOverlay(null);
        return;
      }
      if (event.data?.type === "youeye:overlay-command" && event.data?.command === "open-launcher") {
        setEmbedMode(resolveEmbedMode());
        setPlatformOverlay("launcher");
        return;
      }
      if (event.data?.type === "youeye:notifications" && typeof event.data.unread_count === "number") {
        setConfig((current) => ({
          ...(current ?? {}),
          notifications: {
            ...(current?.notifications ?? {}),
            unread_count: event.data.unread_count,
          },
        }));
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [resolveEmbedMode, uiBaseOrigin]);

  useEffect(() => {
    if (!platformOverlay) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setPlatformOverlay(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [platformOverlay]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { url?: string | null } | undefined;
      setConfig((current) => ({
        ...(current ?? {}),
        user: {
          ...(current?.user ?? {}),
          avatar_url: detail?.url ?? null,
        },
      }));
    };
    window.addEventListener("avatar-updated", handler);
    return () => window.removeEventListener("avatar-updated", handler);
  }, []);

  const displayName = config?.user?.name || username;
  const firstName = displayName.split(" ")[0] || displayName;
  const email = config?.user?.email || username;
  const avatarUrl = config?.user?.avatar_url || null;
  const headerIsAdmin = config?.user?.is_admin ?? isAdmin;
  const siteName = config?.branding?.site_name || "YouEye";
  const siteNameStyle = config?.branding?.site_name_style ?? null;
  const logoUrl = config?.branding?.logo_url ?? null;
  const unreadCount = config?.notifications?.unread_count ?? 0;
  const themeMode = config?.theme?.mode ?? "system";

  // Apply the user's saved light/dark/system mode to <html> on load and whenever
  // it changes. Source of truth is config.theme.mode (bridge → UI DB); the inline
  // boot script in app/layout.tsx handles the very first paint from the shared
  // localStorage("theme") key the dashboard's next-themes already writes.
  useEffect(() => {
    applyThemeMode(themeMode as ThemeMode);
  }, [themeMode, systemPref]);

  // Stay in sync when the Appearance page changes the mode (it broadcasts an event).
  useEffect(() => {
    const handler = (event: Event) => {
      const mode = (event as CustomEvent).detail?.mode as ThemeMode | undefined;
      if (!mode) return;
      setConfig((current) => ({ ...(current ?? {}), theme: { ...(current?.theme ?? {}), mode } }));
    };
    window.addEventListener(THEME_MODE_EVENT, handler);
    return () => window.removeEventListener(THEME_MODE_EVENT, handler);
  }, []);

  async function logout() {
    await fetch("/settings/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/";
  }

  // E4 (D14-revised): direct Light/Dark/Auto setter for the segmented control.
  function applyTheme(mode: ThemeMode) {
    if (!hasUserContext) return;
    setConfig((current) => ({ ...(current ?? {}), theme: { ...(current?.theme ?? {}), mode } }));
    applyThemeMode(mode);
    if (saveThemeTimeout.current) clearTimeout(saveThemeTimeout.current);
    saveThemeTimeout.current = setTimeout(() => {
      fetch(bridgeApi("themes/active"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      }).catch(() => {});
    }, 300);
  }

  const THEME_MODES: { mode: ThemeMode; Icon: typeof Sun; label: string }[] = [
    { mode: "light", Icon: Sun, label: "Light" },
    { mode: "dark", Icon: Moon, label: "Dark" },
    { mode: "system", Icon: Monitor, label: "Auto" },
  ];

  return (
    <>
      <header className="sticky top-0 z-50 flex h-14 items-center justify-between border-b border-border/40 bg-background/95 px-4 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 transition-opacity hover:opacity-80">
            {logoUrl && <img src={logoUrl} alt="" className="h-6 w-6 object-contain" />}
            <SiteName name={siteName} style={siteNameStyle} />
          </Link>
        </div>

        <div className="ye-mobile-shell-desktop flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-9 w-9" asChild>
            <Link href="/" title="Home">
              <Home className="h-4 w-4" />
            </Link>
          </Button>

          {hasUserContext && (
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              aria-label="Apps"
              disabled={!uiBaseUrl}
              onFocus={warmPlatformOverlays}
              onClick={() => openPlatformOverlay("drawer")}
              onPointerEnter={warmPlatformOverlays}
            >
              <DotsIcon className="h-4 w-4" />
            </Button>
          )}

          {hasUserContext && (
            <button
              className="relative inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors hover:bg-accent disabled:opacity-50"
              aria-label="Notifications"
              disabled={!uiBaseUrl}
              onFocus={warmPlatformOverlays}
              onClick={() => openPlatformOverlay("notifications")}
              onPointerEnter={warmPlatformOverlays}
            >
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-0.5 text-[9px] font-bold text-white">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </button>
          )}

          {hasUserContext && uiBaseUrl && (
            <>
              <PlatformOverlayFrame
                kind="drawer"
                active={platformOverlay === "drawer"}
                preload={prewarmOverlays}
                uiBaseUrl={uiBaseUrl}
                uiBaseOrigin={uiBaseOrigin}
                mode={embedMode}
                isAdmin={headerIsAdmin}
              />
              <PlatformOverlayFrame
                kind="launcher"
                active={platformOverlay === "launcher"}
                preload={prewarmOverlays}
                uiBaseUrl={uiBaseUrl}
                uiBaseOrigin={uiBaseOrigin}
                mode={embedMode}
                isAdmin={headerIsAdmin}
              />
              <PlatformOverlayFrame
                kind="notifications"
                active={platformOverlay === "notifications"}
                preload={prewarmOverlays}
                uiBaseUrl={uiBaseUrl}
                uiBaseOrigin={uiBaseOrigin}
                mode={embedMode}
                isAdmin={headerIsAdmin}
              />
            </>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="inline-flex h-9 w-9 items-center justify-center rounded-md outline-none transition-colors hover:bg-accent">
                <Avatar className="size-7">
                  {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
                  <AvatarFallback className="text-xs">{initials(displayName)}</AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
            {/* E4 (D14-revised) — the same toned-down account panel mirrored from the UI:
                email, big avatar (no pencil-edit), greeting, grouped Timeline/Settings/Theme, Sign out.
                No "Manage your account" pill and no Privacy · About footer. */}
            <DropdownMenuContent
              align="end"
              sideOffset={8}
              className="w-[340px] rounded-3xl p-0 overflow-hidden border bg-muted"
            >
            {/* Email, centered */}
            <p className="pt-4 pb-3 text-center text-xs text-muted-foreground truncate px-6">{email}</p>

            {/* Big avatar + greeting — display only */}
            <div className="flex flex-col items-center gap-2 px-5">
              <Avatar className="size-[76px]">
                {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
                <AvatarFallback className="text-xl">{initials(displayName)}</AvatarFallback>
              </Avatar>
              <div className="flex items-center gap-1.5 text-base font-medium">
                <span>Hi, {firstName}!</span>
                {headerIsAdmin && <Shield className="size-3.5 text-primary" />}
              </div>
            </div>

            {/* Grouped card */}
            <div className="m-3 rounded-2xl bg-card border overflow-hidden">
              {hasUserContext && (
                <>
                  <button
                    type="button"
                    onClick={() => { window.location.href = "/timeline"; }}
                    className="flex w-full items-center gap-3 px-4 py-3 text-sm hover:bg-accent transition-colors"
                  >
                    <Clock className="size-4 text-muted-foreground" />
                    Timeline
                  </button>
                  <div className="border-t" />
                </>
              )}
              <button
                type="button"
                onClick={() => { window.location.href = hasUserContext ? "/settings" : "/settings/system"; }}
                className="flex w-full items-center gap-3 px-4 py-3 text-sm hover:bg-accent transition-colors"
              >
                <Settings className="size-4 text-muted-foreground" />
                Settings
              </button>
              {hasUserContext && (
                <>
                  <div className="border-t" />
                  <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span className="flex items-center gap-3 text-sm">
                      <Sun className="size-4 text-muted-foreground" />
                      Theme
                    </span>
                    <div className="inline-flex rounded-lg border bg-background p-0.5">
                      {THEME_MODES.map(({ mode, Icon, label }) => {
                        const active = themeMode === mode;
                        return (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => applyTheme(mode)}
                            aria-pressed={active}
                            title={label}
                            className={`grid place-items-center size-7 rounded-md transition-colors ${
                              active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            <Icon className="size-3.5" />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Sign out */}
            <div className="px-3 pb-3">
              <button
                type="button"
                onClick={logout}
                className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                <LogOut className="size-4" />
                Sign out
              </button>
            </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="ye-mobile-shell-only fixed inset-x-0 bottom-0 z-50 items-center gap-2 border-t border-border/60 bg-background/95 px-2 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur-xl">
        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <Link
            href="/settings"
            className="inline-flex h-12 min-w-12 items-center justify-center gap-2 rounded-2xl px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Settings"
          >
            <Settings className="size-4" />
            <span className="max-[420px]:hidden">Settings</span>
          </Link>
          {hasUserContext && (
            <Link
              href="/market"
              className="inline-flex h-12 min-w-12 items-center justify-center gap-2 rounded-2xl px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="Market"
            >
              <Package className="size-4" />
              <span className="max-[420px]:hidden">Market</span>
            </Link>
          )}
        </nav>
        <MobileAccountSheet
          displayName={displayName}
          email={email}
          isAdmin={headerIsAdmin}
          hasUserContext={hasUserContext}
          avatarUrl={avatarUrl}
          unreadCount={unreadCount}
          uiBaseUrl={uiBaseUrl}
          uiBaseOrigin={uiBaseOrigin}
          themeMode={themeMode}
          embedMode={embedMode}
          onThemeChange={applyTheme}
          onLogout={logout}
        />
      </div>
      <div className="ye-mobile-shell-spacer" aria-hidden="true" />
    </>
  );
}
