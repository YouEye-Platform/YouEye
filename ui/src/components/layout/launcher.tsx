/**
 * Launcher — Plan 5 (Workstream E1).
 *
 * The `launcher.html` app launcher, rendered by the UI and served at
 * `/embed/launcher` (UI origin). This is the ONE implementation: the UI's own
 * header opens it (as a near-full-screen overlay), and native apps host it as a
 * UI-served iframe — so apps no longer receive the installed-app list (the E1
 * security fix). Search + a tile grid of ALL the user's apps + iOS-style
 * **folders** + Market/Settings system tiles. Data comes from the UI's own
 * `/api/v1/apps/drawer` (never CP — pitfall #25).
 *
 * Folders (Plan 5): drag one app onto another to create a folder; drag an app
 * onto a folder to add it; a folder tile shows a 2×2 mini-grid; clicking it
 * opens a centered panel; × removes an app (empty folders auto-delete). Folders
 * are launcher-only and independent of the drawer's sections.
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
  folder_id: string | null;
}

interface Folder {
  id: string;
  name: string;
  order: number;
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

function resolveImg(app: { icon: string | null; custom_icon_url: string | null }): string | null {
  return app.custom_icon_url ?? (app.icon?.startsWith("http") || app.icon?.startsWith("/") || app.icon?.startsWith("data:") ? app.icon : null);
}

/** 64px app tile — image icon, lucide glyph, or first-letter fallback. */
function LauncherTile({ icon, customIconUrl }: { icon: string | null; customIconUrl: string | null }) {
  const [imgError, setImgError] = useState(false);
  const src = resolveImg({ icon, custom_icon_url: customIconUrl });

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

/** Small icon used inside the 2×2 folder preview. */
function MiniTile({ app }: { app: LauncherApp }) {
  const [imgError, setImgError] = useState(false);
  const src = resolveImg(app);
  if (src && !imgError) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" className="h-full w-full rounded-md object-cover" onError={() => setImgError(true)} />;
  }
  if (app.icon?.startsWith("emoji:")) {
    return <div className="grid h-full w-full place-items-center rounded-md bg-background text-xs">{app.icon.slice(6)}</div>;
  }
  const Glyph = (app.icon && getLucideIcon(app.icon)) || Package;
  return (
    <div className="grid h-full w-full place-items-center rounded-md bg-background text-foreground/70">
      <Glyph className="h-3.5 w-3.5" />
    </div>
  );
}

interface SystemTile {
  key: string;
  name: string;
  href: string;
  Icon: ComponentType<{ className?: string }>;
}

