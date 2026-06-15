"use client";

import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentType, CSSProperties } from "react";
import * as LucideIcons from "lucide-react";
import { AlertCircle, ArrowLeft, ChevronRight, ExternalLink, Info, Loader2, Network, Palette, RefreshCw, RotateCcw, Shield, Sliders, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import WordArtPickerInline from "@/components/setup/WordArtPickerInline";
import type { SiteNameStyle } from "@/lib/wordart-presets";
import { uiSettingsApi } from "./api-base";

interface DrawerApp {
  id: string;
  name: string;
  original_name?: string;
  icon: string | null;
  custom_icon_url?: string | null;
  visible: boolean;
  status: string | null;
  url?: string | null;
  subdomain?: string | null;
  containerUrl?: string | null;
  hasSettingsPanel?: boolean;
}

interface UnifiedApp {
  id: string;
  displayName: string;
  description: string;
  icon: string;
  category: "system" | "infrastructure" | "user";
  type: string;
  containers: Array<{ name: string; status: string; ip?: string; canControl: boolean }>;
  version?: string;
  status: string;
  updateAvailable: boolean;
  updateInfo?: string;
  systemManaged?: boolean;
}

interface UpdateStatus {
  component: string;
  status: string;
  message: string;
  progress: number;
  version_after?: string | null;
  error?: string | null;
}

interface Permission {
  id: string;
  appId: string;
  permission: string;
  descriptor?: {
    permission: string;
    title: string;
    description: string;
    category: string;
    risk: string;
  };
  granted: boolean;
  grantType: string | null;
  grantedAt?: string | null;
  scopes?: string[];
}

type AppTab = "app-settings" | "overview" | "branding" | "permissions" | "network" | "link-handling";
type BrandingScope = "user" | "server";

const DEFAULT_APP_WORDART: SiteNameStyle = {
  fontFamily: "Montserrat",
  fontSize: "1.5rem",
  fontWeight: 800,
  letterSpacing: "0.02em",
  color: "#ffffff",
  gradient: null,
  textShadow: "none",
  textTransform: "none",
};

function StatusDot({ status }: { status?: string | null }) {
  const color = status === "running" ? "bg-green-500" : status === "partial" ? "bg-amber-500" : status === "stopped" ? "bg-red-500" : "bg-muted-foreground";
  return <span className={`h-[5px] w-[5px] shrink-0 rounded-full ${color}`} />;
}

function kebabToPascal(value: string) {
  return value.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

function getLucideIcon(name: string): ComponentType<{ className?: string; style?: CSSProperties }> | null {
  const direct = (LucideIcons as Record<string, unknown>)[name];
  if (
    typeof direct === "function" ||
    (typeof direct === "object" && direct !== null && "$$typeof" in direct)
  ) {
    return direct as ComponentType<{ className?: string; style?: CSSProperties }>;
  }
  const pascal = (LucideIcons as Record<string, unknown>)[kebabToPascal(name)];
  return (
    typeof pascal === "function" ||
    (typeof pascal === "object" && pascal !== null && "$$typeof" in pascal)
  )
    ? pascal as ComponentType<{ className?: string; style?: CSSProperties }>
    : null;
}

function AppIcon({ app }: { app: DrawerApp | UnifiedApp }) {
  const [imgError, setImgError] = useState(false);
  const name = "name" in app ? app.name : app.displayName;
  const icon = "custom_icon_url" in app ? app.custom_icon_url || app.icon : app.icon;
  const Icon = icon && !imgError ? getLucideIcon(icon) : null;

  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-accent">
      {icon?.startsWith("emoji:") ? (
        <span className="text-lg">{icon.slice(6)}</span>
      ) : icon && (icon.startsWith("/") || icon.startsWith("http") || icon.startsWith("data:")) ? (
        // eslint-disable-next-line @next/next/no-img-element
        !imgError ? <img src={icon} alt="" className="h-9 w-9 rounded-lg object-cover" onError={() => setImgError(true)} /> : <span className="text-sm font-bold text-muted-foreground">{name.charAt(0).toUpperCase()}</span>
      ) : Icon ? (
        <Icon className="h-5 w-5 text-foreground/80" />
      ) : (
        <span className="text-sm font-bold text-muted-foreground">{name.charAt(0).toUpperCase()}</span>
      )}
    </div>
  );
}

function tabClass(active: boolean) {
  return `flex items-center gap-2 border-b-2 pb-3 text-sm font-medium transition-colors ${
    active
      ? "border-primary text-foreground"
      : "border-transparent text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground"
  }`;
}

function identityConsentApi(appId: string): string {
  const path = `/identity/consents/app/${encodeURIComponent(appId)}`;
  if (typeof window !== "undefined" && window.location.pathname.startsWith("/settings")) {
    return `/settings/api${path}`;
  }
  return `/api${path}`;
}

function updateStatusComponent(appId: string): string {
  if (appId === "control-panel") return "control";
  if (appId === "host-system") return "system";
  return appId;
}

function permissionTitle(permission: Permission) {
  return permission.descriptor?.title || permission.permission;
}

function permissionDescription(permission: Permission) {
  if (permission.descriptor?.description) return permission.descriptor.description;
  return "This app has this YouEye permission.";
}

function InstalledAppsList({ onOpen }: { onOpen: (id: string) => void }) {
  const [apps, setApps] = useState<DrawerApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(uiSettingsApi("apps/drawer"));
      if (!res.ok) throw new Error("Failed to load apps");
      const data = await res.json();
      setApps(data.apps || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load apps");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const host = typeof window !== "undefined" ? window.location.hostname : "";

  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center justify-between px-[18px] py-3">
        <h2 className="text-[15px] font-semibold">Installed apps</h2>
        <a href="/market" className="text-[13px] font-medium text-primary hover:underline">Open Market</a>
      </div>
      {loading ? (
        <div className="flex items-center justify-center gap-2 border-t py-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading apps…</div>
      ) : error ? (
        <div className="border-t py-12 text-center text-sm text-muted-foreground"><AlertCircle className="mx-auto mb-2 h-6 w-6 opacity-50" />{error}</div>
      ) : apps.length === 0 ? (
        <div className="border-t py-10 text-center text-sm text-muted-foreground">No apps installed yet.</div>
      ) : (
        apps.map((app) => {
          const known = app.status && app.status !== "unknown";
          return (
            <button
              key={app.id}
              onClick={() => onOpen(app.id)}
              className="flex w-full items-center gap-3 border-t px-[18px] py-3 text-left transition-colors hover:bg-accent/40"
            >
              <AppIcon app={app} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{app.name}</div>
                {app.subdomain && (
                  <div className="truncate text-[13px] text-muted-foreground">{host ? `${app.subdomain}.${host}` : app.subdomain}</div>
                )}
              </div>
              {known && (
                <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                  <StatusDot status={app.status} />
                  {app.status}
                </span>
              )}
              <span className="hidden text-[13px] font-medium text-muted-foreground sm:inline">Manage</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/40" />
            </button>
          );
        })
      )}
    </section>
  );
}

function AdminAppSections({ onOpen }: { onOpen: (id: string) => void }) {
  const [apps, setApps] = useState<UnifiedApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [statuses, setStatuses] = useState<Map<string, UpdateStatus>>(new Map());
  const [confirmApp, setConfirmApp] = useState<UnifiedApp | null>(null);
  const [maintAck, setMaintAck] = useState(false);
  const [dbAck, setDbAck] = useState(false);
  const updates = apps.filter((app) => app.updateAvailable);
  const systemApps = apps.filter((app) => app.category !== "user");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/apps/unified");
    const data = res.ok ? await res.json() : { apps: [] };
    setApps(data.apps || []);
    setLoading(false);
  }, []);

  const loadStatuses = useCallback(async () => {
    const res = await fetch("/api/updates/status");
    if (!res.ok) return;
    const data = await res.json();
    const next = new Map<string, UpdateStatus>();
    for (const status of data.statuses || []) {
      next.set(status.component, status);
    }
    setStatuses(next);
  }, []);

  useEffect(() => { load(); loadStatuses(); }, [load, loadStatuses]);

  useEffect(() => {
    const active = Array.from(statuses.values()).some((status) => !["idle", "completed", "failed"].includes(status.status));
    if (!active) return;
    const timer = window.setInterval(() => {
      loadStatuses().catch((err) => console.warn("Failed to refresh update status", err));
      load().catch((err) => console.warn("Failed to refresh apps while updating", err));
    }, 2000);
    return () => window.clearInterval(timer);
  }, [load, loadStatuses, statuses]);

  async function checkUpdates() {
    setChecking(true);
    await fetch("/api/apps/check-updates", { method: "POST" }).catch(() => {});
    await load();
    setChecking(false);
  }

  function openConfirm(app: UnifiedApp) {
    setMaintAck(false);
    setDbAck(false);
    setConfirmApp(app);
  }

  async function updateApp(
    appId: string,
    confirm?: { confirmMaintenanceWindow: boolean; confirmContainerName: string; allowDatabaseUpdate?: boolean },
  ) {
    const component = updateStatusComponent(appId);
    setStatuses((prev) => {
      const next = new Map(prev);
      next.set(component, {
        component,
        status: "checking",
        progress: 0,
        message: "Starting update...",
      });
      return next;
    });

    let csrfToken: string;
    try {
      csrfToken = await fetch("/settings/api/auth/csrf")
        .then((res) => res.ok ? res.json() : Promise.reject(new Error("Could not start update")))
        .then((body) => body.csrfToken as string);
    } catch (err) {
      setStatuses((prev) => {
        const next = new Map(prev);
        const message = err instanceof Error ? err.message : "Could not start update";
        next.set(component, {
          component,
          status: "failed",
          progress: 100,
          message,
          error: message,
        });
        return next;
      });
      return;
    }

    fetch(`/settings/api/apps/${encodeURIComponent(appId)}/update`, {
      method: "POST",
      headers: confirm
        ? { "X-CSRF-Token": csrfToken, "Content-Type": "application/json" }
        : { "X-CSRF-Token": csrfToken },
      ...(confirm ? { body: JSON.stringify(confirm) } : {}),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "Update failed" }));
          setStatuses((prev) => {
            const next = new Map(prev);
            next.set(component, {
              component,
              status: "failed",
              progress: 100,
              message: body.error || "Update failed",
              error: body.error || "Update failed",
            });
            return next;
          });
        }
        await loadStatuses();
        await load();
      })
      .catch((err) => {
        setStatuses((prev) => {
          const next = new Map(prev);
          next.set(component, {
            component,
            status: "failed",
            progress: 100,
            message: err instanceof Error ? err.message : "Update failed",
            error: err instanceof Error ? err.message : "Update failed",
          });
          return next;
        });
      });
  }

  if (loading) return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <>
      {confirmApp && (
        <ConfirmDialog
          open
          title={`Update ${confirmApp.displayName}?`}
          description={`This briefly stops and rebuilds ${confirmApp.displayName} (${confirmApp.containers[0]?.name ?? "its container"}) to the version pinned in the Market manifest. The service will be unavailable for a few seconds.`}
          confirmLabel="Update now"
          confirmDisabled={!maintAck || (confirmApp.id === "postgres" && !dbAck)}
          onCancel={() => setConfirmApp(null)}
          onConfirm={() => {
            const app = confirmApp;
            setConfirmApp(null);
            updateApp(app.id, {
              confirmMaintenanceWindow: true,
              confirmContainerName: app.containers[0]?.name ?? "",
              allowDatabaseUpdate: app.id === "postgres" ? dbAck : undefined,
            });
          }}
        >
          <label className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" checked={maintAck} onChange={(e) => setMaintAck(e.target.checked)} className="mt-0.5" />
            <span>I understand this restarts the service.</span>
          </label>
          {confirmApp.id === "postgres" && (
            <label className="flex items-start gap-2 text-[13px]">
              <input type="checkbox" checked={dbAck} onChange={(e) => setDbAck(e.target.checked)} className="mt-0.5" />
              <span>I understand the database will restart; this is a patch update within PostgreSQL 17.</span>
            </label>
          )}
        </ConfirmDialog>
      )}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">{updates.length > 0 ? "Updates Available" : "Updates"}</h3>
            <p className="text-[13px] text-muted-foreground">{updates.length} {updates.length === 1 ? "update" : "updates"} found.</p>
          </div>
          <Button variant="outline" size="sm" onClick={checkUpdates} disabled={checking}>
            {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {checking ? "Checking" : "Check for Updates"}
          </Button>
        </div>
        {updates.length > 0 && (
          <div className="space-y-1.5">
            {updates.map((app) => {
              const component = updateStatusComponent(app.id);
              const status = statuses.get(component);
              const isUpdating = !!status && !["idle", "completed", "failed"].includes(status.status);
              return (
                <div key={app.id} className="rounded-lg border px-3.5 py-2.5">
                  <div className="flex w-full items-center gap-3">
                    <button type="button" onClick={() => onOpen(app.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                      <AppIcon app={app} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium">{app.displayName}</p>
                        <p className="text-xs text-muted-foreground">{app.updateInfo || "Update available"}</p>
                      </div>
                    </button>
                    <Button size="sm" onClick={() => (app.systemManaged ? openConfirm(app) : updateApp(app.id))} disabled={isUpdating}>
                      {isUpdating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                      {isUpdating ? "Updating" : "Update"}
                    </Button>
                  </div>
                  {status && status.status !== "idle" && (
                    <div className="mt-2 space-y-1">
                      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span className="truncate">{status.message}</span>
                        <span>{Math.max(0, Math.min(100, status.progress || 0))}%</span>
                      </div>
                      {isUpdating && (
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.max(4, Math.min(100, status.progress || 0))}%` }} />
                        </div>
                      )}
                      {status.status === "failed" && status.error && <p className="text-xs text-destructive">{status.error}</p>}
                      {status.status === "completed" && <p className="text-xs text-green-600">Update complete{status.version_after ? `: v${status.version_after}` : ""}</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-base font-semibold">System Components</h3>
          <p className="text-[13px] text-muted-foreground">Core services and infrastructure managed by YouEye.</p>
        </div>
        <div className="space-y-1.5">
          {systemApps.map((app) => (
            <button key={app.id} onClick={() => onOpen(app.id)} className="flex w-full items-center gap-3 rounded-lg border px-3.5 py-2.5 text-left hover:bg-accent/40">
              <AppIcon app={app} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-[13px] font-medium">{app.displayName}</p>
                  {app.version && <span className="font-mono text-xs text-muted-foreground">v{app.version}</span>}
                </div>
                <div className="mt-0.5 flex items-center gap-1"><StatusDot status={app.status} /><span className="text-xs text-muted-foreground">{app.status}</span></div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

function AppSettingsEmbed({ app }: { app: DrawerApp }) {
  const [iframeHeight, setIframeHeight] = useState(420);
  const settingsUrl = useMemo(() => {
    if (app.url) {
      try {
        return `${new URL(app.url).origin}/settings?embed=true`;
      } catch {}
    }
    if (app.subdomain && typeof window !== "undefined") {
      return `${window.location.protocol}//${app.subdomain}.${window.location.hostname}/settings?embed=true`;
    }
    return "";
  }, [app.subdomain, app.url]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "youeye-app-settings-resize" && typeof event.data.height === "number") {
        setIframeHeight(Math.max(220, event.data.height));
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  if (!settingsUrl) {
    return <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">No app settings URL is available.</div>;
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      <iframe
        src={settingsUrl}
        className="w-full border-0"
        style={{ height: iframeHeight, minHeight: 220 }}
        title={`${app.name} Settings`}
        allow="clipboard-write"
      />
    </div>
  );
}

function AppDetail({ appId, isAdmin, hasUserContext, onBack }: { appId: string; isAdmin: boolean; hasUserContext: boolean; onBack: () => void }) {
  const [tab, setTab] = useState<AppTab>("overview");
  const [drawerApps, setDrawerApps] = useState<DrawerApp[]>([]);
  const [unifiedApps, setUnifiedApps] = useState<UnifiedApp[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);
  const drawerApp = drawerApps.find((app) => app.id === appId);
  const unifiedApp = unifiedApps.find((app) => app.id === appId);
  const title = drawerApp?.name || unifiedApp?.displayName || appId;

  const load = useCallback(async () => {
      const [drawerRes, unifiedRes, permissionRes, identityPermissionRes] = await Promise.all([
        hasUserContext ? fetch(uiSettingsApi("apps/drawer")) : Promise.resolve(null),
        fetch("/api/apps/unified"),
        hasUserContext ? fetch(uiSettingsApi(`permissions/app/${encodeURIComponent(appId)}`)) : Promise.resolve(null),
        hasUserContext ? fetch(identityConsentApi(appId)) : Promise.resolve(null),
      ]);
      if (drawerRes?.ok) setDrawerApps((await drawerRes.json()).apps || []);
      if (unifiedRes.ok) setUnifiedApps((await unifiedRes.json()).apps || []);
      const uiPermissions = permissionRes?.ok ? ((await permissionRes.json()).permissions || []) : [];
      const identityPermissions = identityPermissionRes?.ok ? ((await identityPermissionRes.json()).permissions || []) : [];
      setPermissions([...identityPermissions, ...uiPermissions]);
      setLoading(false);
  }, [appId]);

  useEffect(() => {
    load().catch(() => setLoading(false));
  }, [load]);

  async function revokeAppPermission(permission: string) {
    const isIdentityConsent = permission === "identity:youeye-id:sign-in";
    const res = isIdentityConsent
      ? await fetch(identityConsentApi(appId), { method: "DELETE" })
      : await fetch(uiSettingsApi(`permissions/app/${encodeURIComponent(appId)}`), {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ permission }),
        });
    if (res.ok) {
      setPermissions((items) => items.filter((item) => item.permission !== permission));
    }
  }

  async function revokeAllPermissions() {
    const [uiRes, identityRes] = await Promise.all([
      fetch(uiSettingsApi(`permissions/app/${encodeURIComponent(appId)}`), { method: "DELETE" }),
      fetch(identityConsentApi(appId), { method: "DELETE" }),
    ]);
    if (uiRes.ok || identityRes.ok) setPermissions([]);
  }

  const hasAppSettings = hasUserContext && !!drawerApp?.hasSettingsPanel && (!!drawerApp.url || !!drawerApp.subdomain);
  const tabs = [
    { id: "app-settings", label: "App Settings", icon: <Sliders className="h-4 w-4" />, userOnly: true, hide: !hasAppSettings },
    { id: "overview", label: "Overview", icon: <Info className="h-4 w-4" /> },
    { id: "branding", label: "Branding", icon: <Palette className="h-4 w-4" />, userOnly: true },
    { id: "permissions", label: "Permissions", icon: <Shield className="h-4 w-4" />, userOnly: true },
    { id: "network", label: "Network", icon: <Network className="h-4 w-4" />, adminOnly: true },
    { id: "link-handling", label: "Link Handling", icon: <Unplug className="h-4 w-4" />, userOnly: true },
  ] satisfies Array<{ id: AppTab; label: string; icon: React.ReactNode; adminOnly?: boolean; userOnly?: boolean; hide?: boolean }>;
  const visibleTabs = tabs.filter((item) => (!item.adminOnly || isAdmin) && (!item.userOnly || hasUserContext) && !item.hide);

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-6">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        Back to Apps
      </button>

      <div className="flex items-center gap-3">
        <AppIcon app={drawerApp || unifiedApp || { id: appId, displayName: title, description: "", icon: "", category: "user", type: "", containers: [], status: "unknown", updateAvailable: false }} />
        <div>
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{unifiedApp?.description || "App settings and permissions."}</p>
        </div>
      </div>

      <div className="border-b">
        <nav className="flex flex-wrap gap-6" aria-label="App settings tabs">
          {visibleTabs.map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={tabClass(tab === item.id)}>{item.icon}{item.label}</button>)}
        </nav>
      </div>

      {tab === "app-settings" && (
        drawerApp && hasAppSettings
          ? <AppSettingsEmbed app={drawerApp} />
          : <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">No app settings panel is available.</div>
      )}

      {tab === "overview" && (
        <div className="rounded-lg border divide-y">
          <div className="grid gap-4 p-4 text-sm sm:grid-cols-2">
            <div><span className="text-muted-foreground">Status</span><p className="font-medium">{unifiedApp?.status || drawerApp?.status || "unknown"}</p></div>
            <div><span className="text-muted-foreground">Version</span><p className="font-medium">{unifiedApp?.version || "—"}</p></div>
            <div><span className="text-muted-foreground">Type</span><p className="font-medium">{unifiedApp?.type || "app"}</p></div>
            <div><span className="text-muted-foreground">URL</span><p className="font-medium">{drawerApp?.url ? <a className="inline-flex items-center gap-1 text-primary hover:underline" href={drawerApp.url}><ExternalLink className="h-3 w-3" /> Open</a> : "—"}</p></div>
          </div>
          {unifiedApp?.containers?.map((container) => (
            <div key={container.name} className="flex items-center justify-between p-4 text-sm">
              <div><p className="font-medium">{container.name}</p><p className="text-xs text-muted-foreground">{container.ip || "No IP"}</p></div>
              <Badge variant="outline">{container.status}</Badge>
            </div>
          ))}
        </div>
      )}

      {tab === "branding" && <AppBranding appId={appId} isAdmin={isAdmin} appName={title} />}

      {tab === "permissions" && (
        <div className="space-y-3">
          {permissions.length > 0 && (
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={revokeAllPermissions}>Revoke All</Button>
            </div>
          )}
          {permissions.length === 0 ? (
            <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">No permissions granted.</div>
          ) : permissions.map((permission) => (
            <div key={permission.id || permission.permission} className="flex items-start justify-between gap-3 rounded-md bg-accent/30 px-3 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{permissionTitle(permission)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{permissionDescription(permission)}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {permission.descriptor?.category && <Badge variant="outline">{permission.descriptor.category}</Badge>}
                  {permission.descriptor?.risk && <Badge variant="outline">{permission.descriptor.risk} risk</Badge>}
                  <Badge variant="outline">{permission.grantType || "granted"}</Badge>
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{permission.permission}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => revokeAppPermission(permission.permission)}>Revoke</Button>
            </div>
          ))}
        </div>
      )}

      {tab === "network" && isAdmin && (
        <div className="rounded-lg border p-4 text-sm text-muted-foreground">
          Direct access and subdomain networking are managed by Control Panel. Container details are shown in Overview.
        </div>
      )}

      {tab === "link-handling" && (
        <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">No link handlers registered.</div>
      )}
    </div>
  );
}

function AppBranding({ appId, appName, isAdmin }: { appId: string; appName: string; isAdmin: boolean }) {
  const [tab, setTab] = useState<"my-branding" | "server-default">("my-branding");
  return (
    <div className="space-y-6">
      <div className="flex gap-1 border-b">
        <button className={tabClass(tab === "my-branding")} onClick={() => setTab("my-branding")}>My Branding</button>
        {isAdmin && <button className={tabClass(tab === "server-default")} onClick={() => setTab("server-default")}>Server Default</button>}
      </div>
      {tab === "my-branding" && <AppBrandingEditor appId={appId} appName={appName} scope="user" />}
      {tab === "server-default" && isAdmin && <AppBrandingEditor appId={appId} appName={appName} scope="server" />}
    </div>
  );
}

function AppBrandingEditor({ appId, appName, scope }: { appId: string; appName: string; scope: BrandingScope }) {
  const [style, setStyle] = useState<SiteNameStyle>(DEFAULT_APP_WORDART);
  const [headerDisplayMode, setHeaderDisplayMode] = useState("logo-text");
  const [customName, setCustomName] = useState("");
  const [customIconUrl, setCustomIconUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const isUser = scope === "user";
  const endpoint = uiSettingsApi(`apps/branding/${scope}/${encodeURIComponent(appId)}`);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(endpoint);
    if (res.ok) {
      const data = await res.json();
      setStyle(data.brandingWordart ?? DEFAULT_APP_WORDART);
      setHeaderDisplayMode(data.headerDisplayMode ?? "logo-text");
      setCustomName(data.customName ?? data.originalName ?? appName);
      setCustomIconUrl(data.customIconUrl ?? "");
    }
    setLoading(false);
  }, [appName, endpoint]);

  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);

  async function save() {
    setSaving(true);
    const payload: Record<string, unknown> = {
      brandingWordart: style,
      headerDisplayMode,
    };
    if (isUser) {
      payload.customName = customName.trim() || null;
      payload.customIconUrl = customIconUrl.trim() || null;
    }
    const res = await fetch(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setStatus(res.ok ? "Saved" : "Save failed");
    setSaving(false);
  }

  async function reset() {
    setSaving(true);
    const res = await fetch(endpoint, { method: "DELETE" });
    setStatus(res.ok ? "Reset" : "Reset failed");
    await load();
    setSaving(false);
  }

  if (loading) return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">{isUser ? "My Branding" : "Server Default"}</h3>
        <p className="text-[13px] text-muted-foreground">
          {isUser ? "Customize how this app appears for your account." : "Set the default app branding seen before a user adds their own override."}
        </p>
      </div>

      {isUser && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Display name</span>
            <input value={customName} onChange={(event) => setCustomName(event.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Custom icon URL</span>
            <input value={customIconUrl} onChange={(event) => setCustomIconUrl(event.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder="https://..." />
          </label>
        </div>
      )}

      <label className="space-y-1.5 text-sm">
        <span className="font-medium">Header display</span>
        <select value={headerDisplayMode} onChange={(event) => setHeaderDisplayMode(event.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm sm:max-w-xs">
          <option value="logo-text">Icon and name</option>
          <option value="logo-only">Icon only</option>
          <option value="text-only">Name only</option>
        </select>
      </label>

      <WordArtPickerInline siteName={customName || appName} style={style} setStyle={setStyle} />

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Save</Button>
        {isUser && (
          <Button size="sm" variant="outline" onClick={reset} disabled={saving}>
            <RotateCcw className="h-4 w-4" />
            Reset
          </Button>
        )}
        {status && <span className="text-sm text-muted-foreground">{status}</span>}
      </div>
    </div>
  );
}

export function AppsClient({ isAdmin, hasUserContext = true, initialAppId }: { isAdmin: boolean; hasUserContext?: boolean; initialAppId?: string }) {
  const [selectedApp, setSelectedApp] = useState<string | null>(initialAppId || null);

  const urlApp = useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("app");
  }, []);

  useEffect(() => {
    if (urlApp) setSelectedApp(urlApp);
  }, [urlApp]);

  if (selectedApp) {
    return <AppDetail appId={selectedApp} isAdmin={isAdmin} hasUserContext={hasUserContext} onBack={() => setSelectedApp(null)} />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Apps</h2>
        <p className="mt-1 text-sm text-muted-foreground">Apps installed on this server and how they behave for you</p>
      </div>
      {hasUserContext && <InstalledAppsList onOpen={setSelectedApp} />}
      {isAdmin && <AdminAppSections onOpen={setSelectedApp} />}
    </div>
  );
}
