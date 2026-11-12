"use client";

import { PageHeader } from "./page-header";

import { useTranslations as useInterfaceTranslations } from "next-intl";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, CSSProperties } from "react";
import Link from "next/link";
import * as LucideIcons from "lucide-react";
import { AlertCircle, ArrowLeft, ChevronRight, ExternalLink, Info, Loader2, Network, Palette, Power, PowerOff, RefreshCw, RotateCcw, Shield, Sliders, Sparkles, Unplug } from "lucide-react";
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
  serviceCredentialState?: "pending" | "ready" | "revoked";
  databaseMode?: "shared" | "own" | "none";
  updateAvailable: boolean;
  updateInfo?: string;
  systemManaged?: boolean;
  healthStatus?: "healthy" | "unhealthy" | "unknown";
  appHealthState?: "starting" | "running" | "unhealthy" | "crash-looping" | "unknown" | "maintenance";
  failingLevel?: "L1" | "L2" | "L3";
  healthDetail?: string | null;
  healthCheckedAt?: string | null;
  autoRestart?: boolean;
}

interface UpdateStatus {
  component: string;
  status: string;
  message: string;
  progress: number;
  version_after?: string | null;
  error?: string | null;
}

interface AppUpdateOperation {
  id: string;
  phase: string;
  committed: boolean;
  rolledBack: boolean;
  cleanupComplete: boolean;
  recoveryRequired: boolean;
  pending: boolean;
  errorCode: string | null;
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

type AppTab = "app-settings" | "overview" | "ai" | "branding" | "permissions" | "network" | "link-handling";
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

async function fetchCSRFToken(translateInterface: ReturnType<typeof useInterfaceTranslations>): Promise<string> {
  const res = await fetch("/settings/api/auth/csrf");
  if (!res.ok) throw new Error(translateInterface("mb25a53c34695"));
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



function InstalledAppsList({ onOpen }: { onOpen: (id: string) => void }) {
  const translateInterface = useInterfaceTranslations("interface");

  const [apps, setApps] = useState<DrawerApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    setError("");
    try {
      const res = await fetch(uiSettingsApi("apps/drawer"));
      if (!res.ok) throw new Error(translateInterface("me46b87db96b0"));
      const data = await res.json();
      setApps((data.apps || []).filter((app: DrawerApp) => !app.platform));
    } catch (err) {
      setError(translateInterface("me46b87db96b0"));
    } finally {
      setLoading(false);
    }
  }, [translateInterface]);

  useEffect(() => { load(); }, [load]);

  const host = typeof window !== "undefined" ? window.location.hostname : "";

  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center justify-between px-[18px] py-3">
        <h2 className="text-[15px] font-semibold">{translateInterface("mdf76d7f1e93c")}</h2>
        <Link href="/market" className="text-[13px] font-medium text-primary hover:underline">{translateInterface("mfbf25423f41e")}</Link>
      </div>
      {loading ? (
        <div className="flex items-center justify-center gap-2 border-t py-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{translateInterface("mf8bcca389b95")}</div>
      ) : error ? (
        <div className="border-t py-12 text-center text-sm text-muted-foreground"><AlertCircle className="mx-auto mb-2 h-6 w-6 opacity-50" />{error}</div>
      ) : apps.length === 0 ? (
        <div className="border-t py-10 text-center text-sm text-muted-foreground">{translateInterface("mf0b2cf399f5f")}</div>
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
                  {off && <><OffDot /><span className="sr-only">{translateInterface("mca7981b46ecf")}</span></>}
                </div>
                {app.subdomain && (
                  <div className="truncate text-[13px] text-muted-foreground">{host ? `${app.subdomain}.${host}` : app.subdomain}</div>
                )}
              </div>
              <span className="hidden text-[13px] font-medium text-muted-foreground sm:inline">{translateInterface("m5a23444828db")}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/40" />
            </button>
          );
        })
      )}
    </section>
  );
}