function genFolderId(): string {
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function Launcher({ embedded = false, onClose }: { embedded?: boolean; onClose?: () => void }) {
  const [apps, setApps] = useState<LauncherApp[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [query, setQuery] = useState("");
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [draggedAppId, setDraggedAppId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const t = useTranslations("nav");

  useEffect(() => {
    fetch("/api/v1/apps/drawer")
      .then((r) => (r.ok ? r.json() : { apps: [], folders: [] }))
      .then((data) => { setApps(data.apps ?? []); setFolders(data.folders ?? []); })
      .catch(() => { setApps([]); setFolders([]); });
  }, []);

  const systemTiles: SystemTile[] = useMemo(
    () => [
      { key: "market", name: "Market", href: "/market", Icon: Store },
      { key: "settings", name: t("settings"), href: "/settings", Icon: Settings },
    ],
    [t]
  );

  const withUrl = useMemo(() => apps.filter((a) => a.url), [apps]);

  const membersOf = useMemo(() => {
    const m = new Map<string, LauncherApp[]>();
    for (const a of withUrl) {
      if (a.folder_id) {
        const arr = m.get(a.folder_id) ?? [];
        arr.push(a);
        m.set(a.folder_id, arr);
      }
    }
    return m;
  }, [withUrl]);

  // Only render folders that still have members (self-healing against stale rows).
  const validFolders = useMemo(
    () => folders.filter((f) => (membersOf.get(f.id)?.length ?? 0) > 0),
    [folders, membersOf]
  );
  const looseApps = useMemo(() => withUrl.filter((a) => !a.folder_id), [withUrl]);

  const q = query.trim().toLowerCase();
  // When searching, flatten everything (incl. apps inside folders) and hide folders.
  const gridApps = q ? withUrl.filter((a) => a.name.toLowerCase().includes(q)) : looseApps;
  const gridSystem = q ? systemTiles.filter((s) => s.name.toLowerCase().includes(q)) : systemTiles;
  const showFolders = !q;

  const go = (href: string) => {
    if (embedded && typeof window !== "undefined" && window.top) window.top.location.href = href;
    else window.location.href = href;
  };

  // ── Persistence ──
  const persistFolders = (fs: Folder[]) =>
    fetch("/api/v1/apps/drawer/folders", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folders: fs.map((f, i) => ({ id: f.id, name: f.name, order: i })) }),
    }).catch(() => {});

  const setAppFolder = (appId: string, folderId: string | null) =>
    fetch(`/api/v1/apps/drawer/${appId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_id: folderId }),
    }).catch(() => {});

  const pruneFolders = (nextApps: LauncherApp[], base: Folder[], keepId?: string) =>
    base.filter((f) => f.id === keepId || nextApps.some((a) => a.url && a.folder_id === f.id));

  // ── Folder operations ──
  const createFolder = (targetId: string, draggedId: string) => {
    if (targetId === draggedId) return;
    const id = genFolderId();
    const nextApps = apps.map((a) => (a.id === targetId || a.id === draggedId ? { ...a, folder_id: id } : a));
    const nextFolders = pruneFolders(nextApps, [...folders, { id, name: t("folder"), order: folders.length }], id);
    setApps(nextApps);
    setFolders(nextFolders);
    setAppFolder(targetId, id);
    setAppFolder(draggedId, id);
    persistFolders(nextFolders);
  };

  const addToFolder = (appId: string, folderId: string) => {
    if (apps.find((a) => a.id === appId)?.folder_id === folderId) return;
    const nextApps = apps.map((a) => (a.id === appId ? { ...a, folder_id: folderId } : a));
    const nextFolders = pruneFolders(nextApps, folders, folderId);
    setApps(nextApps);
    setFolders(nextFolders);
    setAppFolder(appId, folderId);
    if (nextFolders.length !== folders.length) persistFolders(nextFolders);
  };

  const removeFromFolder = (appId: string) => {
    const nextApps = apps.map((a) => (a.id === appId ? { ...a, folder_id: null } : a));
    const nextFolders = pruneFolders(nextApps, folders);
    setApps(nextApps);
    setFolders(nextFolders);
    setAppFolder(appId, null);
    if (nextFolders.length !== folders.length) {
      persistFolders(nextFolders);
      if (openFolderId && !nextFolders.some((f) => f.id === openFolderId)) setOpenFolderId(null);
    }
  };

  const renameFolder = (folderId: string, name: string) => {
    const nextFolders = folders.map((f) => (f.id === folderId ? { ...f, name } : f));
    setFolders(nextFolders);
    persistFolders(nextFolders);
  };

  // ── Drag (apps are the drag source; apps + folders are drop targets) ──
  const onDragStart = (e: React.DragEvent, appId: string) => {
    setDraggedAppId(appId);
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", appId); } catch { /* noop */ }
  };
  const onDragEnd = () => { setDraggedAppId(null); setDragOverId(null); };
  const onDragOver = (e: React.DragEvent, id: string) => {
    if (!draggedAppId || id === draggedAppId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverId(id);
  };
  const onDropApp = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (draggedAppId) createFolder(targetId, draggedAppId);
    onDragEnd();
  };
  const onDropFolder = (e: React.DragEvent, folderId: string) => {
    e.preventDefault();
    if (draggedAppId) addToFolder(draggedAppId, folderId);
    onDragEnd();
  };

  const openFolder = openFolderId ? validFolders.find((f) => f.id === openFolderId) : null;
  const openMembers = openFolderId ? membersOf.get(openFolderId) ?? [] : [];

  const labelCls = "line-clamp-1 w-[88px] text-xs font-semibold text-foreground/90";

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

      {/* Grid */}
      {gridApps.length === 0 && gridSystem.length === 0 && (!showFolders || validFolders.length === 0) ? (
        <p className="mt-6 text-sm text-muted-foreground">{t("noAppsFound")}</p>
      ) : (
        <div className="grid w-full max-w-3xl grid-cols-[repeat(auto-fill,minmax(84px,96px))] justify-center gap-x-9 gap-y-7">
          {/* Apps (loose, or all matches when searching) */}
          {gridApps.map((app) => (
            <button
              key={app.id}
              type="button"
              draggable
              onClick={() => app.url && go(app.url)}
              onDragStart={(e) => onDragStart(e, app.id)}
              onDragEnd={onDragEnd}
              onDragOver={(e) => onDragOver(e, app.id)}
              onDrop={(e) => onDropApp(e, app.id)}
              className={`grid justify-items-center gap-2 rounded-xl p-1 text-center transition-transform hover:scale-105 ${
                app.status === "unhealthy" ? "opacity-40 grayscale" : ""
              } ${draggedAppId === app.id ? "opacity-30" : ""} ${dragOverId === app.id ? "scale-110 ring-2 ring-primary ring-offset-2 ring-offset-transparent" : ""}`}
              title={app.name}
            >
              <LauncherTile icon={app.icon} customIconUrl={app.custom_icon_url} />
              <b className={labelCls}>{app.name}</b>
            </button>
          ))}

          {/* Folders */}
          {showFolders && validFolders.map((folder) => {
            const members = membersOf.get(folder.id) ?? [];
            return (
              <button
                key={folder.id}
                type="button"
                onClick={() => setOpenFolderId(folder.id)}
                onDragOver={(e) => onDragOver(e, folder.id)}
                onDrop={(e) => onDropFolder(e, folder.id)}
                className={`grid justify-items-center gap-2 rounded-xl p-1 text-center transition-transform hover:scale-105 ${
                  dragOverId === folder.id ? "scale-110 ring-2 ring-primary ring-offset-2 ring-offset-transparent" : ""
                }`}
                title={folder.name}
              >
                <div className="grid h-16 w-16 grid-cols-2 grid-rows-2 gap-1 rounded-2xl border border-border/60 bg-card/60 p-1.5 shadow-sm">
                  {members.slice(0, 4).map((m) => (
                    <MiniTile key={m.id} app={m} />
                  ))}
                </div>
                <b className={labelCls}>{folder.name}</b>
              </button>
            );
          })}

          {/* System tiles */}
          {gridSystem.map(({ key, name, href, Icon }) => (
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
              <b className={labelCls}>{name}</b>
            </button>
          ))}
        </div>
      )}

      <p className="mt-auto text-xs text-muted-foreground/80">{t("launcherHint")}</p>

      {/* Open-folder panel — absolute within the launcher (not fixed, to avoid
          backdrop-filter containing-block traps when hosted in an overlay). */}
      {openFolder && (
        <div
          className="absolute inset-0 z-30 grid place-items-center bg-background/50 p-6 backdrop-blur-sm"
          onClick={() => setOpenFolderId(null)}
        >
          <div
            className="w-[min(380px,92%)] rounded-3xl border bg-popover p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              value={openFolder.name}
              onChange={(e) => renameFolder(openFolder.id, e.target.value)}
              aria-label={t("folder")}
              className="mb-5 w-full rounded-lg bg-transparent text-center text-sm font-semibold text-foreground/80 outline-none focus:bg-accent/40"
            />
            <div className="grid grid-cols-3 justify-items-center gap-4">
              {openMembers.map((m) => (
                <div key={m.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => m.url && go(m.url)}
                    className="grid justify-items-center gap-1.5 rounded-xl p-1 text-center transition-transform hover:scale-105"
                    title={m.name}
                  >
                    <LauncherTile icon={m.icon} customIconUrl={m.custom_icon_url} />
                    <b className="line-clamp-1 w-[72px] text-xs font-medium text-foreground/90">{m.name}</b>
                  </button>
                  <button
                    type="button"
                    aria-label={t("removeFromFolder")}
                    title={t("removeFromFolder")}
                    onClick={() => removeFromFolder(m.id)}
                    className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-danger group-hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
