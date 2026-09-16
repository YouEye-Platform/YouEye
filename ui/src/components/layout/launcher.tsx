/**
 * Launcher — Plan 5 (Workstream E1; Slice 2.5 unified grid + live reorder).
 *
 * The `launcher.html` app launcher, served at `/embed/launcher` (UI origin) and
 * opened by the UI header as a near-full-screen overlay. ONE implementation:
 * native apps host it as a UI-served iframe (E1 security fix). Search + a single
 * **ordered grid** of all the user's apps AND iOS-style **folders** + Market/Settings
 * system tiles. Data from the UI's own `/api/v1/apps/drawer` (never CP).
 *
 * Fine-pointer desktop users drag directly. Coarse-pointer/mobile users enter
 * rearrange mode first so ordinary vertical scrolling remains native. A central
 * app drop creates a folder; a central folder drop adds to it. The launcher has
 * no hide/remove path — moving an app out of a folder returns it to this grid.
 */

"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import * as LucideIcons from "lucide-react";
import type { ComponentType } from "react";
import { Check, Package, Pencil, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useGridDrag } from "@/lib/hooks/use-grid-drag";

interface LauncherApp {
  id: string;
  name: string;
  icon: string | null;
  custom_icon_url: string | null;
  visible: boolean;
  status: string | null;
  url: string | null;
  order: number;
  folder_id: string | null;
  launcher_visible: boolean;
  platform?: boolean;
}

interface Folder {
  id: string;
  name: string;
  order: number;
}

type GridItem =
  | { kind: "app"; id: string; order: number; app: LauncherApp }
  | { kind: "folder"; id: string; order: number; folder: Folder; members: LauncherApp[] };

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

function LauncherTile({ icon, customIconUrl }: { icon: string | null; customIconUrl: string | null }) {
  const [imgError, setImgError] = useState(false);
  const src = resolveImg({ icon, custom_icon_url: customIconUrl });
  if (src && !imgError) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" draggable={false} className="h-16 w-16 rounded-2xl border border-border/50 object-cover shadow-sm" onError={() => setImgError(true)} />;
  }
  if (icon?.startsWith("emoji:")) {
    return <div className="grid h-16 w-16 place-items-center rounded-2xl border border-border/50 bg-card/60 text-3xl shadow-sm">{icon.slice(6)}</div>;
  }
  const Glyph = (icon && getLucideIcon(icon)) || Package;
  return (
    <div className="grid h-16 w-16 place-items-center rounded-2xl border border-border/50 bg-card/60 text-foreground/80 shadow-sm">
      <Glyph className="h-7 w-7" />
    </div>
  );
}

function MiniTile({ app }: { app: LauncherApp }) {
  const [imgError, setImgError] = useState(false);
  const src = resolveImg(app);
  if (src && !imgError) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" draggable={false} className="h-full w-full rounded-md object-cover" onError={() => setImgError(true)} />;
  }
  if (app.icon?.startsWith("emoji:")) {
    return <div className="grid h-full w-full place-items-center rounded-md bg-background/60 text-xs">{app.icon.slice(6)}</div>;
  }
  const Glyph = (app.icon && getLucideIcon(app.icon)) || Package;
  return <div className="grid h-full w-full place-items-center rounded-md bg-background/60 text-foreground/70"><Glyph className="h-3.5 w-3.5" /></div>;
}

function FolderPreview({ members }: { members: LauncherApp[] }) {
  return (
    <div className="grid h-16 w-16 grid-cols-2 grid-rows-2 gap-1 rounded-2xl border border-border/50 bg-card/40 p-1.5 shadow-sm">
      {members.slice(0, 4).map((m) => <MiniTile key={m.id} app={m} />)}
    </div>
  );
}

