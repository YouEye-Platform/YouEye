"use client";

import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentType, CSSProperties } from "react";
import Link from "next/link";
import * as LucideIcons from "lucide-react";
import { AlertCircle, ArrowLeft, ChevronRight, ExternalLink, GitBranch, Info, Loader2, Network, Palette, Power, PowerOff, RefreshCw, RotateCcw, Shield, Sliders, Sparkles, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import WordArtPickerInline from "@/components/setup/WordArtPickerInline";
import type { SiteNameStyle } from "@/lib/wordart-presets";
import { uiSettingsApi } from "./api-base";
import { UpdateChannels } from "./update-channels";

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
  platform?: boolean;
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
  enabled?: boolean;
  desiredState?: "running" | "stopped";
  databaseMode?: "shared" | "own" | "none";
  updateAvailable: boolean;
  updateInfo?: string;
  systemManaged?: boolean;
  healthStatus?: "healthy" | "unhealthy" | "unknown";
  appHealthState?: "starting" | "running" | "unhealthy" | "crash-looping" | "unknown";
  failingLevel?: "L1" | "L2" | "L3";
  healthDetail?: string | null;
  healthCheckedAt?: string | null;
  autoRestart?: boolean;
  updateChannelKey?: string;
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

type AppTab = "app-settings" | "overview" | "ai" | "branding" | "permissions" | "network" | "link-handling" | "update-channel";
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

function isAppOff(app?: UnifiedApp | null) {
  return !!app && (app.enabled === false || app.desiredState === "stopped" || app.status === "stopped");
}

function OffDot() {
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" aria-hidden />;
}

function appHealthLabel(app?: UnifiedApp | null) {
  if (!app?.appHealthState || app.appHealthState === "unknown") return null;
  return app.failingLevel ? `${app.appHealthState} (${app.failingLevel})` : app.appHealthState;
}

function appHealthVariant(app?: UnifiedApp | null): "default" | "secondary" | "destructive" | "outline" {
  switch (app?.appHealthState) {
    case "running":
      return "secondary";
    case "unhealthy":
    case "crash-looping":
      return "destructive";
    case "starting":
      return "outline";
    default:
      return "outline";
  }
}

async function fetchCSRFToken(): Promise<string> {
  const res = await fetch("/settings/api/auth/csrf");
  if (!res.ok) throw new Error("Could not prepare the request");
  const body = await res.json();
  return body.csrfToken as string;
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

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    setError("");
    try {
      const res = await fetch(uiSettingsApi("apps/drawer"));
      if (!res.ok) throw new Error("Failed to load apps");
      const data = await res.json();
      setApps((data.apps || []).filter((app: DrawerApp) => !app.platform));
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
        <Link href="/market" className="text-[13px] font-medium text-primary hover:underline">Open Market</Link>
      </div>
      {loading ? (
        <div className="flex items-center justify-center gap-2 border-t py-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading apps…</div>
      ) : error ? (
        <div className="border-t py-12 text-center text-sm text-muted-foreground"><AlertCircle className="mx-auto mb-2 h-6 w-6 opacity-50" />{error}</div>
      ) : apps.length === 0 ? (
        <div className="border-t py-10 text-center text-sm text-muted-foreground">No apps installed yet.</div>
      ) : (
        apps.map((app) => {
          const off = app.status === "stopped";
          return (
            <button
              key={app.id}
              onClick={() => onOpen(app.id)}
              className="flex w-full items-center gap-3 border-t px-[18px] py-3 text-left transition-colors hover:bg-accent/40"
            >
              <AppIcon app={app} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <div className="truncate text-sm font-medium">{app.name}</div>
                  {off && <><OffDot /><span className="sr-only">Off</span></>}
                </div>
                {app.subdomain && (
                  <div className="truncate text-[13px] text-muted-foreground">{host ? `${app.subdomain}.${host}` : app.subdomain}</div>
                )}
              </div>
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

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    const res = await fetch("/api/apps/unified");
    const data = res.ok ? await res.json() : { apps: [] };
    setApps(data.apps || []);
    setLoading(false);
  }, []);

  const loadStatuses = useCallback(async () => {
    const res = await fetch("/settings/api/updates/status");
    if (!res.ok) return;
    const data = await res.json();
    const next = new Map<string, UpdateStatus>();
    for (const status of data.statuses || []) {
      next.set(status.component, status);
    }
    setStatuses(next);
  }, []);

  useEffect(() => { load(true); loadStatuses(); }, [load, loadStatuses]);

  const hasActiveUpdate = Array.from(statuses.values()).some(
    (status) => !["idle", "completed", "failed"].includes(status.status),
  );

  useEffect(() => {
    if (!hasActiveUpdate) return;
    const timer = window.setInterval(() => {
      loadStatuses().catch((err) => console.warn("Failed to refresh update status", err));
      load().catch((err) => console.warn("Failed to refresh apps while updating", err));
    }, 2000);
    return () => window.clearInterval(timer);
  }, [hasActiveUpdate, load, loadStatuses]);

  async function checkUpdates() {
    setChecking(true);
    // Authoritative "check everything": refreshVersionCheck() runs the market catalog
    // check AND the infra (OCI/LXD) digest check in one pass. Component (Spine) status
    // is always fetched fresh by load() -> /api/apps/unified.
    await fetch("/api/market/updates", { method: "POST" }).catch(() => {});
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
      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center justify-between gap-4 px-[18px] py-3">
          <div>
            <h3 className="text-base font-semibold">{updates.length > 0 ? "Updates Available" : "Updates"}</h3>
            <p className="text-[13px] text-muted-foreground">{updates.length} {updates.length === 1 ? "update" : "updates"} found.</p>
          </div>
          <Button variant="outline" size="sm" onClick={checkUpdates} disabled={checking}>
            {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {checking ? "Checking" : "Check for Updates"}
          </Button>
        </div>
        {updates.length === 0 ? (
          <div className="border-t px-[18px] py-8 text-center text-sm text-muted-foreground">Everything is up to date.</div>
        ) : (
          <div>
            {updates.map((app) => {
              const component = updateStatusComponent(app.id);
              const status = statuses.get(component);
              const isUpdating = !!status && !["idle", "completed", "failed"].includes(status.status);
              return (
                <div key={app.id} className="border-t px-[18px] py-3">
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

      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="px-[18px] py-3">
          <h3 className="text-base font-semibold">System Components</h3>
          <p className="text-[13px] text-muted-foreground">Core services and infrastructure managed by YouEye.</p>
        </div>
        <div>
          {systemApps.map((app) => (
            <button key={app.id} onClick={() => onOpen(app.id)} className="flex w-full items-center gap-3 border-t px-[18px] py-3 text-left hover:bg-accent/40">
              <AppIcon app={app} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-[13px] font-medium">{app.displayName}</p>
                  {app.version && <span className="font-mono text-xs text-muted-foreground">v{app.version}</span>}
                </div>
                <div className="mt-0.5 flex items-center gap-1"><StatusDot status={app.status} /><span className="text-xs text-muted-foreground">{app.status}</span></div>
                {appHealthLabel(app) && (
                  <div className="mt-1">
                    <Badge variant={appHealthVariant(app)}>{appHealthLabel(app)}</Badge>
                  </div>
                )}
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
  const [ready, setReady] = useState(false);
  const settingsUrl = useMemo(() => {
    if (app.url) {
      try {
        return `${new URL(app.url).origin}/embed/settings`;
      } catch {}
    }
    if (app.subdomain && typeof window !== "undefined") {
      return `${window.location.protocol}//${app.subdomain}.${window.location.hostname}/embed/settings`;
    }
    return "";
  }, [app.subdomain, app.url]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      let expectedOrigin = "";
      try {
        expectedOrigin = settingsUrl ? new URL(settingsUrl).origin : "";
      } catch {
        expectedOrigin = "";
      }
      if (expectedOrigin && event.origin !== expectedOrigin) return;

      if (event.data?.type === "youeye:ready") {
        setReady(true);
        return;
      }

      if (event.data?.type === "youeye:resize" && typeof event.data.height === "number") {
        setReady(true);
        setIframeHeight(Math.max(220, event.data.height));
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [settingsUrl]);

  if (!settingsUrl) {
    return <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">No app settings URL is available.</div>;
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      {!ready && (
        <div className="flex h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading app settings
        </div>
      )}
      <iframe
        src={settingsUrl}
        className="w-full border-0"
        style={{ height: ready ? iframeHeight : 0, minHeight: ready ? 220 : 0 }}
        title={`${app.name} Settings`}
        allow="clipboard-write"
      />
    </div>
  );
}

type AppAIStatus = {
  supported: boolean;
  enabled: boolean;
  currentActorId: string;
  connection: {
    ownerUserId: string;
    modelGroupId: string;
    groupName: string;
    keyPreview: string;
    state: "active" | "disabled" | "needs_attention";
  } | null;
  installation: {
    routingOwner: { externalSubject: string | null; displayName: string; state: string } | null;
    drift: { codes: string[]; healthy: boolean };
  } | null;
  groups: Array<{
    id: string;
    name: string;
    isDefault: boolean;
    enabledModelCount: number;
    unavailableRouteCount: number;
    status: "empty" | "degraded" | "available";
  }>;
};

function AppAISettings({ appId, title }: { appId: string; title: string }) {
  const [status, setStatus] = useState<AppAIStatus | null>(null);
  const [groupId, setGroupId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/market/app/${encodeURIComponent(appId)}/ai`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "AI Settings are unavailable");
      const next = body as AppAIStatus;
      setStatus(next);
      setGroupId((current) => current
        || next.groups.find((group) => group.id === next.connection?.modelGroupId)?.id
        || next.groups.find((group) => group.isDefault)?.id
        || next.groups[0]?.id
        || "");
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "AI Settings are unavailable");
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => { void load(); }, [load]);

  async function mutate(action: "enable" | "disable" | "change_group" | "takeover", selectedGroupId?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const csrfToken = await fetchCSRFToken();
      const response = await fetch(`/api/market/app/${encodeURIComponent(appId)}/ai`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ action, ...(selectedGroupId ? { groupId: selectedGroupId } : {}) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "AI Settings update failed");
      setNotice(
        action === "takeover"
          ? "AI connection taken over"
          : action === "change_group"
            ? "Model group changed"
            : action === "enable"
              ? "AI Settings enabled"
              : "AI Settings disabled"
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "AI Settings update failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>;
  if (!status) return <Alert variant="destructive">{error || "AI Settings are unavailable"}</Alert>;
  const ownerIsCurrent = !status.connection
    || status.installation?.routingOwner?.externalSubject === status.currentActorId;
  const needsAttention = status.connection?.state === "needs_attention"
    || status.installation?.routingOwner?.state === "disabled"
    || status.installation?.drift.codes.includes("routing_owner_unavailable");
  const selectedGroup = status.groups.find((group) => group.id === groupId);

  return (
    <div className="space-y-4">
      {error && <Alert variant="destructive">{error}</Alert>}
      {notice && <Alert>{notice}</Alert>}
      {needsAttention && (
        <Alert variant="destructive">
          This connection needs attention because its owner is unavailable. Another administrator can take it over explicitly.
        </Alert>
      )}
      <div className="rounded-lg border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              <h3 className="font-semibold">Use AI Settings</h3>
              <Badge variant={status.enabled ? "default" : "secondary"}>{status.enabled ? "On" : "Off"}</Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Give {title} its own AI instance and models from the selected group. Native provider controls inside the app remain available.
            </p>
          </div>
          <Switch
            checked={status.enabled}
            disabled={busy || (!ownerIsCurrent && !status.enabled) || (!status.connection && !groupId)}
            onCheckedChange={(enabled) => void mutate(enabled ? "enable" : "disable", enabled ? groupId : undefined)}
            aria-label={`Use AI Settings for ${title}`}
          />
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`ai-group-${appId}`}>Model group</Label>
            <Select
              value={groupId}
              disabled={busy || !ownerIsCurrent}
              onValueChange={(value) => {
                setGroupId(value);
                if (status.connection && ownerIsCurrent) void mutate("change_group", value);
              }}
            >
              <SelectTrigger id={`ai-group-${appId}`}><SelectValue placeholder="Choose a model group" /></SelectTrigger>
              <SelectContent>
                {status.groups.map((group) => (
                  <SelectItem key={group.id} value={group.id} disabled={group.status === "empty"}>
                    {group.name}{group.isDefault ? " · Default" : ""} · {group.enabledModelCount} model{group.enabledModelCount === 1 ? "" : "s"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedGroup?.unavailableRouteCount ? <p className="text-xs text-destructive">Some routes need a provider connection.</p> : null}
          </div>
          <div className="rounded-md bg-muted/40 p-3 text-sm">
            <p className="font-medium">Connection</p>
            <p className="mt-1 text-muted-foreground">
              {status.connection
                ? `${status.connection.groupName} · ${status.connection.keyPreview}`
                : `Manual setup inside ${title}`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Default model alias: <code>default</code></p>
          </div>
        </div>

        {!ownerIsCurrent && status.connection && (
          <div className="mt-5 flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium">Owned by {status.installation?.routingOwner?.displayName || "another administrator"}</p>
              <p className="mt-1 text-xs text-muted-foreground">Future AI provider usage will belong to your account after takeover.</p>
            </div>
            <Button disabled={busy || !groupId} onClick={() => void mutate("takeover", groupId)}>
              Take over AI connection
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function AppDetail({ appId, isAdmin, hasUserContext, onBack }: { appId: string; isAdmin: boolean; hasUserContext: boolean; onBack: () => void }) {
  const [tab, setTab] = useState<AppTab>("overview");
  const [drawerApps, setDrawerApps] = useState<DrawerApp[]>([]);
  const [unifiedApps, setUnifiedApps] = useState<UnifiedApp[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);
  const [powerPending, setPowerPending] = useState<"start" | "stop" | "restart" | null>(null);
  const [powerError, setPowerError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [healthPolicyPending, setHealthPolicyPending] = useState(false);
  const [healthPolicyError, setHealthPolicyError] = useState<string | null>(null);
  const [aiSupported, setAISupported] = useState(false);
  const drawerApp = drawerApps.find((app) => app.id === appId);
  const unifiedApp = unifiedApps.find((app) => app.id === appId);
  const title = drawerApp?.name || unifiedApp?.displayName || appId;

  const load = useCallback(async () => {
      const [drawerRes, unifiedRes, permissionRes, identityPermissionRes, aiRes] = await Promise.all([
        hasUserContext ? fetch(uiSettingsApi("apps/drawer")) : Promise.resolve(null),
        fetch("/api/apps/unified"),
        hasUserContext ? fetch(uiSettingsApi(`permissions/app/${encodeURIComponent(appId)}`)) : Promise.resolve(null),
        hasUserContext ? fetch(identityConsentApi(appId)) : Promise.resolve(null),
        isAdmin ? fetch(`/api/market/app/${encodeURIComponent(appId)}/ai`, { cache: "no-store" }) : Promise.resolve(null),
      ]);
      if (drawerRes?.ok) setDrawerApps((await drawerRes.json()).apps || []);
      if (unifiedRes.ok) setUnifiedApps((await unifiedRes.json()).apps || []);
      const uiPermissions = permissionRes?.ok ? ((await permissionRes.json()).permissions || []) : [];
      const identityPermissions = identityPermissionRes?.ok ? ((await identityPermissionRes.json()).permissions || []) : [];
      setPermissions([...identityPermissions, ...uiPermissions]);
      const aiPayload = aiRes ? await aiRes.json().catch(() => null) : null;
      setAISupported(Boolean(aiPayload?.supported));
      setLoading(false);
  }, [appId, hasUserContext, isAdmin]);

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

  async function controlPower(action: "start" | "stop" | "restart") {
    setPowerPending(action);
    setPowerError(null);
    try {
      const csrfToken = await fetchCSRFToken();
      const res = await fetch(`/api/apps/${encodeURIComponent(appId)}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Power action failed" }));
        throw new Error(body.error || "Power action failed");
      }
      await load();
    } catch (error) {
      setPowerError(error instanceof Error ? error.message : "Power action failed");
    } finally {
      setPowerPending(null);
      setConfirmStop(false);
    }
  }

  async function setAutomaticRecovery(enabled: boolean) {
    setHealthPolicyPending(true);
    setHealthPolicyError(null);
    try {
      const csrfToken = await fetchCSRFToken();
      const response = await fetch(`/api/apps/${encodeURIComponent(appId)}/health-policy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ autoRestart: enabled }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not update automatic recovery");
      await load();
    } catch (error) {
      setHealthPolicyError(error instanceof Error ? error.message : "Could not update automatic recovery");
    } finally {
      setHealthPolicyPending(false);
    }
  }

  const hasAppSettings = hasUserContext && !!drawerApp?.hasSettingsPanel && (!!drawerApp.url || !!drawerApp.subdomain);
  const off = isAppOff(unifiedApp);
  const controllable = isAdmin && unifiedApp?.category === "user" && (unifiedApp.containers?.length ?? 0) > 0;
  const databaseNote = unifiedApp?.databaseMode === "shared"
    ? "The shared database stays running. Only this app is turned off."
    : unifiedApp?.databaseMode === "own"
      ? "This also stops the app's private database container. Data stays saved on disk."
      : "Your data is kept.";
  const tabs = [
    { id: "app-settings", label: "App Settings", icon: <Sliders className="h-4 w-4" />, userOnly: true, hide: !hasAppSettings },
    { id: "overview", label: "Overview", icon: <Info className="h-4 w-4" /> },
    { id: "ai", label: "AI", icon: <Sparkles className="h-4 w-4" />, adminOnly: true, hide: !aiSupported },
    { id: "branding", label: "Branding", icon: <Palette className="h-4 w-4" />, userOnly: true },
    { id: "permissions", label: "Permissions", icon: <Shield className="h-4 w-4" />, userOnly: true },
    { id: "network", label: "Network", icon: <Network className="h-4 w-4" />, adminOnly: true },
    { id: "update-channel", label: "Update channel", icon: <GitBranch className="h-4 w-4" />, adminOnly: true, hide: !unifiedApp?.updateChannelKey },
    { id: "link-handling", label: "Link Handling", icon: <Unplug className="h-4 w-4" />, userOnly: true },
  ] satisfies Array<{ id: AppTab; label: string; icon: React.ReactNode; adminOnly?: boolean; userOnly?: boolean; hide?: boolean }>;
  const visibleTabs = tabs.filter((item) => (!item.adminOnly || isAdmin) && (!item.userOnly || hasUserContext) && !item.hide);

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-6">
      <ConfirmDialog
        open={confirmStop}
        title={`Turn off ${title}?`}
        description={`${title} will stop running. Its app pages, widgets, and notifications will be unavailable until you start it again. Your data will be kept.`}
        confirmLabel={powerPending === "stop" ? "Turning off..." : "Turn off app"}
        confirmDisabled={powerPending !== null}
        onCancel={() => setConfirmStop(false)}
        onConfirm={() => controlPower("stop")}
      >
        <p className="text-[13px] leading-relaxed text-muted-foreground">{databaseNote}</p>
      </ConfirmDialog>

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
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">App status</span>
                {off && <><OffDot /><span className="sr-only">Off</span></>}
                {appHealthLabel(unifiedApp) && <Badge variant={appHealthVariant(unifiedApp)}>{appHealthLabel(unifiedApp)}</Badge>}
              </div>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {off
                  ? `${title} is off. Start it to make app pages, widgets, and notifications available again.`
                  : powerPending
                    ? `${title} is ${powerPending === "stop" ? "turning off" : powerPending === "start" ? "starting" : "restarting"}...`
                    : `${title} is ${unifiedApp?.status || "unknown"}.`}
              </p>
              {unifiedApp?.healthDetail && unifiedApp.appHealthState && unifiedApp.appHealthState !== "running" && (
                <p className="mt-1 text-[13px] text-muted-foreground">{unifiedApp.healthDetail}</p>
              )}
              {powerError && <p className="mt-1 text-[13px] text-destructive">{powerError}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {drawerApp?.url && !off && (
                <Button variant="outline" size="sm" asChild>
                  <a href={drawerApp.url}>
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open app
                  </a>
                </Button>
              )}
              {controllable && off && (
                <Button size="sm" onClick={() => controlPower("start")} disabled={powerPending !== null}>
                  {powerPending === "start" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
                  Start app
                </Button>
              )}
              {controllable && !off && (
                <>
                  <Button variant="outline" size="sm" onClick={() => controlPower("restart")} disabled={powerPending !== null}>
                    {powerPending === "restart" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    Restart
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirmStop(true)} disabled={powerPending !== null}>
                    {powerPending === "stop" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PowerOff className="h-3.5 w-3.5" />}
                    Turn off app
                  </Button>
                </>
              )}
            </div>
          </div>
          <div className="grid gap-4 p-4 text-sm sm:grid-cols-2">
            <div><span className="text-muted-foreground">Status</span><p className="font-medium">{unifiedApp?.status || drawerApp?.status || "unknown"}</p></div>
            <div><span className="text-muted-foreground">Health</span><p className="font-medium">{appHealthLabel(unifiedApp) || unifiedApp?.healthStatus || "unknown"}</p></div>
            <div><span className="text-muted-foreground">Version</span><p className="font-medium">{unifiedApp?.version || "—"}</p></div>
            <div><span className="text-muted-foreground">Type</span><p className="font-medium">{unifiedApp?.type || "app"}</p></div>
            <div><span className="text-muted-foreground">URL</span><p className="font-medium">{drawerApp?.url ? <a className="inline-flex items-center gap-1 text-primary hover:underline" href={drawerApp.url}><ExternalLink className="h-3 w-3" /> Open</a> : "—"}</p></div>
          </div>
          {controllable && (
            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">Automatic recovery</p>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  Restart this app after repeated health-check failures. Turn this off while deliberately debugging it.
                </p>
                {healthPolicyError ? <p className="mt-1 text-[13px] text-destructive">{healthPolicyError}</p> : null}
              </div>
              <Switch
                checked={unifiedApp?.autoRestart !== false}
                disabled={healthPolicyPending}
                onCheckedChange={setAutomaticRecovery}
                aria-label={`Automatic recovery for ${title}`}
              />
            </div>
          )}
          {unifiedApp?.containers?.map((container) => (
            <div key={container.name} className="flex items-center justify-between p-4 text-sm">
              <div><p className="font-medium">{container.name}</p><p className="text-xs text-muted-foreground">{container.ip || "No IP"}</p></div>
              <Badge variant="outline">{container.status}</Badge>
            </div>
          ))}
        </div>
      )}

      {tab === "ai" && isAdmin && aiSupported && <AppAISettings appId={appId} title={title} />}

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

      {tab === "update-channel" && isAdmin && unifiedApp?.updateChannelKey && (
        <UpdateChannels componentId={unifiedApp.updateChannelKey} />
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