function AdminAppSections({ onOpen }: { onOpen: (id: string) => void }) {
  const translateInterface = useInterfaceTranslations("interface");

  const [apps, setApps] = useState<UnifiedApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [statuses, setStatuses] = useState<Map<string, UpdateStatus>>(new Map());
  const [operations, setOperations] = useState<Map<string, AppUpdateOperation | null>>(new Map());
  const [operationErrors, setOperationErrors] = useState<Set<string>>(new Set());
  const [recovering, setRecovering] = useState<Set<string>>(new Set());
  const activeRequests = useRef(new Set<string>());
  const [confirmApp, setConfirmApp] = useState<UnifiedApp | null>(null);
  const [maintAck, setMaintAck] = useState(false);
  const [dbAck, setDbAck] = useState(false);
  const updates = apps.filter((app) => app.updateAvailable || operations.get(app.id)?.pending);
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
    setStatuses((prev) => {
      // Market SSE owns its progress while the request is active. The legacy
      // status endpoint must not erase it or replay an older completed update.
      for (const [component, status] of prev) {
        if (activeRequests.current.has(component)) next.set(component, status);
      }
      return next;
    });
  }, []);

  const loadOperations = useCallback(async () => {
    await Promise.all(apps.filter((app) => app.category === "user").map(async (app) => {
      try {
        const res = await fetch(`/api/market/update/status?appId=${encodeURIComponent(app.id)}`, { cache: "no-store" });
        if (!res.ok) throw new Error(translateInterface("m5f7801451da0"));
        const data = await res.json();
        setOperations((prev) => new Map(prev).set(app.id, data.operation));
        setOperationErrors((prev) => {
          const next = new Set(prev);
          next.delete(app.id);
          return next;
        });
      } catch {
        setOperationErrors((prev) => new Set(prev).add(app.id));
      }
    }));
  }, [apps, translateInterface]);

  useEffect(() => { load(true); loadStatuses(); }, [load, loadStatuses]);

  // Always check durable status, including after a reload or a lost SSE connection.
  useEffect(() => {
    void loadOperations();
    const timer = window.setInterval(() => { void loadOperations(); }, 5000);
    return () => window.clearInterval(timer);
  }, [loadOperations]);

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
    if (activeRequests.current.has(appId) || operations.get(appId)?.pending) return;
    const marketApp = apps.find((app) => app.id === appId)?.category === "user";
    if (marketApp && (!operations.has(appId) || operationErrors.has(appId))) return;
    activeRequests.current.add(appId);
    const component = updateStatusComponent(appId);
    setStatuses((prev) => {
      const next = new Map(prev);
      next.set(component, {
        component,
        status: "checking",
        progress: 0,
        message: translateInterface("m6b4191935143"),
      });
      return next;
    });

    let csrfToken: string;
    try {
      csrfToken = await fetch("/settings/api/auth/csrf")
        .then((res) => res.ok ? res.json() : Promise.reject(new Error(translateInterface("m0b5bf45ed449"))))
        .then((body) => body.csrfToken as string);
    } catch (err) {
      activeRequests.current.delete(appId);
      setStatuses((prev) => {
        const next = new Map(prev);
        const message = err instanceof Error ? err.message : translateInterface("m0b5bf45ed449");
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

    if (marketApp) {
      let finalStatus: UpdateStatus = {
        component, status: "failed", progress: 0,
        message: translateInterface("m7e20281b6045"),
      };
      try {
        const res = await fetch("/api/market/update", {
          method: "POST",
          headers: { "X-CSRF-Token": csrfToken, "Content-Type": "application/json" },
          body: JSON.stringify({ appId }),
        });
        if (!res.ok || !res.body) throw new Error(translateInterface("m149776b4fc95"));
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let terminal = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() || "";
          for (const frame of frames) {
            const line = frame.split("\n").find((line) => line.startsWith("data: "));
            if (!line) continue;
            const event = JSON.parse(line.slice(6));
            const nextStatus = {
              component,
              status: event.stage === "pending" ? "idle" : event.stage,
              message: event.message,
              progress: event.progress || 0,
            };
            if (["pending", "completed", "failed"].includes(event.stage)) {
              terminal = true;
              finalStatus = nextStatus;
            }
            setStatuses((prev) => new Map(prev).set(component, nextStatus));
          }
        }
        if (!terminal) {
          finalStatus.message = translateInterface("m7e20281b6045");
        }
      } catch {
        finalStatus = {
          component, status: "failed", progress: 0,
          message: translateInterface("m8676ed970e94"),
        };
      } finally {
        activeRequests.current.delete(appId);
        setStatuses((prev) => new Map(prev).set(component, finalStatus));
        await loadOperations();
        await load();
      }
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
          const body = await res.json().catch(() => ({ error: translateInterface("me58282fd73fb") }));
          setStatuses((prev) => {
            const next = new Map(prev);
            next.set(component, {
              component,
              status: "failed",
              progress: 100,
              message: body.error || translateInterface("me58282fd73fb"),
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
            message: err instanceof Error ? err.message : translateInterface("me58282fd73fb"),
            error: err instanceof Error ? err.message : "Update failed",
          });
          return next;
        });
      })
      .finally(() => { activeRequests.current.delete(appId); });
  }

  async function retryRecovery(appId: string) {
    const operation = operations.get(appId);
    if (!operation?.pending || activeRequests.current.has(appId)) return;
    activeRequests.current.add(appId);
    setRecovering((prev) => new Set(prev).add(appId));
    try {
      const csrfToken = await fetchCSRFToken(translateInterface);
      const res = await fetch("/api/market/update/recovery", {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken, "Content-Type": "application/json" },
        body: JSON.stringify({ appId, id: operation.id }),
      });
      if (!res.ok) throw new Error(translateInterface("m7f8ac9a64450"));
      setStatuses((prev) => new Map(prev).set(updateStatusComponent(appId), {
        component: updateStatusComponent(appId), status: "idle", progress: 0,
        message: translateInterface("m7d39fa54cad1"),
      }));
    } catch {
      setStatuses((prev) => new Map(prev).set(updateStatusComponent(appId), {
        component: updateStatusComponent(appId), status: "failed", progress: 0,
        message: translateInterface("mced08e0789ed"),
      }));
    } finally {
      activeRequests.current.delete(appId);
      setRecovering((prev) => {
        const next = new Set(prev);
        next.delete(appId);
        return next;
      });
      await loadOperations();
      await load();
    }
  }

  if (loading) return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <>
      {confirmApp && (
        <ConfirmDialog
          open
          title={translateInterface("me0624c9267e4", { value0: String(confirmApp.displayName) })}
          description={translateInterface("m7f548d42d37f", { value0: String(confirmApp.displayName), value1: String(confirmApp.containers[0]?.name ?? translateInterface("m7dddf9085fdd")) })}
          confirmLabel={translateInterface("m63bf045213ce")}
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
            <span>{translateInterface("m28fe0e0aab6a")}</span>
          </label>
          {confirmApp.id === "postgres" && (
            <label className="flex items-start gap-2 text-[13px]">
              <input type="checkbox" checked={dbAck} onChange={(e) => setDbAck(e.target.checked)} className="mt-0.5" />
              <span>{translateInterface("mb549a14cb95b")}</span>
            </label>
          )}
        </ConfirmDialog>
      )}
      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center justify-between gap-4 px-[18px] py-3">
          <div>
            <h3 className="text-base font-semibold">{updates.length > 0 ? translateInterface("ma0909182f8d7") : translateInterface("m22e2bada8f1c")}</h3>
            <p className="text-[13px] text-muted-foreground">{translateInterface("m50bdf4b5f230", {count: updates.length})}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {translateInterface("mcad7ceef401a")}</p>
          </div>
          <Button variant="outline" size="sm" onClick={checkUpdates} disabled={checking}>
            {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {checking ? translateInterface("m0dfe1d63c9d8") : translateInterface("m9ed79ee9b212")}
          </Button>
        </div>
        {updates.length === 0 ? (
          <div className="border-t px-[18px] py-8 text-center text-sm text-muted-foreground">{translateInterface("mb9e08498866d")}</div>
        ) : (
          <div>
            {updates.map((app) => {
              const component = updateStatusComponent(app.id);
              const status = statuses.get(component);
              const operation = operations.get(app.id);
              const isUpdating = !operation?.recoveryRequired
                && !!status && !["idle", "completed", "failed"].includes(status.status);
              const statusUnavailable = app.category === "user"
                && (!operations.has(app.id) || operationErrors.has(app.id));
              return (
                <div key={app.id} className="border-t px-[18px] py-3">
                  <div className="flex w-full items-center gap-3">
                    <button type="button" onClick={() => onOpen(app.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                      <AppIcon app={app} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium">{app.displayName}</p>
                        <p className="text-xs text-muted-foreground">{app.updateInfo || translateInterface("mff8b555d818f")}</p>
                      </div>
                    </button>
                    <Button size="sm" onClick={() => (app.systemManaged ? openConfirm(app) : updateApp(app.id))} disabled={isUpdating || !!operation?.pending || statusUnavailable}>
                      {isUpdating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                      {operation?.pending ? translateInterface("m331551b0de41") : isUpdating ? translateInterface("m0b5260e1b405") : translateInterface("mc1c1009d3f37")}
                    </Button>
                  </div>
                  {operation?.pending && (
                    <div className="mt-2 space-y-2" role="status" aria-live="polite">
                      <p className="text-xs text-muted-foreground">
                        {operation.committed
                          ? translateInterface("m2e2ca18f1b0f")
                          : operation.recoveryRequired
                            ? translateInterface("md6644acf6789")
                            : translateInterface("m8810322335b4")}
                      </p>
                      <Button variant="outline" size="sm" onClick={() => retryRecovery(app.id)} disabled={recovering.has(app.id) || activeRequests.current.has(app.id) || statusUnavailable}>
                        {recovering.has(app.id) && <Loader2 className="h-4 w-4 animate-spin" />}
                        {recovering.has(app.id) ? translateInterface("md90064dbdb11") : translateInterface("mf37b055f32a8")}
                      </Button>
                    </div>
                  )}
                  {statusUnavailable && (
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground" role="status">
                      <span>{translateInterface("m079b9eeddf57")}</span>
                      <Button variant="outline" size="sm" onClick={() => { void loadOperations(); }}>{translateInterface("m442c4b893915")}</Button>
                    </div>
                  )}
                  {operation?.rolledBack && operation.cleanupComplete && (
                    <p className="mt-2 text-xs text-muted-foreground">{translateInterface("m950e51efd783")}</p>
                  )}
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
                      {status.status === "completed" && !operation?.pending && <p className="text-xs text-green-600">{translateInterface("m2ca13025d60c")}{status.version_after ? `: v${status.version_after}` : ""}</p>}
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
          <h3 className="text-base font-semibold">{translateInterface("m3fea190da427")}</h3>
          <p className="text-[13px] text-muted-foreground">{translateInterface("meccb6abcf328")}</p>
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
  const translateInterface = useInterfaceTranslations("interface");

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
    return <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">{translateInterface("m2786efec8c30")}</div>;
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      {!ready && (
        <div className="flex h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {translateInterface("mf8a9594de662")}</div>
      )}
      <iframe
        src={settingsUrl}
        className="w-full border-0"
        style={{ height: ready ? iframeHeight : 0, minHeight: ready ? 220 : 0 }}
        title={translateInterface("mb6eb9714407d", { value0: String(app.name) })}
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
  const translateInterface = useInterfaceTranslations("interface");

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
      if (!response.ok) throw new Error(body.error || translateInterface("mbd74699a92af"));
      const next = body as AppAIStatus;
      setStatus(next);
      setGroupId((current) => current
        || next.groups.find((group) => group.id === next.connection?.modelGroupId)?.id
        || next.groups.find((group) => group.isDefault)?.id
        || next.groups[0]?.id
        || "");
      setError("");
    } catch (reason) {
      setError(translateInterface("mbd74699a92af"));
    } finally {
      setLoading(false);
    }
  }, [appId, translateInterface]);

  useEffect(() => { void load(); }, [load]);

  async function mutate(action: "enable" | "disable" | "change_group" | "takeover", selectedGroupId?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const csrfToken = await fetchCSRFToken(translateInterface);
      const response = await fetch(`/api/market/app/${encodeURIComponent(appId)}/ai`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ action, ...(selectedGroupId ? { groupId: selectedGroupId } : {}) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || translateInterface("mbc24ad19d9d2"));
      setNotice(
        action === "takeover"
          ? translateInterface("m30fcc9a29086")
          : action === "change_group"
            ? translateInterface("m43887f371623")
            : action === "enable"
              ? translateInterface("m4bc65fd40500")
              : translateInterface("md76852bf6bfb")
      );
      await load();
    } catch (reason) {
      setError(translateInterface("mbc24ad19d9d2"));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>;
  if (!status) return <Alert variant="destructive">{error || translateInterface("mbd74699a92af")}</Alert>;
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
          {translateInterface("m283317ddeb03")}</Alert>
      )}
      <div className="rounded-lg border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              <h3 className="font-semibold">{translateInterface("m18ff0c26ee4a")}</h3>
              <Badge variant={status.enabled ? "default" : "secondary"}>{status.enabled ? translateInterface("m130011756125") : translateInterface("mca7981b46ecf")}</Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              {translateInterface("mad79cfea2624", {app: title})}
            </p>
          </div>
          <Switch
            checked={status.enabled}
            disabled={busy || (!ownerIsCurrent && !status.enabled) || (!status.connection && !groupId)}
            onCheckedChange={(enabled) => void mutate(enabled ? "enable" : "disable", enabled ? groupId : undefined)}
            aria-label={translateInterface("mfb666f84a9c2", {app: title})}
          />
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`ai-group-${appId}`}>{translateInterface("madb24ff365bd")}</Label>
            <Select
              value={groupId}
              disabled={busy || !ownerIsCurrent}
              onValueChange={(value) => {
                setGroupId(value);
                if (status.connection && ownerIsCurrent) void mutate("change_group", value);
              }}
            >
              <SelectTrigger id={`ai-group-${appId}`}><SelectValue placeholder={translateInterface("m0c7e5871a4e6")} /></SelectTrigger>
              <SelectContent>
                {status.groups.map((group) => (
                  <SelectItem key={group.id} value={group.id} disabled={group.status === "empty"}>
                    {translateInterface("m0b7c0ace70d0", {group: group.name, count: group.enabledModelCount})}{group.isDefault ? translateInterface("m2a7e0b7b2062") : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedGroup?.unavailableRouteCount ? <p className="text-xs text-destructive">{translateInterface("m26f9ccc0629f")}</p> : null}
          </div>
          <div className="rounded-md bg-muted/40 p-3 text-sm">
            <p className="font-medium">{translateInterface("m639a40e82b9a")}</p>
            <p className="mt-1 text-muted-foreground">
              {status.connection
                ? `${status.connection.groupName} · ${status.connection.keyPreview}`
                : translateInterface("m4a1c5d30939d", { value0: String(title) })}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{translateInterface("m8d2a4592acd4")}<code>default</code></p>
          </div>
        </div>

        {!ownerIsCurrent && status.connection && (
          <div className="mt-5 flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium">{translateInterface("m0eba3d4ee43f")}{status.installation?.routingOwner?.displayName || translateInterface("mc13dc9685345")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{translateInterface("m615937f6702b")}</p>
            </div>
            <Button disabled={busy || !groupId} onClick={() => void mutate("takeover", groupId)}>
              {translateInterface("m3213cd836138")}</Button>
          </div>
        )}
      </div>
    </div>
  );
}

function AppDetail({ appId, isAdmin, hasUserContext, onBack }: { appId: string; isAdmin: boolean; hasUserContext: boolean; onBack: () => void }) {
  const translateInterface = useInterfaceTranslations("interface");
function permissionDescription(permission: Permission) {
  if (permission.descriptor?.description) return permission.descriptor.description;
  return translateInterface("m40ff0a06c8a1");
}


  const [tab, setTab] = useState<AppTab>("overview");
  const [drawerApps, setDrawerApps] = useState<DrawerApp[]>([]);
  const [unifiedApps, setUnifiedApps] = useState<UnifiedApp[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);
  const [powerPending, setPowerPending] = useState<"start" | "stop" | "restart" | null>(null);
  const [powerError, setPowerError] = useState<string | null>(null);
  const [credentialPending, setCredentialPending] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [healthPolicyPending, setHealthPolicyPending] = useState(false);
  const [healthPolicyError, setHealthPolicyError] = useState<string | null>(null);
  const [aiSupported, setAISupported] = useState(false);
  const [signIn, setSignIn] = useState<{ available: boolean; enabled: boolean } | null>(null);
  const [signInPending, setSignInPending] = useState<boolean | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const drawerApp = drawerApps.find((app) => app.id === appId);
  const unifiedApp = unifiedApps.find((app) => app.id === appId);
  const title = drawerApp?.name || unifiedApp?.displayName || appId;

  const load = useCallback(async () => {
      const [drawerRes, unifiedRes, permissionRes, identityPermissionRes, aiRes, signInRes] = await Promise.all([
        hasUserContext ? fetch(uiSettingsApi("apps/drawer")) : Promise.resolve(null),
        fetch("/api/apps/unified"),
        hasUserContext ? fetch(uiSettingsApi(`permissions/app/${encodeURIComponent(appId)}`)) : Promise.resolve(null),
        hasUserContext ? fetch(identityConsentApi(appId)) : Promise.resolve(null),
        isAdmin ? fetch(`/api/market/app/${encodeURIComponent(appId)}/ai`, { cache: "no-store" }) : Promise.resolve(null),
        isAdmin ? fetch(`/api/market/app/${encodeURIComponent(appId)}/sign-in`, { cache: "no-store" }) : Promise.resolve(null),
      ]);
      if (drawerRes?.ok) setDrawerApps((await drawerRes.json()).apps || []);
      if (unifiedRes.ok) setUnifiedApps((await unifiedRes.json()).apps || []);
      const uiPermissions = permissionRes?.ok ? ((await permissionRes.json()).permissions || []) : [];
      const identityPermissions = identityPermissionRes?.ok ? ((await identityPermissionRes.json()).permissions || []) : [];
      setPermissions([...identityPermissions, ...uiPermissions]);
      const aiPayload = aiRes ? await aiRes.json().catch(() => null) : null;
      setAISupported(Boolean(aiPayload?.supported));
      const signInPayload = signInRes?.ok ? await signInRes.json().catch(() => null) : null;
      setSignIn(signInPayload?.available ? { available: true, enabled: Boolean(signInPayload.enabled) } : null);
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
      const csrfToken = await fetchCSRFToken(translateInterface);
      const res = await fetch(`/api/apps/${encodeURIComponent(appId)}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: translateInterface("m8624ee8df453") }));
        throw new Error(body.error || translateInterface("m8624ee8df453"));
      }
      await load();
    } catch (error) {
      setPowerError(error instanceof Error ? error.message : translateInterface("m8624ee8df453"));
    } finally {
      setPowerPending(null);
      setConfirmStop(false);
    }
  }

  async function setAutomaticRecovery(enabled: boolean) {
    setHealthPolicyPending(true);
    setHealthPolicyError(null);
    try {
      const csrfToken = await fetchCSRFToken(translateInterface);
      const response = await fetch(`/api/apps/${encodeURIComponent(appId)}/health-policy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ autoRestart: enabled }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || translateInterface("m53862be8135a"));
      await load();
    } catch (error) {
      setHealthPolicyError(error instanceof Error ? error.message : translateInterface("m53862be8135a"));
    } finally {
      setHealthPolicyPending(false);
    }
  }

  async function setYouEyeSignIn(enabled: boolean) {
    setSignInPending(enabled);
    setSignInError(null);
    try {
      const csrfToken = await fetchCSRFToken(translateInterface);
      const response = await fetch(`/api/market/app/${encodeURIComponent(appId)}/sign-in`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ enabled }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || translateInterface("mcb476eaab560"));
      setSignIn({ available: true, enabled: Boolean(body.enabled) });
    } catch (error) {
      setSignInError(error instanceof Error ? error.message : translateInterface("mcb476eaab560"));
    } finally {
      setSignInPending(null);
    }
  }

  async function reconcileCredentials() {
    setCredentialPending(true);
    setPowerError(null);
    try {
      const csrf = await fetchCSRFToken(translateInterface);
      const response = await fetch(`/api/market/credentials/${encodeURIComponent(appId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ action: "reconcile" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || translateInterface("m27e2a14350b2"));
      await load();
    } catch (error) {
      setPowerError(error instanceof Error ? error.message : translateInterface("m27e2a14350b2"));
    } finally { setCredentialPending(false); }
  }

  const hasAppSettings = hasUserContext && !!drawerApp?.hasSettingsPanel && (!!drawerApp.url || !!drawerApp.subdomain);
  const off = isAppOff(unifiedApp);
  const controllable = isAdmin && unifiedApp?.category === "user" && (unifiedApp.containers?.length ?? 0) > 0;
  const databaseNote = unifiedApp?.databaseMode === "shared"
    ? translateInterface("m2b43e68d0127")
    : unifiedApp?.databaseMode === "own"
      ? translateInterface("m0a30a7ab7ad1")
      : translateInterface("m54dd7b4ad1cb");
  const tabs = [
    { id: "app-settings", label: translateInterface("mda645334193e"), icon: <Sliders className="h-4 w-4" />, userOnly: true, hide: !hasAppSettings },
    { id: "overview", label: translateInterface("md4b1ea5708dd"), icon: <Info className="h-4 w-4" /> },
    { id: "ai", label: translateInterface("m11fb682be0a0"), icon: <Sparkles className="h-4 w-4" />, adminOnly: true, hide: !aiSupported },
    { id: "branding", label: translateInterface("md417aa16da36"), icon: <Palette className="h-4 w-4" />, userOnly: true },
    { id: "permissions", label: translateInterface("mabccc78cc93c"), icon: <Shield className="h-4 w-4" />, userOnly: true },
    { id: "network", label: translateInterface("m1744b96470b5"), icon: <Network className="h-4 w-4" />, adminOnly: true },
    { id: "link-handling", label: translateInterface("mca153aaec316"), icon: <Unplug className="h-4 w-4" />, userOnly: true },
  ] satisfies Array<{ id: AppTab; label: string; icon: React.ReactNode; adminOnly?: boolean; userOnly?: boolean; hide?: boolean }>;
  const visibleTabs = tabs.filter((item) => (!item.adminOnly || isAdmin) && (!item.userOnly || hasUserContext) && !item.hide);

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-6">
      <ConfirmDialog
        open={confirmStop}
        title={translateInterface("m49c04461d6d0", { value0: String(title) })}
        description={translateInterface("mcb981c5cd2d3", { value0: String(title) })}
        confirmLabel={powerPending === "stop" ? translateInterface("ma3334f511a54") : translateInterface("ma71f685036e7")}
        confirmDisabled={powerPending !== null}
        onCancel={() => setConfirmStop(false)}
        onConfirm={() => controlPower("stop")}
      >
        <p className="text-[13px] leading-relaxed text-muted-foreground">{databaseNote}</p>
      </ConfirmDialog>

      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {translateInterface("mbac125489c7e")}</button>

      <div className="flex items-center gap-3">
        <AppIcon app={drawerApp || unifiedApp || { id: appId, displayName: title, description: "", icon: "", category: "user", type: "", containers: [], status: "unknown", updateAvailable: false }} />
        <div>
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{unifiedApp?.description || translateInterface("m26d693ad28cb")}</p>
        </div>
      </div>

      <div className="border-b">
        <nav className="flex flex-wrap gap-6" aria-label={translateInterface("m5b2173e206c6")}>
          {visibleTabs.map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={tabClass(tab === item.id)}>{item.icon}{item.label}</button>)}
        </nav>
      </div>

      {tab === "app-settings" && (
        drawerApp && hasAppSettings
          ? <AppSettingsEmbed app={drawerApp} />
          : <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">{translateInterface("m9a805719b511")}</div>
      )}

      {tab === "overview" && (
        <div className="rounded-lg border divide-y">
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{translateInterface("mc6ed837d495b")}</span>
                {off && <><OffDot /><span className="sr-only">{translateInterface("mca7981b46ecf")}</span></>}
                {appHealthLabel(unifiedApp) && <Badge variant={appHealthVariant(unifiedApp)}>{appHealthLabel(unifiedApp)}</Badge>}
              </div>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {unifiedApp?.serviceCredentialState === "revoked"
                  ? translateInterface("m2a6af261ee1c")
                  : unifiedApp?.serviceCredentialState === "pending"
                    ? translateInterface("m3727b0acb45f")
                  : off
                  ? translateInterface("mf649fdfe21ba", { value0: String(title) })
                  : powerPending
                    ? powerPending === "stop" ? translateInterface("md54dbde107ff", {app: title}) : powerPending === "start" ? translateInterface("mc5e3c57a0200", {app: title}) : translateInterface("m50b3619959e5", {app: title})
                    : translateInterface("m49cdfe959956", {app: title, state: unifiedApp?.status || translateInterface("ma191bf55dd89")})}
              </p>
              {unifiedApp?.healthDetail && unifiedApp.appHealthState && unifiedApp.appHealthState !== "running" && (
                <p className="mt-1 text-[13px] text-muted-foreground">{unifiedApp.healthDetail}</p>
              )}
              {powerError && <p className="mt-1 text-[13px] text-destructive">{powerError}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {isAdmin && unifiedApp?.serviceCredentialState === "pending" && (
                <Button variant="outline" size="sm" onClick={() => void reconcileCredentials()} disabled={credentialPending}>
                  {credentialPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {credentialPending ? translateInterface("m393dc4a3ec89") : translateInterface("m3b6c613892eb")}
                </Button>
              )}
              {drawerApp?.url && !off && (
                <Button variant="outline" size="sm" asChild>
                  <a href={drawerApp.url}>
                    <ExternalLink className="h-3.5 w-3.5" />
                    {translateInterface("me51c6b48fb9e")}</a>
                </Button>
              )}
              {controllable && off && unifiedApp?.serviceCredentialState !== "pending" && unifiedApp?.serviceCredentialState !== "revoked" && (
                <Button size="sm" onClick={() => controlPower("start")} disabled={powerPending !== null}>
                  {powerPending === "start" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
                  {translateInterface("m2e4f3ea97036")}</Button>
              )}
              {controllable && !off && (
                <>
                  <Button variant="outline" size="sm" onClick={() => controlPower("restart")} disabled={powerPending !== null}>
                    {powerPending === "restart" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    {translateInterface("m6b983a81e5e8")}</Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirmStop(true)} disabled={powerPending !== null}>
                    {powerPending === "stop" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PowerOff className="h-3.5 w-3.5" />}
                    {translateInterface("ma71f685036e7")}</Button>
                </>
              )}
            </div>
          </div>
          <div className="grid gap-4 p-4 text-sm sm:grid-cols-2">
            <div><span className="text-muted-foreground">{translateInterface("m920e413c7d41")}</span><p className="font-medium">{unifiedApp?.status || drawerApp?.status || translateInterface("mb23a6a8439c0")}</p></div>
            <div><span className="text-muted-foreground">{translateInterface("m55898449eb74")}</span><p className="font-medium">{appHealthLabel(unifiedApp) || unifiedApp?.healthStatus || translateInterface("mb23a6a8439c0")}</p></div>
            <div><span className="text-muted-foreground">{translateInterface("mdd167905de0d")}</span><p className="font-medium">{unifiedApp?.version || "—"}</p></div>
            <div><span className="text-muted-foreground">{translateInterface("mbaaddf70fb5d")}</span><p className="font-medium">{unifiedApp?.type || "app"}</p></div>
            <div><span className="text-muted-foreground">{translateInterface("me7a241debad5")}</span><p className="font-medium">{drawerApp?.url ? <a className="inline-flex items-center gap-1 text-primary hover:underline" href={drawerApp.url}><ExternalLink className="h-3 w-3" /> {" "}{translateInterface("med077f3d8125")}</a> : "—"}</p></div>
          </div>
          {controllable && (
            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">{translateInterface("md7b62393f565")}</p>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {translateInterface("mc2fbdcac2b30")}</p>
                {healthPolicyError ? <p className="mt-1 text-[13px] text-destructive">{healthPolicyError}</p> : null}
              </div>
              <Switch
                checked={unifiedApp?.autoRestart !== false}
                disabled={healthPolicyPending}
                onCheckedChange={setAutomaticRecovery}
                aria-label={translateInterface("m73999e808689", { value0: String(title) })}
              />
            </div>
          )}
          {isAdmin && signIn?.available && (
            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{translateInterface("mfb7ed10de1ed")}</p>
                  <Badge variant={signIn.enabled ? "default" : "secondary"}>{signIn.enabled ? translateInterface("m130011756125") : translateInterface("mca7981b46ecf")}</Badge>
                </div>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {signInPending !== null
                    ? <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" />{signInPending ? translateInterface("m8f71b12330db", { app: title }) : translateInterface("m709433447a43", { app: title })}</span>
                    : signIn.enabled ? translateInterface("m3bf590b2bb82", { app: title }) : translateInterface("m2f5875924e6c", { app: title })}
                </p>
                {signInError ? <p className="mt-1 text-[13px] text-destructive">{signInError}</p> : null}
              </div>
              <Switch
                checked={signInPending ?? signIn.enabled}
                disabled={signInPending !== null}
                onCheckedChange={(enabled) => void setYouEyeSignIn(enabled)}
                aria-label={translateInterface("m70843fac04a3", { app: title })}
              />
            </div>
          )}
          {unifiedApp?.containers?.map((container) => (
            <div key={container.name} className="flex items-center justify-between p-4 text-sm">
              <div><p className="font-medium">{container.name}</p><p className="text-xs text-muted-foreground">{container.ip || translateInterface("m737d8fa3e6b2")}</p></div>
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
              <Button variant="outline" size="sm" onClick={revokeAllPermissions}>{translateInterface("meceb04bfa892")}</Button>
            </div>
          )}
          {permissions.length === 0 ? (
            <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">{translateInterface("m8e6805519977")}</div>
          ) : permissions.map((permission) => (
            <div key={permission.id || permission.permission} className="flex items-start justify-between gap-3 rounded-md bg-accent/30 px-3 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{permissionTitle(permission)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{permissionDescription(permission)}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {permission.descriptor?.category && <Badge variant="outline">{permission.descriptor.category}</Badge>}
                  {permission.descriptor?.risk && <Badge variant="outline">{permission.descriptor.risk} {translateInterface("m2c6ef0f0d0e4")}</Badge>}
                  <Badge variant="outline">{permission.grantType || translateInterface("mdd515d1975b8")}</Badge>
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{permission.permission}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => revokeAppPermission(permission.permission)}>{translateInterface("m87e6d00bbf53")}</Button>
            </div>
          ))}
        </div>
      )}

      {tab === "network" && isAdmin && (
        <div className="rounded-lg border p-4 text-sm text-muted-foreground">
          {translateInterface("m0daef8af935c")}</div>
      )}

      {tab === "link-handling" && (
        <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">{translateInterface("m27e281ba50ac")}</div>
      )}
    </div>
  );
}

function AppBranding({ appId, appName, isAdmin }: { appId: string; appName: string; isAdmin: boolean }) {
  const translateInterface = useInterfaceTranslations("interface");

  const [tab, setTab] = useState<"my-branding" | "server-default">("my-branding");
  return (
    <div className="space-y-6">
      <div className="flex gap-1 border-b">
        <button className={tabClass(tab === "my-branding")} onClick={() => setTab("my-branding")}>{translateInterface("ma9f351a4b44d")}</button>
        {isAdmin && <button className={tabClass(tab === "server-default")} onClick={() => setTab("server-default")}>{translateInterface("m173243930c8e")}</button>}
      </div>
      {tab === "my-branding" && <AppBrandingEditor appId={appId} appName={appName} scope="user" />}
      {tab === "server-default" && isAdmin && <AppBrandingEditor appId={appId} appName={appName} scope="server" />}
    </div>
  );
}

function AppBrandingEditor({ appId, appName, scope }: { appId: string; appName: string; scope: BrandingScope }) {
  const translateInterface = useInterfaceTranslations("interface");

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
    setStatus(res.ok ? translateInterface("mb5c120b316c2") : translateInterface("m53ad6f999b1f"));
    setSaving(false);
  }

  async function reset() {
    setSaving(true);
    const res = await fetch(endpoint, { method: "DELETE" });
    setStatus(res.ok ? translateInterface("mdaee7606b339") : translateInterface("m089cb45b70a0"));
    await load();
    setSaving(false);
  }

  if (loading) return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">{isUser ? translateInterface("ma9f351a4b44d") : translateInterface("m173243930c8e")}</h3>
        <p className="text-[13px] text-muted-foreground">
          {isUser ? translateInterface("m0f65725af27c") : translateInterface("mf7dd68186a22")}
        </p>
      </div>

      {isUser && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">{translateInterface("m2b7f6a84de91")}</span>
            <input value={customName} onChange={(event) => setCustomName(event.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">{translateInterface("ma215d4d2a43d")}</span>
            <input value={customIconUrl} onChange={(event) => setCustomIconUrl(event.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder="https://..." />
          </label>
        </div>
      )}

      <label className="space-y-1.5 text-sm">
        <span className="font-medium">{translateInterface("mdaf03ec57700")}</span>
        <select value={headerDisplayMode} onChange={(event) => setHeaderDisplayMode(event.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm sm:max-w-xs">
          <option value="logo-text">{translateInterface("m473c351183d5")}</option>
          <option value="logo-only">{translateInterface("m7a0470083bd6")}</option>
          <option value="text-only">{translateInterface("ma10f973bb176")}</option>
        </select>
      </label>

      <WordArtPickerInline siteName={customName || appName} style={style} setStyle={(next) => { setStyle(next); if (isUser && next.mytitle) setCustomName(next.mytitle.name); }} />

      <div className="studio-save-bar flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{translateInterface("m1509f561f241")}</Button>
        {isUser && (
          <Button size="sm" variant="outline" onClick={reset} disabled={saving}>
            <RotateCcw className="h-4 w-4" />
            {translateInterface("mdaee7606b339")}</Button>
        )}
        {status && <span className="text-sm text-muted-foreground">{status}</span>}
      </div>
    </div>
  );
}

export function AppsClient({ isAdmin, hasUserContext = true, initialAppId }: { isAdmin: boolean; hasUserContext?: boolean; initialAppId?: string }) {
  const translateInterface = useInterfaceTranslations("interface");

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
      <PageHeader title={translateInterface("m89dd748442c1")} description={translateInterface("mbc5dbd212da8")} />
      {hasUserContext && <InstalledAppsList onOpen={setSelectedApp} />}
      {isAdmin && <AdminAppSections onOpen={setSelectedApp} />}
    </div>
  );
}