function genFolderId(): string {
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function useFinePointer(): boolean {
  const [finePointer, setFinePointer] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(hover: hover) and (pointer: fine)");
    const update = () => setFinePointer(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return finePointer;
}

export function Launcher({ embedded = false, onClose }: { embedded?: boolean; onClose?: () => void }) {
  const [apps, setApps] = useState<LauncherApp[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const finePointer = useFinePointer();
  const layoutSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const t = useTranslations("nav");

  const fetchApps = useCallback(() => {
    fetch("/api/v1/apps/drawer")
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load apps");
        return r.json();
      })
      .then((data) => {
        setApps(data.apps ?? []);
        setFolders(data.folders ?? []);
        setLoadError(false);
      })
      .catch(() => {
        setLoadError(true);
      })
      .finally(() => {
        setLoaded(true);
      });
  }, []);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  useEffect(() => {
    if (!embedded) return;
    const handleVisibility = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== "youeye:overlay-visibility" || event.data?.kind !== "launcher") return;
      if (event.data.open === true) {
        fetchApps();
        return;
      }
      setQuery("");
      setOpenFolderId(null);
      setEditMode(false);
    };
    window.addEventListener("message", handleVisibility);
    return () => window.removeEventListener("message", handleVisibility);
  }, [embedded, fetchApps]);

  const allWithUrl = useMemo(() => apps.filter((a) => a.url), [apps]);
  const membersOf = useMemo(() => {
    const m = new Map<string, LauncherApp[]>();
    for (const a of allWithUrl) if (a.folder_id) { const arr = m.get(a.folder_id) ?? []; arr.push(a); m.set(a.folder_id, arr); }
    return m;
  }, [allWithUrl]);
  const validFolders = useMemo(() => folders.filter((f) => (membersOf.get(f.id)?.length ?? 0) > 0), [folders, membersOf]);
  const looseApps = useMemo(() => allWithUrl.filter((a) => !a.folder_id), [allWithUrl]);

  // One unified ordered grid of apps + folders.
  const gridItems: GridItem[] = useMemo(() => {
    const items: GridItem[] = [
      ...looseApps.map((a) => ({ kind: "app" as const, id: a.id, order: a.order ?? 999, app: a })),
      ...validFolders.map((f) => ({ kind: "folder" as const, id: f.id, order: f.order ?? 999, folder: f, members: membersOf.get(f.id) ?? [] })),
    ];
    return items.sort((a, b) => (a.order - b.order) || (a.kind === b.kind ? 0 : a.kind === "app" ? -1 : 1) || a.id.localeCompare(b.id));
  }, [looseApps, validFolders, membersOf]);

  const q = query.trim().toLowerCase();
  const searchHits = useMemo(() => (q ? allWithUrl.filter((a) => a.name.toLowerCase().includes(q)) : []), [q, allWithUrl]);
  const searching = q.length > 0;

  const go = useCallback((href: string) => {
    if (embedded && typeof window !== "undefined" && window.top) window.top.location.href = href;
    else window.location.href = href;
  }, [embedded]);

  // ── Persistence ──
  const persistLayout = useCallback((nextApps: LauncherApp[], nextFolders: Folder[]) => {
    const body = JSON.stringify({
      folders: nextFolders.map((folder) => ({ id: folder.id, name: folder.name, order: folder.order })),
      layout: nextApps.filter((app) => app.url).map((app) => ({ id: app.id, folder_id: app.folder_id, order: app.order })),
    });
    layoutSaveQueue.current = layoutSaveQueue.current
      .catch(() => undefined)
      .then(async () => {
        const response = await fetch("/api/v1/apps/launcher/layout", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (!response.ok) throw new Error("Launcher layout was not saved");
      })
      .catch(() => { fetchApps(); });
    return layoutSaveQueue.current;
  }, [fetchApps]);
  const pruneFolders = (nextApps: LauncherApp[], base: Folder[], keepId?: string) => base.filter((f) => f.id === keepId || nextApps.some((a) => a.url && a.folder_id === f.id));

  // ── Reorder (live, then persist on drop) ──
  const reorderGrid = useCallback((draggedId: string, toIndex: number) => {
    const ids = gridItems.map((g) => g.id);
    const from = ids.indexOf(draggedId);
    if (from < 0 || from === toIndex) return;
    ids.splice(from, 1);
    ids.splice(toIndex, 0, draggedId);
    const orderMap = new Map(ids.map((id, i) => [id, i] as const));
    setApps((prev) => prev.map((a) => (orderMap.has(a.id) ? { ...a, order: orderMap.get(a.id)! } : a)));
    setFolders((prev) => prev.map((f) => (orderMap.has(f.id) ? { ...f, order: orderMap.get(f.id)! } : f)));
  }, [gridItems]);

  const persistGrid = useCallback(() => {
    const orderMap = new Map(gridItems.map((item, index) => [item.id, index] as const));
    const nextApps = apps.map((app) => orderMap.has(app.id) ? { ...app, order: orderMap.get(app.id)! } : app);
    const nextFolders = folders.map((folder) => orderMap.has(folder.id) ? { ...folder, order: orderMap.get(folder.id)! } : folder);
    void persistLayout(nextApps, nextFolders);
  }, [apps, gridItems, folders, persistLayout]);

  // ── Folder ops ──
  const createFolder = useCallback((targetId: string, draggedId: string) => {
    if (targetId === draggedId) return;
    const targetApp = apps.find((a) => a.id === targetId);
    const id = genFolderId();
    const order = targetApp?.order ?? folders.length;
    const nextApps = apps.map((a) => (a.id === targetId || a.id === draggedId ? { ...a, folder_id: id } : a));
    const nextFolders = pruneFolders(nextApps, [...folders, { id, name: t("folder"), order }], id);
    setApps(nextApps);
    setFolders(nextFolders);
    void persistLayout(nextApps, nextFolders);
  }, [apps, folders, t, persistLayout]);

  const addToFolder = useCallback((appId: string, folderId: string) => {
    if (apps.find((a) => a.id === appId)?.folder_id === folderId) return;
    const nextApps = apps.map((a) => (a.id === appId ? { ...a, folder_id: folderId } : a));
    const nextFolders = pruneFolders(nextApps, folders, folderId);
    setApps(nextApps);
    setFolders(nextFolders);
    void persistLayout(nextApps, nextFolders);
  }, [apps, folders, persistLayout]);

  const removeFromFolder = useCallback((appId: string) => {
    const maxOrder = Math.max(0, ...apps.map((a) => a.order ?? 0), ...folders.map((f) => f.order ?? 0));
    const nextApps = apps.map((a) => (a.id === appId ? { ...a, folder_id: null, order: maxOrder + 1 } : a));
    const nextFolders = pruneFolders(nextApps, folders);
    setApps(nextApps);
    setFolders(nextFolders);
    void persistLayout(nextApps, nextFolders);
    if (openFolderId && !nextFolders.some((f) => f.id === openFolderId)) setOpenFolderId(null);
  }, [apps, folders, openFolderId, persistLayout]);

  const renameFolder = useCallback((folderId: string, name: string) => {
    const nextFolders = folders.map((f) => (f.id === folderId ? { ...f, name } : f));
    setFolders(nextFolders);
    void persistLayout(apps, nextFolders);
  }, [apps, folders, persistLayout]);

  // ── Drag wiring ──
  const onMerge = useCallback((draggedId: string, targetId: string) => {
    const draggedIsApp = apps.some((a) => a.id === draggedId && !a.folder_id);
    if (!draggedIsApp) return; // only loose apps merge
    if (folders.some((f) => f.id === targetId)) addToFolder(draggedId, targetId);
    else createFolder(targetId, draggedId);
  }, [apps, folders, addToFolder, createFolder]);

  const canMerge = useCallback((draggedId: string) =>
    apps.some((a) => a.id === draggedId && !a.folder_id), [apps]);

  const drag = useGridDrag({
    order: gridItems.map((g) => g.id),
    enabled: !searching && (finePointer || editMode),
    onReorder: reorderGrid,
    onCommit: persistGrid,
    onMerge,
    canMerge,
    reorderDelayMs: 140,
  });
  const dragEnabled = !searching && (finePointer || editMode);

  const openFolder = openFolderId ? validFolders.find((f) => f.id === openFolderId) : null;
  const openMembers = openFolderId ? membersOf.get(openFolderId) ?? [] : [];
  const labelCls = "line-clamp-1 w-[88px] text-xs font-semibold text-foreground/90";

  // Dragged-item ghost (portaled to body).
  const draggedItem = drag.draggingId ? gridItems.find((g) => g.id === drag.draggingId) : null;
  const ghost = drag.ghost && draggedItem && typeof document !== "undefined"
    ? createPortal(
        <div className="pointer-events-none fixed z-[200] -translate-x-1/2 -translate-y-1/2 opacity-90" style={{ left: drag.ghost.x, top: drag.ghost.y }}>
          {draggedItem.kind === "app"
            ? <LauncherTile icon={draggedItem.app.icon} customIconUrl={draggedItem.app.custom_icon_url} />
            : <FolderPreview members={draggedItem.members} />}
        </div>,
        document.body
      )
    : null;

  const renderApp = (app: LauncherApp) => {
    const dragging = drag.draggingId === app.id;
    const merge = drag.mergeTargetId === app.id;
    const off = app.status === "stopped";
    const unavailable = off || app.status === "unhealthy";
    return (
      <button
        key={app.id}
        type="button"
        ref={drag.register(app.id)}
        onPointerDown={(e) => drag.startDrag(e, app.id)}
        onMouseDown={(e) => drag.startDrag(e, app.id)}
        onClick={() => { if (!drag.consumeClick() && app.url && !off) go(app.url); }}
        className={`relative grid select-none justify-items-center gap-2 rounded-xl p-1 text-center transition-[transform,opacity] hover:scale-105 ${dragEnabled ? "touch-none cursor-grab active:cursor-grabbing" : "touch-pan-y"} ${unavailable ? "opacity-40 grayscale" : ""} ${dragging ? "scale-95 opacity-30" : ""} ${merge ? "scale-110" : ""}`}
        title={off ? `${app.name} is off` : app.name}
      >
        {off && <span className="absolute left-2 top-2 h-1.5 w-1.5 rounded-full bg-destructive"><span className="sr-only">Off</span></span>}
        <div className={merge ? "rounded-2xl ring-2 ring-primary ring-offset-2 ring-offset-transparent" : ""}>
          <LauncherTile icon={app.icon} customIconUrl={app.custom_icon_url} />
        </div>
        <b className={labelCls}>{app.name}</b>
      </button>
    );
  }

  const renderFolder = (folder: Folder, members: LauncherApp[]) => {
    const dragging = drag.draggingId === folder.id;
    const merge = drag.mergeTargetId === folder.id;
    return (
      <button
        key={folder.id}
        type="button"
        ref={drag.register(folder.id)}
        onPointerDown={(e) => drag.startDrag(e, folder.id)}
        onMouseDown={(e) => drag.startDrag(e, folder.id)}
        onClick={() => { if (!drag.consumeClick()) setOpenFolderId(folder.id); }}
        className={`grid select-none justify-items-center gap-2 rounded-xl p-1 text-center transition-[transform,opacity] hover:scale-105 ${dragEnabled ? "touch-none cursor-grab active:cursor-grabbing" : "touch-pan-y"} ${dragging ? "scale-95 opacity-30" : ""} ${merge ? "scale-110" : ""}`}
        title={folder.name}
      >
        <div className={merge ? "rounded-2xl ring-2 ring-primary ring-offset-2 ring-offset-transparent" : ""}>
          <FolderPreview members={members} />
        </div>
        <b className={labelCls}>{folder.name}</b>
      </button>
    );
  }

  return (
    <div className="relative flex h-full w-full flex-col items-center gap-8 overflow-y-auto px-6 pb-6 pt-9">
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Close" className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full border bg-card/60 text-muted-foreground transition-colors hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      )}

      <div className="flex w-[min(500px,90%)] items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchApps")} className="h-11 w-full rounded-full border bg-card/70 pl-11 pr-4 text-sm outline-none focus:ring-2 focus:ring-ring" />
        </div>
        {!finePointer && <button type="button" onClick={() => { setEditMode((value) => !value); setQuery(""); }} className={`grid h-11 w-11 place-items-center rounded-full border ${editMode ? "bg-primary text-primary-foreground" : "bg-card/70 text-muted-foreground"}`} aria-label={editMode ? "Done rearranging launcher" : "Rearrange launcher"}>{editMode ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}</button>}
      </div>

      {!loaded ? (
        <div className="grid w-full max-w-3xl grid-cols-[repeat(auto-fill,minmax(84px,96px))] justify-center gap-x-9 gap-y-7" aria-busy="true">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="grid justify-items-center gap-2 rounded-xl p-1">
              <div className="h-16 w-16 animate-pulse rounded-2xl bg-muted" />
              <div className="h-3 w-16 animate-pulse rounded bg-muted/70" />
            </div>
          ))}
        </div>
      ) : loadError ? (
        <div className="mt-6 grid justify-items-center gap-3 text-sm text-muted-foreground">
          <p>Apps could not be loaded.</p>
          <button type="button" onClick={() => window.location.reload()} className="text-primary hover:underline">Retry</button>
        </div>
      ) : (searching ? searchHits.length === 0 : gridItems.length === 0) ? (
        <p className="mt-6 text-sm text-muted-foreground">{t("noAppsFound")}</p>
      ) : (
        <div className="grid w-full max-w-3xl grid-cols-[repeat(auto-fill,minmax(84px,96px))] justify-center gap-x-9 gap-y-7">
          {searching
            ? searchHits.map((app) => (
                <button key={app.id} type="button" onClick={() => app.url && go(app.url)} className="grid justify-items-center gap-2 rounded-xl p-1 text-center transition-transform hover:scale-105" title={app.name}>
                  <LauncherTile icon={app.icon} customIconUrl={app.custom_icon_url} />
                  <b className={labelCls}>{app.name}</b>
                </button>
              ))
            : gridItems.map((g) => (g.kind === "app" ? renderApp(g.app) : renderFolder(g.folder, g.members)))}
        </div>
      )}

      <p className="mt-auto text-xs text-muted-foreground/80">{t("launcherHint")}</p>

      {openFolder && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-background/50 p-6 backdrop-blur-md" onClick={() => setOpenFolderId(null)}>
          <div className="w-[min(380px,92%)] rounded-3xl border border-border/50 bg-popover/85 p-6 shadow-2xl backdrop-blur-xl" onClick={(e) => e.stopPropagation()}>
            <input value={openFolder.name} onChange={(e) => renameFolder(openFolder.id, e.target.value)} aria-label={t("folder")} className="mb-5 w-full rounded-lg bg-transparent text-center text-sm font-semibold text-foreground/80 outline-none focus:bg-accent/40" />
            <div className="grid grid-cols-3 justify-items-center gap-4">
              {openMembers.map((m) => (
                <div key={m.id} className="group relative">
                  <button type="button" onClick={() => m.url && go(m.url)} className="grid justify-items-center gap-1.5 rounded-xl p-1 text-center transition-transform hover:scale-105" title={m.name}>
                    <LauncherTile icon={m.icon} customIconUrl={m.custom_icon_url} />
                    <b className="line-clamp-1 w-[72px] text-xs font-medium text-foreground/90">{m.name}</b>
                  </button>
                  <button type="button" aria-label={t("removeFromFolder")} title={t("removeFromFolder")} onClick={() => removeFromFolder(m.id)} className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors hover:text-danger">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {ghost}
    </div>
  );
}
