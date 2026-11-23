"use client";

import { PageHeader } from "./page-header";

import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, CSSProperties } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import * as LucideIcons from "lucide-react";
import { AlertCircle, CheckCircle2, ChevronRight, ExternalLink, Loader2, Power, PowerOff, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { UpdateBlockedNote } from "@/components/market/update-blocked";
import { AppAccessSettings } from "@/components/market/app-access-settings";
import { AppDefaultCredentials, AppUninstall, AppUpdateSource } from "@/components/market/app-management";
import type { UpdateBlocked } from "@/lib/market/types";
import { uiSettingsApi } from "./api-base";
import { AppSection, groupClass, selectClass } from "./app-section";

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
  /** A Market app that gets no updates, and why. */
  updateBlocked?: UpdateBlocked | null;
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

type AppTab = "app-settings" | "overview" | "manage" | "ai" | "branding" | "permissions" | "network" | "link-handling";
const APP_TABS: AppTab[] = ["app-settings", "overview", "manage", "ai", "branding", "permissions", "network", "link-handling"];
type BrandingScope = "user" | "server";

function StatusDot({ status }: { status?: string | null }) {
  const color = status === "running" ? "bg-green-500" : status === "partial" ? "bg-amber-500" : status === "stopped" ? "bg-red-500" : "bg-muted-foreground";
  return <span className={`h-[5px] w-[5px] shrink-0 rounded-full ${color}`} />;
}

function isAppOff(app?: UnifiedApp | null) {
  return !!app && (app.enabled === false || app.desiredState === "stopped" || app.status === "stopped");
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

function AppIcon({ app, size = "md" }: { app: DrawerApp | UnifiedApp; size?: "md" | "lg" }) {
  const [imgError, setImgError] = useState(false);
  const name = "name" in app ? app.name : app.displayName;
  const icon = "custom_icon_url" in app ? app.custom_icon_url || app.icon : app.icon;
  const Icon = icon && !imgError ? getLucideIcon(icon) : null;
  const box = size === "lg" ? "h-14 w-14 rounded-2xl" : "h-9 w-9 rounded-lg";

  return (
    <div className={`flex shrink-0 items-center justify-center overflow-hidden bg-accent ${box}`}>
      {icon?.startsWith("emoji:") ? (
        <span className={size === "lg" ? "text-3xl" : "text-lg"}>{icon.slice(6)}</span>
      ) : icon && (icon.startsWith("/") || icon.startsWith("http") || icon.startsWith("data:")) ? (
        // eslint-disable-next-line @next/next/no-img-element
        !imgError ? <img src={icon} alt="" className={`object-cover ${box}`} onError={() => setImgError(true)} /> : <span className="text-sm font-bold text-muted-foreground">{name.charAt(0).toUpperCase()}</span>
      ) : Icon ? (
        <Icon className={size === "lg" ? "h-7 w-7 text-foreground/80" : "h-5 w-5 text-foreground/80"} />
      ) : (
        <span className="text-sm font-bold text-muted-foreground">{name.charAt(0).toUpperCase()}</span>
      )}
    </div>
  );
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
  return appId;
}

function permissionTitle(permission: Permission) {
  return permission.descriptor?.title || permission.permission;
}



function InstalledAppsList() {
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

  return (
    <AppSection
      id="installed"
      title={translateInterface("mdf76d7f1e93c")}
      action={
        <Link href="/market" className="inline-flex shrink-0 items-center rounded-sm text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11">
          {translateInterface("mfbf25423f41e")}
        </Link>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{translateInterface("mf8bcca389b95")}</div>
      ) : error ? (
        <p role="alert" className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><AlertCircle className="h-4 w-4 shrink-0" aria-hidden />{error}</p>
      ) : apps.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">{translateInterface("mf0b2cf399f5f")}</p>
      ) : (
        <ul className="settings-group">
          {apps.map((app) => (
            <li key={app.id}>
              <Link href={`/settings/apps/${encodeURIComponent(app.id)}`} className="settings-row hover:bg-accent/40">
                <AppIcon app={app} />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{app.name}</span>
                {/* A status only when the app is not running. */}
                {app.status === "stopped" && <span className="shrink-0 text-[13px] text-muted-foreground">{translateInterface("mca7981b46ecf")}</span>}
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AppSection>
  );
}

/** Apps shows the updates (`part="updates"`); System lists the platform's own components (`part="components"`). */
function AdminAppSections({ onOpen, part }: { onOpen: (id: string) => void; part: "updates" | "components" }) {
  const translateInterface = useInterfaceTranslations("interface");
  const t = useInterfaceTranslations("settingsApps");

  const [apps, setApps] = useState<UnifiedApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [statuses, setStatuses] = useState<Map<string, UpdateStatus>>(new Map());
  const [operations, setOperations] = useState<Map<string, AppUpdateOperation | null>>(new Map());
  const [operationErrors, setOperationErrors] = useState<Set<string>>(new Set());
  const [recovering, setRecovering] = useState<Set<string>>(new Set());
  const activeRequests = useRef(new Set<string>());
  const [confirmApp, setConfirmApp] = useState<UnifiedApp | null>(null);
  // An app added by URL whose new version changes its setup files: the update was refused and asks again.
  const [setupConsent, setSetupConsent] = useState<{ app: UnifiedApp; setups: { name: string; for: string }[] } | null>(null);
  const [maintAck, setMaintAck] = useState(false);
  const [dbAck, setDbAck] = useState(false);
  const updates = apps.filter((app) => app.updateAvailable || operations.get(app.id)?.pending);
  // Market apps that get no updates, with the reason (their source is gone, not accepted, or needs a newer YouEye).
  const blockedApps = apps.filter((app) => app.category === "user" && !!app.updateBlocked && !updates.includes(app));
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
      // Market SSE owns its progress while the request is active. The status
      // endpoint must not erase it or replay an older completed update.
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
    allowSetup = false,
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
          body: JSON.stringify(allowSetup ? { appId, allowSetup: true } : { appId }),
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
            if (event.code === "setup-changed") {
              const app = apps.find((candidate) => candidate.id === appId);
              if (app) setSetupConsent({ app, setups: Array.isArray(event.setups) ? event.setups : [] });
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
      {setupConsent && (
        <ConfirmDialog
          open
          title={translateInterface("mb94851be3547")}
          description={translateInterface("m5315fd906595", { app: setupConsent.app.displayName })}
          confirmLabel={translateInterface("ma4a46c8cbe85")}
          onCancel={() => setSetupConsent(null)}
          onConfirm={() => {
            const { app } = setupConsent;
            setSetupConsent(null);
            updateApp(app.id, undefined, true);
          }}
        >
          <ul className="space-y-1 rounded-lg border bg-muted/30 p-3 text-[13px]">
            {setupConsent.setups.map((setup) => (
              <li key={setup.name} className="flex items-center justify-between gap-3">
                <span className="font-mono text-xs">{setup.name}</span>
                <span className="text-muted-foreground">{setup.for}</span>
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      )}
      {confirmApp && (
        <ConfirmDialog
          open
          title={translateInterface("me0624c9267e4", { value0: String(confirmApp.displayName) })}
          description={translateInterface("m0bb71c644117", { value0: String(confirmApp.displayName), value1: String(confirmApp.containers[0]?.name ?? translateInterface("m7dddf9085fdd")) })}
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
      {part === "updates" && <AppSection
        id="updates"
        title={updates.length > 0 ? t("updates.available", { count: updates.length }) : t("updates.title")}
        action={updates.length > 0 ? (
          <Button variant="ghost" size="sm" className="shrink-0" onClick={checkUpdates} disabled={checking}>
            {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {checking ? t("updates.checking") : t("updates.check")}
          </Button>
        ) : undefined}
      >
        <div className={groupClass}>
          {/* Said once: nothing to do, and the way to look again. */}
          {updates.length === 0 && (
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5">
              <p className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" aria-hidden />
                {t("updates.upToDate")}
              </p>
              <Button variant="ghost" size="sm" className="shrink-0" onClick={checkUpdates} disabled={checking}>
                {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {checking ? t("updates.checking") : t("updates.check")}
              </Button>
            </div>
          )}
            {updates.map((app) => {
              const component = updateStatusComponent(app.id);
              const status = statuses.get(component);
              const operation = operations.get(app.id);
              const isUpdating = !operation?.recoveryRequired
                && !!status && !["idle", "completed", "failed"].includes(status.status);
              const statusUnavailable = app.category === "user"
                && (!operations.has(app.id) || operationErrors.has(app.id));
              return (
                <div key={app.id} className="min-w-0 px-4 py-3">
                  <div className="flex w-full min-w-0 items-center gap-3">
                    <button type="button" onClick={() => onOpen(app.id)} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                      <AppIcon app={app} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] font-medium text-foreground">{app.displayName}</p>
                        <p className="text-[13px] text-muted-foreground tabular-nums [overflow-wrap:anywhere]">{app.updateInfo || translateInterface("mff8b555d818f")}</p>
                      </div>
                    </button>
                    <Button size="sm" className="shrink-0" onClick={() => (app.systemManaged ? openConfirm(app) : updateApp(app.id))} disabled={isUpdating || !!operation?.pending || statusUnavailable}>
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
                        <span className="tabular-nums">{Math.max(0, Math.min(100, status.progress || 0))}%</span>
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
          {blockedApps.map((app) => (
            <div key={`blocked-${app.id}`} className="min-w-0 px-4 py-3">
              <button type="button" onClick={() => onOpen(app.id)} className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                <AppIcon app={app} />
                <p className="min-w-0 flex-1 truncate text-[15px] font-medium text-foreground">{app.displayName}</p>
              </button>
              <UpdateBlockedNote blocked={app.updateBlocked!} appId={app.id} className="mt-2" />
            </div>
          ))}
        </div>
        {updates.length > 0 && <p className="text-xs leading-relaxed text-muted-foreground">{translateInterface("mcad7ceef401a")}</p>}
      </AppSection>}

      {part === "components" && <section className="overflow-hidden rounded-xl border bg-card">
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
      </section>}
    </>
  );
}

/** The platform's own components (Incus, Spine, PostgreSQL, Caddy…), on the System page. */
export function SystemComponents() {
  const router = useRouter();
  return <AdminAppSections part="components" onOpen={(id) => router.push(`/settings/apps/${encodeURIComponent(id)}?from=system`)} />;
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
    <div className="min-w-0 space-y-3">
      {error && <Alert variant="destructive">{error}</Alert>}
      {notice && <Alert>{notice}</Alert>}
      {needsAttention && (
        <Alert variant="destructive">
          {translateInterface("m283317ddeb03")}</Alert>
      )}
      <div className={groupClass}>
        <div className="flex min-w-0 items-center justify-between gap-4 px-4 py-3.5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{translateInterface("m18ff0c26ee4a")}</p>
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
              {translateInterface("mad79cfea2624", {app: title})}
            </p>
          </div>
          <Switch
            className="shrink-0"
            checked={status.enabled}
            disabled={busy || (!ownerIsCurrent && !status.enabled) || (!status.connection && !groupId)}
            onCheckedChange={(enabled) => void mutate(enabled ? "enable" : "disable", enabled ? groupId : undefined)}
            aria-label={translateInterface("mfb666f84a9c2", {app: title})}
          />
        </div>

        <div className="grid min-w-0 gap-4 px-4 py-3.5 md:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <Label htmlFor={`ai-group-${appId}`}>{translateInterface("madb24ff365bd")}</Label>
            <Select
              value={groupId}
              disabled={busy || !ownerIsCurrent}
              onValueChange={(value) => {
                setGroupId(value);
                if (status.connection && ownerIsCurrent) void mutate("change_group", value);
              }}
            >
              <SelectTrigger id={`ai-group-${appId}`} className="w-full min-w-0"><SelectValue placeholder={translateInterface("m0c7e5871a4e6")} /></SelectTrigger>
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
          <div className="min-w-0 text-sm">
            <p className="font-medium">{translateInterface("m639a40e82b9a")}</p>
            <p className="mt-1 text-muted-foreground [overflow-wrap:anywhere]">
              {status.connection
                ? `${status.connection.groupName} · ${status.connection.keyPreview}`
                : translateInterface("m4a1c5d30939d", { value0: String(title) })}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{translateInterface("m8d2a4592acd4")}<code>default</code></p>
          </div>
        </div>

        {!ownerIsCurrent && status.connection && (
          <div className="flex min-w-0 flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium">{translateInterface("m0eba3d4ee43f")}{status.installation?.routingOwner?.displayName || translateInterface("mc13dc9685345")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{translateInterface("m615937f6702b")}</p>
            </div>
            <Button variant="outline" className="shrink-0" disabled={busy || !groupId} onClick={() => void mutate("takeover", groupId)}>
              {translateInterface("m3213cd836138")}</Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Old `?tab=` links land on the section that took the tab's place. */
const TAB_SECTIONS: Record<AppTab, string | null> = {
  overview: null,
  "app-settings": "settings",
  manage: "access",
  ai: "ai",
  branding: "name-and-icon",
  permissions: "permissions",
  network: "diagnostics",
  "link-handling": "diagnostics",
};

function AppDetail({ appId, isAdmin, hasUserContext }: { appId: string; isAdmin: boolean; hasUserContext: boolean }) {
  const translateInterface = useInterfaceTranslations("interface");
  const t = useInterfaceTranslations("settingsApps");
function permissionDescription(permission: Permission) {
  if (permission.descriptor?.description) return permission.descriptor.description;
  return translateInterface("m40ff0a06c8a1");
}


  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab") as AppTab | null;
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
  // Diagnostics is folded until someone opens it (or an old Network / Link handling link does).
  const [diagnosticsOpen, setDiagnosticsOpen] = useState<boolean | null>(null);
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

  // Old tab links (?tab=permissions) and anchors (#permissions): go to the section and move focus to its heading.
  useEffect(() => {
    if (loading) return;
    const target = (requestedTab && APP_TABS.includes(requestedTab) ? TAB_SECTIONS[requestedTab] : null)
      || (() => { try { return decodeURIComponent(window.location.hash.slice(1)); } catch { return ""; } })()
      || null;
    if (!target) return;
    if (target === "diagnostics") setDiagnosticsOpen(true);
    let stopped = false;
    const go = (focus: boolean) => {
      if (stopped) return;
      const section = document.getElementById(target);
      if (!section) return;
      section.scrollIntoView({ block: "start" });
      if (focus) document.getElementById(`${target}-heading`)?.focus({ preventScroll: true });
    };
    const frame = window.requestAnimationFrame(() => go(true));
    // Sections above load their own data and push this one down: settle once more, unless the reader has moved on.
    const timer = window.setTimeout(() => go(false), 700);
    const stop = () => { stopped = true; };
    window.addEventListener("wheel", stop, { passive: true, once: true });
    window.addEventListener("touchstart", stop, { passive: true, once: true });
    window.addEventListener("keydown", stop, { once: true });
    return () => {
      stopped = true;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchstart", stop);
      window.removeEventListener("keydown", stop);
    };
  }, [loading, requestedTab]);

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
  const off = unifiedApp ? isAppOff(unifiedApp) : drawerApp?.status === "stopped";
  const isUserApp = unifiedApp?.category === "user";
  const controllable = isAdmin && isUserApp && (unifiedApp?.containers?.length ?? 0) > 0;
  const credentialState = unifiedApp?.serviceCredentialState;
  const databaseNote = unifiedApp?.databaseMode === "shared"
    ? translateInterface("m2b43e68d0127")
    : unifiedApp?.databaseMode === "own"
      ? translateInterface("m0a30a7ab7ad1")
      : translateInterface("m54dd7b4ad1cb");

  // The one place the app's state is said, and only when it is not simply running.
  const healthState = unifiedApp?.appHealthState;
  const status: { text: string; serious: boolean } | null =
    credentialState === "revoked" ? { text: translateInterface("m2a6af261ee1c"), serious: true }
    : credentialState === "pending" ? { text: translateInterface("m3727b0acb45f"), serious: false }
    : powerPending === "stop" ? { text: translateInterface("md54dbde107ff", { app: title }), serious: false }
    : powerPending === "start" ? { text: translateInterface("mc5e3c57a0200", { app: title }), serious: false }
    : powerPending === "restart" ? { text: translateInterface("m50b3619959e5", { app: title }), serious: false }
    : off ? { text: controllable ? translateInterface("mf649fdfe21ba", { value0: String(title) }) : t("status.off", { app: title }), serious: true }
    : healthState === "crash-looping" ? { text: t("status.crashLooping", { app: title }), serious: true }
    : healthState === "unhealthy" ? { text: t("status.unhealthy", { app: title }), serious: true }
    : healthState === "starting" ? { text: translateInterface("mc5e3c57a0200", { app: title }), serious: false }
    : healthState === "maintenance" ? { text: t("status.maintenance", { app: title }), serious: false }
    : unifiedApp?.status === "partial" ? { text: t("status.partial", { app: title }), serious: false }
    : null;
  const healthDetail = unifiedApp?.healthDetail && healthState && healthState !== "running" ? unifiedApp.healthDetail : null;

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  if (!drawerApp && !unifiedApp) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground [overflow-wrap:anywhere]">{appId}</h1>
        <p className="text-sm text-muted-foreground">{t("notFound")}</p>
        <Button variant="outline" asChild><Link href="/settings/apps">{t("backToApps")}</Link></Button>
      </div>
    );
  }

  const canStart = controllable && off && credentialState !== "pending" && credentialState !== "revoked";
  const canOpen = !!drawerApp?.url && !off;
  const hasActions = canOpen || canStart || (controllable && !off) || (isAdmin && credentialState === "pending");
  const showPermissions = hasUserContext && (!!drawerApp || isUserApp || permissions.length > 0);
  const showLook = hasUserContext && (!!drawerApp || isUserApp);
  const showDiagnostics = isAdmin && !!unifiedApp;
  // A platform component's page is mostly its diagnostics: open them there.
  const diagnosticsShown = diagnosticsOpen ?? !isUserApp;

  return (
    <div className="min-w-0 space-y-10">
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

      <header id="overview" className="min-w-0 scroll-mt-24 space-y-4">
        <div className="flex min-w-0 items-start gap-4">
          <AppIcon size="lg" app={drawerApp || unifiedApp || { id: appId, displayName: title, description: "", icon: "", category: "user", type: "", containers: [], status: "unknown", updateAvailable: false }} />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground [overflow-wrap:anywhere]">{title}</h1>
            {unifiedApp?.description && <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{unifiedApp.description}</p>}
            {unifiedApp?.version && <p className="mt-1 text-[13px] text-muted-foreground tabular-nums">{t("version", { version: unifiedApp.version })}</p>}
          </div>
        </div>

        {(status || powerError) && (
          <div className="space-y-1" aria-live="polite">
            {status && (
              <p role="status" className="flex min-w-0 items-start gap-2 text-sm text-foreground">
                <span className={`mt-[.45rem] h-2 w-2 shrink-0 rounded-full ${status.serious ? "bg-destructive" : "bg-amber-500"}`} aria-hidden />
                <span className="min-w-0">{status.text}{healthDetail ? ` ${healthDetail}` : ""}</span>
              </p>
            )}
            {powerError && <p role="alert" className="text-sm text-destructive">{powerError}</p>}
          </div>
        )}

        {hasActions && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {canOpen && (
              <Button asChild>
                <a href={drawerApp!.url!}>
                  <ExternalLink />
                  {t("open")}</a>
              </Button>
            )}
            {canStart && (
              <Button onClick={() => controlPower("start")} disabled={powerPending !== null}>
                {powerPending === "start" ? <Loader2 className="animate-spin" /> : <Power />}
                {translateInterface("m2e4f3ea97036")}</Button>
            )}
            {isAdmin && credentialState === "pending" && (
              <Button variant="outline" onClick={() => void reconcileCredentials()} disabled={credentialPending}>
                {credentialPending && <Loader2 className="animate-spin" />}
                {credentialPending ? translateInterface("m393dc4a3ec89") : translateInterface("m3b6c613892eb")}
              </Button>
            )}
            {controllable && !off && (
              <>
                <Button variant="ghost" onClick={() => controlPower("restart")} disabled={powerPending !== null}>
                  {powerPending === "restart" ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                  {translateInterface("m6b983a81e5e8")}</Button>
                <Button variant="ghost" onClick={() => setConfirmStop(true)} disabled={powerPending !== null}>
                  {powerPending === "stop" ? <Loader2 className="animate-spin" /> : <PowerOff />}
                  {t("turnOff")}</Button>
              </>
            )}
          </div>
        )}
      </header>

      {drawerApp && hasAppSettings && (
        <AppSection id="settings" title={t("appSettings")}>
          <AppSettingsEmbed app={drawerApp} />
        </AppSection>
      )}

      {showPermissions && (
        <AppSection id="permissions" title={t("permissions.title")}>
          {permissions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("permissions.none", { app: title })}</p>
          ) : (
            <>
              <ul className="settings-group">
                {permissions.map((permission) => {
                  const facts = [
                    permission.descriptor?.category,
                    permission.descriptor?.risk ? `${permission.descriptor.risk} ${translateInterface("m2c6ef0f0d0e4")}` : null,
                    permission.grantType,
                  ].filter(Boolean).join(" · ");
                  return (
                    <li key={permission.id || permission.permission} className="flex min-w-0 flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground [overflow-wrap:anywhere]">{permissionTitle(permission)}</p>
                        <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{permissionDescription(permission)}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground/80 [overflow-wrap:anywhere]">
                          {facts ? `${facts} · ` : ""}<span className="font-mono">{permission.permission}</span>
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0 self-start"
                        onClick={() => revokeAppPermission(permission.permission)}
                        aria-label={t("permissions.revokeNamed", { permission: permissionTitle(permission) })}
                      >{translateInterface("m87e6d00bbf53")}</Button>
                    </li>
                  );
                })}
              </ul>
              {permissions.length > 1 && (
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={revokeAllPermissions}>{t("permissions.revokeAll")}</Button>
              )}
            </>
          )}
        </AppSection>
      )}

      {showLook && <AppLook appId={appId} appName={title} scope="user" onChanged={() => { load().catch(() => {}); }} />}

      {isAdmin && aiSupported && (
        <AppSection id="ai" title={translateInterface("m11fb682be0a0")}>
          <AppAISettings appId={appId} title={title} />
        </AppSection>
      )}

      {isAdmin && isUserApp && (
        <AppSection id="access" title={t("access.title")}>
          {signIn?.available && (
            <div className={groupClass}>
              <div className="flex min-w-0 items-center justify-between gap-4 px-4 py-3.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{translateInterface("mfb7ed10de1ed")}</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
                    {signInPending !== null
                      ? <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" />{signInPending ? translateInterface("m8f71b12330db", { app: title }) : translateInterface("m709433447a43", { app: title })}</span>
                      : signIn.enabled ? translateInterface("m3bf590b2bb82", { app: title }) : translateInterface("m2f5875924e6c", { app: title })}
                  </p>
                  {signInError ? <p role="alert" className="mt-1 text-[13px] text-destructive">{signInError}</p> : null}
                </div>
                <Switch
                  className="shrink-0"
                  checked={signInPending ?? signIn.enabled}
                  disabled={signInPending !== null}
                  onCheckedChange={(enabled) => void setYouEyeSignIn(enabled)}
                  aria-label={translateInterface("m70843fac04a3", { app: title })}
                />
              </div>
            </div>
          )}
          <AppAccessSettings appId={appId} />
        </AppSection>
      )}

      {isAdmin && isUserApp && <AppDefaultCredentials appId={appId} />}

      {isAdmin && showLook && <AppLook appId={appId} appName={title} scope="server" />}

      {isAdmin && isUserApp && (
        <AppUpdateSource appId={appId} updateInfo={unifiedApp?.updateAvailable ? unifiedApp.updateInfo || "" : null} />
      )}

      {showDiagnostics && unifiedApp && (
        <section id="diagnostics" className="min-w-0 scroll-mt-24">
          <details
            className="group"
            open={diagnosticsShown}
            onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}
          >
            <summary
              id="diagnostics-heading"
              className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden"
            >
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
              <h2 className="text-base font-semibold text-foreground">{t("diagnostics.title")}</h2>
            </summary>
            <div className={`${groupClass} mt-3`}>
              {controllable && (
                <div className="flex min-w-0 items-center justify-between gap-4 px-4 py-3.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{translateInterface("md7b62393f565")}</p>
                    <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{translateInterface("mc2fbdcac2b30")}</p>
                    {healthPolicyError ? <p role="alert" className="mt-1 text-[13px] text-destructive">{healthPolicyError}</p> : null}
                  </div>
                  <Switch
                    className="shrink-0"
                    checked={unifiedApp.autoRestart !== false}
                    disabled={healthPolicyPending}
                    onCheckedChange={setAutomaticRecovery}
                    aria-label={translateInterface("m73999e808689", { value0: String(title) })}
                  />
                </div>
              )}
              <dl className="grid min-w-0 gap-x-6 gap-y-3 px-4 py-3.5 text-sm sm:grid-cols-2">
                <div className="min-w-0">
                  <dt className="text-[13px] text-muted-foreground">{translateInterface("mbaaddf70fb5d")}</dt>
                  <dd className="font-medium [overflow-wrap:anywhere]">{unifiedApp.type || "app"}</dd>
                </div>
                {unifiedApp.failingLevel && (
                  <div className="min-w-0">
                    <dt className="text-[13px] text-muted-foreground">{t("diagnostics.failingCheck")}</dt>
                    <dd className="font-medium">{unifiedApp.failingLevel}</dd>
                  </div>
                )}
                {drawerApp?.url && (
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-[13px] text-muted-foreground">{t("diagnostics.address")}</dt>
                    <dd className="font-mono text-[13px] [overflow-wrap:anywhere]">{drawerApp.url}</dd>
                  </div>
                )}
              </dl>
              {unifiedApp.containers?.map((container) => (
                <div key={container.name} className="flex min-w-0 items-center justify-between gap-4 px-4 py-3.5 text-sm">
                  <div className="min-w-0">
                    <p className="font-mono text-[13px] font-medium [overflow-wrap:anywhere]">{container.name}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">{container.ip || translateInterface("m737d8fa3e6b2")}</p>
                  </div>
                  <span className="shrink-0 text-[13px] text-muted-foreground">{container.status}</span>
                </div>
              ))}
              <p className="px-4 py-3.5 text-[13px] leading-relaxed text-muted-foreground">{t("diagnostics.network")}</p>
            </div>
          </details>
        </section>
      )}

      {isAdmin && isUserApp && <AppUninstall appId={appId} appName={title} />}
    </div>
  );
}

/**
 * How an app is shown: for you (`user`: your name for it, its icon, how it shows in the header) or the default for
 * everyone (`server`, admins). The title itself is drawn in the studio, on its own page.
 */
function AppLook({ appId, appName, scope, onChanged }: { appId: string; appName: string; scope: BrandingScope; onChanged?: () => void }) {
  const translateInterface = useInterfaceTranslations("interface");
  const t = useInterfaceTranslations("settingsApps");

  const [headerDisplayMode, setHeaderDisplayMode] = useState("logo-text");
  const [customName, setCustomName] = useState("");
  const [originalName, setOriginalName] = useState(appName);
  const [customIconUrl, setCustomIconUrl] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const isUser = scope === "user";
  const endpoint = uiSettingsApi(`apps/branding/${scope}/${encodeURIComponent(appId)}`);
  const sectionId = isUser ? "name-and-icon" : "default-look";

  const load = useCallback(async () => {
    const res = await fetch(endpoint);
    if (!res.ok) { setState("missing"); return; }
    const data = await res.json();
    setHeaderDisplayMode(data.headerDisplayMode ?? "logo-text");
    setOriginalName(data.originalName ?? appName);
    setCustomName(data.customName ?? "");
    setCustomIconUrl(data.customIconUrl ?? "");
    setState("ready");
  }, [appName, endpoint]);

  useEffect(() => { load().catch(() => setState("missing")); }, [load]);

  // Only what this form shows is sent; the title drawn in the studio is left as it is.
  async function save() {
    setSaving(true);
    const payload: Record<string, unknown> = { headerDisplayMode };
    if (isUser) {
      const name = customName.trim();
      payload.customName = name && name !== originalName ? name : null;
      payload.customIconUrl = customIconUrl.trim() || null;
    }
    const res = await fetch(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
    setStatus(res?.ok ? translateInterface("mb5c120b316c2") : translateInterface("m53ad6f999b1f"));
    setSaving(false);
    if (res?.ok) onChanged?.();
  }

  async function reset() {
    setSaving(true);
    const res = await fetch(endpoint, { method: "DELETE" }).catch(() => null);
    setStatus(res?.ok ? t("look.resetDone") : translateInterface("m089cb45b70a0"));
    await load().catch(() => {});
    setSaving(false);
    if (res?.ok) onChanged?.();
  }

  // Not one of this person's apps (a platform component, say): nothing to name.
  if (state === "missing") return null;

  const fieldId = `${sectionId}-${appId}`;
  return (
    <AppSection
      id={sectionId}
      title={isUser ? t("look.title") : t("look.defaultTitle")}
      description={isUser ? t("look.description") : t("look.defaultDescription")}
    >
      {state === "loading" ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className={groupClass}>
          <div className="space-y-4 p-4">
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              {isUser && (
                <>
                  <div className="min-w-0 space-y-1.5">
                    <Label htmlFor={`${fieldId}-name`}>{translateInterface("m2b7f6a84de91")}</Label>
                    <Input id={`${fieldId}-name`} value={customName} placeholder={originalName} autoComplete="off" onChange={(event) => setCustomName(event.target.value)} />
                  </div>
                  <div className="min-w-0 space-y-1.5">
                    <Label htmlFor={`${fieldId}-icon`}>{t("look.iconUrl")}</Label>
                    <Input id={`${fieldId}-icon`} type="url" inputMode="url" value={customIconUrl} placeholder="https://..." autoComplete="off" spellCheck={false} onChange={(event) => setCustomIconUrl(event.target.value)} />
                  </div>
                </>
              )}
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor={`${fieldId}-header`}>{t("look.headerDisplay")}</Label>
                <select id={`${fieldId}-header`} value={headerDisplayMode} onChange={(event) => setHeaderDisplayMode(event.target.value)} className={selectClass}>
                  <option value="logo-text">{translateInterface("m473c351183d5")}</option>
                  <option value="logo-only">{translateInterface("m7a0470083bd6")}</option>
                  <option value="text-only">{translateInterface("ma10f973bb176")}</option>
                </select>
              </div>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Button size="sm" onClick={save} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{translateInterface("m1509f561f241")}</Button>
              {isUser && (
                <Button size="sm" variant="ghost" onClick={reset} disabled={saving}>
                  <RotateCcw className="h-4 w-4" />
                  {t("look.reset")}</Button>
              )}
              {status && <span role="status" className="text-sm text-muted-foreground">{status}</span>}
            </div>
          </div>
          <Link
            href={`/settings/apps/${encodeURIComponent(appId)}/title${isUser ? "" : "?scope=server"}`}
            className="settings-row hover:bg-accent/40"
          >
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-foreground">{isUser ? t("look.customiseTitle") : t("look.customiseDefaultTitle")}</span>
              <span className="block text-[13px] text-muted-foreground">{t("look.customiseTitleHint")}</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Link>
        </div>
      )}
    </AppSection>
  );
}

export function AppsClient({ isAdmin, hasUserContext = true, initialAppId }: { isAdmin: boolean; hasUserContext?: boolean; initialAppId?: string }) {
  const translateInterface = useInterfaceTranslations("interface");
  const router = useRouter();
  const searchParams = useSearchParams();
  // Old links: /settings/apps?app=<id>.
  const appId = initialAppId || searchParams.get("app");
  const open = (id: string) => router.push(`/settings/apps/${encodeURIComponent(id)}`);

  // The way back (to Apps, or to System for its components) is the Settings shell's.
  if (appId) return <AppDetail appId={appId} isAdmin={isAdmin} hasUserContext={hasUserContext} />;

  return (
    <div className="min-w-0 space-y-8">
      <PageHeader title={translateInterface("m89dd748442c1")} description={translateInterface("mbc5dbd212da8")} />
      {hasUserContext && <InstalledAppsList />}
      {isAdmin && <AdminAppSections part="updates" onOpen={open} />}
    </div>
  );
}
