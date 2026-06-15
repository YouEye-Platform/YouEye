/**
 * Launcher — Plan 1 Workstream E1.
 *
 * The `launcher.html` app launcher, rendered by the UI and served at
 * `/embed/launcher` (UI origin). This is the ONE implementation: the UI's own
 * header opens it, and native apps host it as a UI-served iframe in their Canvas
 * header — so apps no longer receive the installed-app list (the E1 security fix,
 * ui-v0.4.11). Search + a tile grid of the user's apps + Market/Settings system
 * tiles. Data comes from the UI's own `/api/v1/apps/drawer` (never CP — pitfall #25).
 *
 * Scoped follow-up: drag-to-reorder, pinned-row, and folders (the launcher.html
 * 2×2 folder tiles + open panel) — see Plans/Archive/To Plan/launcher-folders-and-native-adoption.md.
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import * as LucideIcons from "lucide-react";
import type { ComponentType } from "react";
import { Search, Store, Settings, Package, X } from "lucide-react";
import { useTranslations } from "next-intl";

interface LauncherApp {
  id: string;
  name: string;
  icon: string | null;
  custom_icon_url: string | null;
  visible: boolean;
  status: string | null;
  url: string | null;
}

function kebabToPascal(s: string): string {
  return s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

function getLucideIcon(name: string): ComponentType<{ className?: string }> | undefined {
  const icon = (LucideIcons as Record<string, unknown>)[kebabToPascal(name)];
  if (typeof icon === "function" || (typeof icon === "object" && icon !== null && "$$typeof" in (icon as Record<string, unknown>))) {
    return icon as ComponentType<{ className?: string }>;
  }
  return undefined;
}

/** 64px app tile — image icon, lucide glyph, or first-letter fallback. */
function LauncherTile({ icon, customIconUrl, name }: { icon: string | null; customIconUrl: string | null; name: string }) {
  const [imgError, setImgError] = useState(false);
  const src = customIconUrl ?? (icon?.startsWith("http") || icon?.startsWith("/") || icon?.startsWith("data:") ? icon : null);

  if (src && !imgError) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" className="h-16 w-16 rounded-2xl border border-border/60 object-cover shadow-sm" onError={() => setImgError(true)} />;
  }
  if (icon?.startsWith("emoji:")) {
    return <div className="grid h-16 w-16 place-items-center rounded-2xl border border-border/60 bg-card text-3xl shadow-sm">{icon.slice(6)}</div>;
  }
  const Glyph = (icon && getLucideIcon(icon)) || Package;
  return (
    <div className="grid h-16 w-16 place-items-center rounded-2xl border border-border/60 bg-card text-foreground/80 shadow-sm">
      <Glyph className="h-7 w-7" />
    </div>
  );
}

interface SystemTile {
  key: string;
  name: string;
  href: string;
  Icon: ComponentType<{ className?: string }>;
}

export function Launcher({ embedded = false, onClose }: { embedded?: boolean; onClose?: () => void }) {
  const [apps, setApps] = useState<LauncherApp[]>([]);
  const [query, setQuery] = useState("");
  const t = useTranslations("nav");

  useEffect(() => {
    fetch("/api/v1/apps/drawer")
      .then((r) => (r.ok ? r.json() : { apps: [] }))
      .then((data) => setApps(data.apps ?? []))
      .catch(() => setApps([]));
  }, []);

  // System tiles (Market is admin-relevant but always reachable; Settings always).
  const systemTiles: SystemTile[] = useMemo(
    () => [
      { key: "market", name: "Market", href: "/market", Icon: Store },
      { key: "settings", name: t("settings"), href: "/settings", Icon: Settings },
    ],
    [t]
  );

  // The launcher shows ALL installed apps — pinning only affects the drawer (Plan 5 L6).
  const allLauncherApps = useMemo(
    () => apps.filter((a) => a.url),
    [apps]
  );

  const q = query.trim().toLowerCase();
  const filteredApps = q ? allLauncherApps.filter((a) => a.name.toLowerCase().includes(q)) : allLauncherApps;
  const filteredSystem = q ? systemTiles.filter((s) => s.name.toLowerCase().includes(q)) : systemTiles;

  // In an iframe, navigate the top window so the app opens at the top level.
  const go = (href: string) => {
    if (embedded && typeof window !== "undefined" && window.top) window.top.location.href = href;
    else window.location.href = href;
  };

  return (
    <div className="relative flex h-full w-full flex-col items-center gap-8 overflow-y-auto px-6 pb-6 pt-9">
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full border bg-card/80 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      )}
      {/* Search */}
      <div className="relative w-[min(440px,90%)]">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchApps")}
          className="h-11 w-full rounded-full border bg-card/90 pl-11 pr-4 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* App grid */}
      {filteredApps.length === 0 && filteredSystem.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">{t("noAppsFound")}</p>
      ) : (
        <div className="grid w-full max-w-3xl grid-cols-[repeat(auto-fill,minmax(84px,96px))] justify-center gap-x-9 gap-y-7">
          {filteredApps.map((app) => (
            <button
              key={app.id}
              type="button"
              onClick={() => app.url && go(app.url)}
              className={`grid justify-items-center gap-2 rounded-xl p-1 text-center transition-transform hover:scale-105 ${
                app.status === "unhealthy" ? "opacity-40 grayscale" : ""
              }`}
              title={app.name}
            >
              <LauncherTile icon={app.icon} customIconUrl={app.custom_icon_url} name={app.name} />
              <b className="line-clamp-1 w-[88px] text-xs font-semibold text-foreground/90">{app.name}</b>
            </button>
          ))}

          {filteredSystem.map(({ key, name, href, Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => go(href)}
              className="grid justify-items-center gap-2 rounded-xl p-1 text-center transition-transform hover:scale-105"
              title={name}
            >
              <div className="grid h-16 w-16 place-items-center rounded-2xl border border-border/60 bg-card text-foreground/70 shadow-sm">
                <Icon className="h-7 w-7" />
              </div>
              <b className="line-clamp-1 w-[88px] text-xs font-semibold text-foreground/90">{name}</b>
            </button>
          ))}
        </div>
      )}

      <p className="mt-auto text-xs text-muted-foreground/80">{t("launcherHint")}</p>
    </div>
  );
}
