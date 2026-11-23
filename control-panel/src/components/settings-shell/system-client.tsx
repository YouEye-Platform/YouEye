"use client";

import { PageHeader } from "./page-header";

import { useLocale } from "next-intl";
import { useTranslations as useInterfaceTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  ChevronRight,
  Clock,
  Cog,
  Cpu,
  Database,
  HardDrive,
  HeartPulse,
  KeyRound,
  LayoutDashboard,
  Loader2,
  type LucideIcon,
  MemoryStick,
  Monitor,
  RefreshCw,
  Route,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApplianceSystemUpdate } from "@/components/settings-shell/appliance-system-update";
import { restartServiceRequest } from "@/lib/health/client";
import type { SpinePersistentStatus, SpineRuntimeStatus } from "@/lib/spine/client";

interface SystemInfo {
  hostname: string;
  os: string;
  kernel: string;
  uptime: string;
  load_average: string | null;
  cpu: null | { cores: number; model: string; usage_percent?: string };
  memory: null | { total_mb: number; used_mb: number; free_mb: number };
  disk: null | { total_gb: number; used_gb: number; free_gb: number };
  incus: { version: string; storage_pool: string };
  containers: { total: number; running: number; stopped: number; items: Array<{ name: string; status: string }> };
  runtime: SpineRuntimeStatus;
  persistent_state: SpinePersistentStatus | null;
}

interface ServiceHealth {
  slug: string;
  name: string;
  version: string;
  status: string;
  cpuPercent: number;
  memory: number; // MB
  restartable: boolean;
  uptime: string;
}

type TrackingStatus = "tracked" | "untracked" | "missing";

interface SystemUpdatePlan {
  id: "postgresql" | "caddy" | "pihole";
  containerName: string;
  desiredImage: string;
  desiredVersion: string;
  exists: boolean;
  running: boolean;
  trackingStatus: TrackingStatus;
  currentImage?: string;
  currentVersion?: string;
  updateAvailable: boolean;
  recreateRecommended: boolean;
  reason: string;
}

/** A platform component as `/api/apps/unified` lists it (the source the old "System components" list used). */
interface PlatformComponent {
  id: string;
  displayName: string;
  description: string;
  category: "system" | "infrastructure" | "user";
  version?: string;
  status: string;
  appHealthState?: string;
}

// One list, in the order a person thinks about the server: the system itself, what people see, what apps rely on.
const SERVICE_ORDER = ["host-system", "spine", "control-panel", "ui", "postgres", "caddy", "pihole", "pointer", "incus"];
// The pinned images are named by image id; the services by slug.
const IMAGE_SERVICE: Record<SystemUpdatePlan["id"], string> = { postgresql: "postgres", caddy: "caddy", pihole: "pihole" };

function fmtMB(mb: number, locale: string) {
  if (!mb || mb <= 0) return "—";
  return mb >= 1024 ? `${(mb / 1024).toLocaleString(locale, {minimumFractionDigits: 1, maximumFractionDigits: 1})} GB` : `${Math.round(mb).toLocaleString(locale)} MB`;
}

function pct(used: number, total: number) {
  return total > 0 ? Math.round((used / total) * 100) : 0;
}

// Versions sometimes come back empty or token-like; only show a short, sane string.
function showVersion(v: string | undefined) {
  if (!v || v.length > 24 || /\s/.test(v)) return "";
  return v.startsWith("v") || /[a-z]/i.test(v) ? v : `v${v}`;
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  meter,
  warn,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  meter?: number;
  warn?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 truncate text-lg font-bold tracking-tight tabular-nums sm:text-[22px]" title={value}>{value}</div>
      {meter !== undefined && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div className={`h-full rounded-full ${warn ? "bg-amber-500" : "bg-primary"}`} style={{ width: `${Math.min(Math.max(meter, 0), 100)}%` }} />
        </div>
      )}
      {sub && <div className="mt-1.5 truncate text-[12px] tabular-nums text-muted-foreground" title={sub}>{sub}</div>}
    </div>
  );
}

const STATE_KEYS: Record<string, { key: string; tone: "ok" | "warn" | "bad" | "none" }> = {
  running: { key: "running", tone: "ok" },
  ok: { key: "running", tone: "ok" },
  healthy: { key: "running", tone: "ok" },
  "image-managed": { key: "imageManaged", tone: "ok" },
  starting: { key: "starting", tone: "warn" },
  partial: { key: "partial", tone: "warn" },
  degraded: { key: "degraded", tone: "warn" },
  "repair-required": { key: "needsRepair", tone: "warn" },
  stopped: { key: "stopped", tone: "bad" },
  error: { key: "error", tone: "bad" },
  unhealthy: { key: "error", tone: "bad" },
  "not-found": { key: "notInstalled", tone: "none" },
  "not-installed": { key: "notInstalled", tone: "none" },
  unknown: { key: "unknown", tone: "none" },
};

/** A service's state in words, with a dot that repeats it (never colour alone). */
function ServiceState({ status }: { status: string }) {
  const t = useInterfaceTranslations("settingsSystem");
  const known = STATE_KEYS[status];
  const tone = known?.tone ?? "warn";
  const dot = tone === "ok" ? "bg-green-500" : tone === "warn" ? "bg-amber-500" : tone === "bad" ? "bg-destructive" : "bg-muted-foreground";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] text-muted-foreground">
      <span className={`inline-block size-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
      {known ? t(`services.state.${known.key}`) : status}
    </span>
  );
}

// Unsafe requests carry the session's CSRF token, which the route checks (requireAdminCsrf).
async function systemUpdateCsrfToken(): Promise<string> {
  const response = await fetch("/settings/api/auth/csrf", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.csrfToken !== "string") throw new Error("Could not get a CSRF token; reload the page.");
  return body.csrfToken as string;
}

/**
 * System, in two pages. The overview: updates first, then the machine's load, then a list of the rest. Services
 * (`view="services"`): one list of everything that runs the server (what it does, version, live usage, state,
 * Restart where there is one), with the pinned container images folded at the end.
 * `release`: the installed release's version, shown for the parts it installed (the system, Spine, the Control Panel).
 */
export function SystemClient({ release, view = "overview" }: { release?: string; view?: "overview" | "services" }) {
  const systemPages = useInterfaceTranslations("systemPages");
  const locale = useLocale();
  const translateInterface = useInterfaceTranslations("interface");
  const t = useInterfaceTranslations("settingsSystem");
  const SERVICE_META: Record<string, { name: string; desc: string; icon: LucideIcon }> = {
    "host-system": { name: t("services.host.name"), desc: t("services.host.desc"), icon: Server },
    spine: { name: translateInterface("m6a81c94a4745"), desc: translateInterface("m0fc6d6605ce1"), icon: Cog },
    "control-panel": { name: translateInterface("m0d6a16e62a51"), desc: translateInterface("m52858a1e8a21"), icon: Monitor },
    ui: { name: t("services.ui.name"), desc: t("services.ui.desc"), icon: LayoutDashboard },
    postgres: { name: translateInterface("mfa7fe67124e9"), desc: translateInterface("me73f7545c5d6"), icon: Database },
    caddy: { name: translateInterface("m0ffcd855ea52"), desc: translateInterface("mcf227fcff97c"), icon: Route },
    pihole: { name: translateInterface("m434eceb156ee"), desc: translateInterface("m5694cd21cd72"), icon: ShieldCheck },
    pointer: { name: translateInterface("mb535945fa809"), desc: t("services.ai.desc"), icon: Sparkles },
    incus: { name: t("services.incus.name"), desc: t("services.incus.desc"), icon: Box },
  };

  const [data, setData] = useState<SystemInfo | null>(null);
  const [health, setHealth] = useState<ServiceHealth[]>([]);
  const [components, setComponents] = useState<PlatformComponent[]>([]);
  const [openIssues, setOpenIssues] = useState<number | null>(null);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [restartError, setRestartError] = useState("");
  const [systemPlans, setSystemPlans] = useState<SystemUpdatePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [plansLoading, setPlansLoading] = useState(true);
  const [error, setError] = useState("");
  const [planError, setPlanError] = useState("");
  const [dryRunStatus, setDryRunStatus] = useState<Record<string, string>>({});
  const [updateStatus, setUpdateStatus] = useState<Record<string, string>>({});
  const [confirmPlan, setConfirmPlan] = useState<SystemUpdatePlan | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [maintenanceConfirmed, setMaintenanceConfirmed] = useState(false);

  const metricsPending = useRef(false);
  const load = useCallback(async (background = false) => {
    if (metricsPending.current) return;
    metricsPending.current = true;
    if (!background) setLoading(true);
    try {
      const res = await fetch("/settings/api/settings/system");
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || translateInterface("m0d5b1c282a63"));
      setData(await res.json());
      setError("");
    } catch (error) {
      setError(translateInterface("m0d5b1c282a63"));
    } finally {
      metricsPending.current = false;
      if (!background) setLoading(false);
    }
  }, [translateInterface]);

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health/services");
      if (res.ok) {
        const body = await res.json();
        if (Array.isArray(body)) setHealth(body);
      }
    } catch {
      // health is supplementary; the page still renders from system info.
    }
  }, []);

  // The platform's own components (host system, container engine, dashboard…): the rows that open a detail page.
  const loadComponents = useCallback(async () => {
    try {
      const res = await fetch("/api/apps/unified");
      if (!res.ok) return;
      const body = await res.json();
      if (Array.isArray(body.apps)) setComponents((body.apps as PlatformComponent[]).filter((app) => app.category !== "user"));
    } catch {
      // supplementary; the list still shows the services it knows.
    }
  }, []);

  const loadSystemPlans = useCallback(async () => {
    setPlansLoading(true);
    setPlanError("");
    const res = await fetch("/settings/api/deploy/infrastructure/system-updates");
    if (res.ok) {
      const body = await res.json();
      setSystemPlans(body.systems ?? []);
    } else {
      setPlanError((await res.json().catch(() => ({}))).error || translateInterface("m01bac47c0645"));
    }
    setPlansLoading(false);
  }, [translateInterface]);

  const services = view === "services";

  useEffect(() => {
    load();
    if (services) loadSystemPlans();
  }, [load, loadSystemPlans, services]);

  // The overview shows how many health issues are open, on the Health row.
  useEffect(() => {
    if (services) return;
    let stopped = false;
    fetch("/api/health/issues")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (!stopped && typeof body?.summary?.open === "number") setOpenIssues(body.summary.open); })
      .catch(() => { /* the row simply shows no count */ });
    return () => { stopped = true; };
  }, [services]);

  // Refresh the figures and the component list. Schedule after each
  // response so slow requests cannot overlap or flash the full-page loader.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      await Promise.all([load(true), services ? loadComponents() : Promise.resolve()]);
      if (!stopped) timer = setTimeout(refresh, 15_000);
    };
    if (services) void loadComponents();
    timer = setTimeout(refresh, 15_000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [load, loadComponents, services]);

  // Live usage refreshes every 5s.
  useEffect(() => {
    if (!services) return;
    loadHealth();
    const id = setInterval(loadHealth, 5000);
    return () => clearInterval(id);
  }, [loadHealth, services]);

  async function restartService(slug: string) {
    setRestarting(slug);
    setRestartError("");
    try {
      await restartServiceRequest(slug);
      await loadHealth();
    } catch (error) {
      setRestartError(error instanceof Error ? error.message : translateInterface("mb8864cf013b4"));
    } finally {
      setRestarting(null);
    }
  }

  async function readSystemUpdateStream(response: Response, onMessage: (message: string) => void, fallback: string) {
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || translateInterface("m794d8a679576"));
    }
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let latest = "";
    if (!reader) throw new Error(translateInterface("m54003f79a588"));
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const line = chunk.split("\n").find((item) => item.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice(6)) as { status: string; message: string };
        latest = event.message;
        onMessage(event.message);
      }
    }
    if (!latest) onMessage(fallback);
  }

  async function dryRun(plan: SystemUpdatePlan) {
    setDryRunStatus((current) => ({ ...current, [plan.id]: "Planning..." }));
    try {
      const response = await fetch("/settings/api/deploy/infrastructure/system-updates", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": await systemUpdateCsrfToken() },
        body: JSON.stringify({
          systemId: plan.id,
          dryRun: true,
          adoptUntracked: plan.trackingStatus !== "tracked",
          allowDatabaseUpdate: plan.id === "postgresql",
        }),
      });
      await readSystemUpdateStream(
        response,
        (message) => setDryRunStatus((current) => ({ ...current, [plan.id]: message })),
        translateInterface("m460fd508c6f3"),
      );
    } catch (err) {
      setDryRunStatus((current) => ({
        ...current,
        [plan.id]: err instanceof Error ? err.message : translateInterface("md85ad7988caf"),
      }));
    }
  }

  async function runConfirmedUpdate(plan: SystemUpdatePlan) {
    setUpdateStatus((current) => ({ ...current, [plan.id]: "Starting..." }));
    setConfirmPlan(null);
    setConfirmName("");
    setMaintenanceConfirmed(false);
    try {
      const response = await fetch("/settings/api/deploy/infrastructure/system-updates", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": await systemUpdateCsrfToken() },
        body: JSON.stringify({
          systemId: plan.id,
          dryRun: false,
          adoptUntracked: plan.trackingStatus !== "tracked",
          allowDatabaseUpdate: plan.id === "postgresql",
          confirmMaintenanceWindow: true,
          confirmContainerName: plan.containerName,
        }),
      });
      await readSystemUpdateStream(
        response,
        (message) => setUpdateStatus((current) => ({ ...current, [plan.id]: message })),
        translateInterface("m2ca13025d60c"),
      );
      await loadSystemPlans();
    } catch (err) {
      setUpdateStatus((current) => ({
        ...current,
        [plan.id]: err instanceof Error ? err.message : translateInterface("me58282fd73fb"),
      }));
    }
  }

  function updateLabel(plan: SystemUpdatePlan) {
    if (!plan.exists) return t("images.missing");
    if (plan.trackingStatus !== "tracked") return t("images.adopt");
    return plan.updateAvailable ? translateInterface("mc1c1009d3f37") : translateInterface("m6cb9539bf90d");
  }

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (error) return <div className="rounded-lg border p-6 text-sm text-destructive">{error}</div>;
  if (!data) return null;


  const healthBySlug = Object.fromEntries(health.map((h) => [h.slug, h]));
  const componentById = Object.fromEntries(components.map((c) => [c.id, c]));
  const isAppliance = data.runtime.kind === "appliance-image";

  // One row per service: what the health monitor knows (state, usage, Restart) joined with the platform's
  // component list (version, the detail page). Components the list does not know by name still get a row.
  const serviceIds = [...SERVICE_ORDER, ...components.map((c) => c.id).filter((id) => !SERVICE_ORDER.includes(id))];
  const serviceRows = serviceIds.map((id) => {
    const live: ServiceHealth | undefined = healthBySlug[id];
    const component: PlatformComponent | undefined = componentById[id];
    const meta = SERVICE_META[id];
    const name = meta?.name ?? component?.displayName ?? id;
    let desc = meta?.desc ?? component?.description ?? "";
    let version = showVersion(live?.version) || showVersion(component?.version);
    let status = live?.status || component?.status || "";
    if (id === "host-system" && isAppliance) {
      desc = t("services.host.descImage");
      // The installed release; the image and Spine builds are never shown (General has the details line).
      version = release ?? version;
      status = data.runtime.repair_required ? "repair-required" : "image-managed";
    }
    if (id === "spine") version = release ?? version;
    if (id === "control-panel") {
      version = release ?? version;
      status = status || "running"; // this page is served by it
    }
    if (id === "incus") version = version || showVersion(data.incus?.version);
    const cpu = live && live.cpuPercent >= 0 ? Math.round(live.cpuPercent) : null;
    const memory = live && live.memory > 0 ? fmtMB(live.memory, locale) : "";
    const usage = memory && cpu !== null ? t("services.usage", { memory, cpu }) : memory || (cpu !== null ? t("services.cpuOnly", { cpu }) : "");
    return {
      id, icon: meta?.icon ?? Server, name, desc, version, status, usage,
      restartSlug: live?.restartable ? live.slug : null,
      href: component ? `/settings/apps/${encodeURIComponent(id)}?from=system` : null,
    };
  });

  const memUsed = data.memory?.used_mb ?? 0;
  const memTotal = data.memory?.total_mb ?? 0;
  const diskUsed = data.disk?.used_gb ?? 0;
  const diskTotal = data.disk?.total_gb ?? 0;
  const cpuUsage = data.cpu?.usage_percent ? Number.parseFloat(data.cpu.usage_percent) : 0;

  if (!services) {
    const pages = [
      {
        href: "/settings/system/health", icon: HeartPulse, title: translateInterface("mfd576da5aa1f"), hint: systemPages("health.hint"),
        value: openIssues === null ? "" : openIssues > 0 ? t("overview.openIssues", { count: openIssues }) : t("overview.noIssues"),
        attention: (openIssues ?? 0) > 0,
      },
      { href: "/settings/system/services", icon: Server, title: t("services.title"), hint: t("overview.servicesHint") },
      ...(isAppliance ? [{ href: "/settings/system/ssh", icon: KeyRound, title: t("ssh.title"), hint: systemPages("ssh.hint") }] : []),
      ...(isAppliance ? [{ href: "/settings/system/machine", icon: Monitor, title: systemPages("machine.title"), hint: systemPages("machine.hint") }] : []),
      { href: "/settings/system/ai", icon: Sparkles, title: translateInterface("mb535945fa809"), hint: systemPages("ai.hint") },
    ] as Array<{ href: string; icon: LucideIcon; title: string; hint: string; value?: string; attention?: boolean }>;
    return (
      <div className="space-y-6">
        <PageHeader title={translateInterface("m6725e7bbcd28")} description={translateInterface("m0621419ae136")} />

        {isAppliance && <ApplianceSystemUpdate />}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard icon={Cpu} label="CPU" value={`${Math.round(cpuUsage)}%`} meter={cpuUsage} sub={data.cpu?.cores ? t("overview.cores", { count: data.cpu.cores }) : undefined} />
          <StatCard icon={MemoryStick} label={translateInterface("mc3963aedaac6")} value={fmtMB(memUsed, locale)} meter={pct(memUsed, memTotal)} warn={pct(memUsed, memTotal) >= 85} sub={memTotal > 0 ? t("overview.ofTotal", { total: fmtMB(memTotal, locale) }) : undefined} />
          <StatCard icon={HardDrive} label={translateInterface("m340e0cf3bfa8")} value={`${diskUsed.toLocaleString(locale)} GB`} meter={pct(diskUsed, diskTotal)} warn={pct(diskUsed, diskTotal) >= 85} sub={diskTotal > 0 ? t("overview.ofTotal", { total: `${diskTotal.toLocaleString(locale)} GB` }) : undefined} />
          <StatCard icon={Clock} label={translateInterface("md63ab4711473")} value={data.uptime} sub={data.hostname} />
        </div>

        <ul className="settings-group">
          {pages.map((row) => (
            <li key={row.href}>
              <Link href={row.href} className="settings-row">
                <span className="settings-row-icon" aria-hidden="true"><row.icon className="size-[18px]" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-foreground">{row.title}</span>
                  <span className="block text-[13px] text-muted-foreground">{row.hint}</span>
                </span>
                {row.value && (
                  <span className="flex shrink-0 items-center gap-1.5 text-[13px] tabular-nums text-muted-foreground">
                    {row.attention && <span className="inline-block size-2 rounded-full bg-amber-500" aria-hidden="true" />}
                    {row.value}
                  </span>
                )}
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t("services.title")} description={t("services.description")} />

      <section className="space-y-2">
        {restartError && <p role="alert" className="rounded-lg border border-destructive/30 px-4 py-3 text-sm text-destructive">{restartError}</p>}
        <ul className="settings-group">
          {serviceRows.map((row) => {
            const Icon = row.icon;
            const label = (
              <>
                <span className="settings-row-icon" aria-hidden="true"><Icon className="size-[18px]" /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className="font-medium text-foreground">{row.name}</span>
                    {row.version && <span className="text-[12px] tabular-nums text-muted-foreground">{row.version}</span>}
                  </span>
                  {row.desc && <span className="block text-[13px] text-muted-foreground">{row.desc}</span>}
                </span>
              </>
            );
            return (
              <li key={row.id} className="flex flex-col gap-1.5 px-4 py-2.5 text-[15px] leading-[1.35] lg:min-h-[3.75rem] lg:flex-row lg:items-center lg:gap-4">
                {row.href ? (
                  <Link
                    href={row.href}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-3.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {label}
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground lg:hidden" aria-hidden="true" />
                  </Link>
                ) : (
                  <div className="flex min-h-11 min-w-0 flex-1 items-center gap-3.5">{label}</div>
                )}
                <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 pl-[2.875rem] lg:shrink-0 lg:flex-nowrap lg:pl-0">
                  {/* Fixed columns on wide screens so usage, state and Restart line up down the list. */}
                  <span className={`text-[13px] tabular-nums text-muted-foreground lg:w-40 lg:text-right ${row.usage ? "" : "hidden lg:block"}`}>{row.usage}</span>
                  <span className="lg:w-36">{row.status ? <ServiceState status={row.status} /> : null}</span>
                  <span className="ml-auto flex justify-end lg:ml-0 lg:w-28">
                    {row.restartSlug && (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t("services.restartNamed", { name: row.name })}
                        onClick={() => restartService(row.restartSlug!)}
                        disabled={restarting === row.restartSlug}
                      >
                        {restarting === row.restartSlug ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                        {translateInterface("m6b983a81e5e8")}
                      </Button>
                    )}
                  </span>
                  <span className="hidden w-4 lg:block">
                    {row.href && (
                      <Link href={row.href} tabIndex={-1} aria-hidden="true" className="block text-muted-foreground hover:text-foreground">
                        <ChevronRight className="size-4" />
                      </Link>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="px-1 text-[12.5px] text-muted-foreground">{t("services.refreshNote")}</p>
      </section>

      {/* Container images (admin): pinned by this release; a maintenance-window flow, so folded away. */}
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md text-[15px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
          {t("images.summary")}
        </summary>
        <div className="mt-2 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <p className="max-w-prose text-sm text-muted-foreground">{t("images.description")}</p>
            <Button variant="ghost" size="icon" className="shrink-0" onClick={loadSystemPlans} disabled={plansLoading} title={t("images.refresh")}>
              {plansLoading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              <span className="sr-only">{t("images.refresh")}</span>
            </Button>
          </div>
          {planError && <div role="alert" className="rounded-lg border p-4 text-sm text-destructive">{planError}</div>}
          {plansLoading && !systemPlans.length ? (
            <div className="flex justify-center rounded-lg border py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : (
            <div className="grid gap-3 xl:grid-cols-3">
              {systemPlans.map((plan) => {
                const needsAttention = plan.recreateRecommended || plan.updateAvailable || plan.trackingStatus === "missing";
                const canUpdate = plan.exists && (plan.updateAvailable || plan.trackingStatus !== "tracked");
                const updating = updateStatus[plan.id] === "Starting..." || updateStatus[plan.id]?.startsWith("Stopping") || updateStatus[plan.id]?.startsWith("Rebuilding") || updateStatus[plan.id]?.startsWith("Starting") || updateStatus[plan.id]?.startsWith("Verifying");
                return (
                  <div key={plan.id} className="min-w-0 space-y-3 rounded-xl border bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold">{SERVICE_META[IMAGE_SERVICE[plan.id]]?.name ?? plan.id}</h3>
                        <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{plan.containerName}</p>
                      </div>
                      <Badge variant={needsAttention ? "secondary" : "outline"} className="shrink-0">{t(`images.tracking.${plan.trackingStatus}`)}</Badge>
                    </div>
                    <dl className="space-y-2 text-xs">
                      <div>
                        <dt className="text-muted-foreground">{translateInterface("me0d1b68224bf")}</dt>
                        <dd className="break-all font-mono">{plan.currentVersion || plan.currentImage || translateInterface("mb23a6a8439c0")}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">{translateInterface("m978354db0c00")}</dt>
                        <dd className="break-all font-mono">{plan.desiredVersion} · {plan.desiredImage}</dd>
                      </div>
                    </dl>
                    <p className="flex items-start gap-2 text-xs text-muted-foreground">
                      {needsAttention ? <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                      <span className="min-w-0">{plan.reason}</span>
                    </p>
                    {plan.id === "postgresql" && (
                      <p className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0">{translateInterface("mce32ec9424c4")}</span>
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => dryRun(plan)}
                        disabled={!plan.exists || dryRunStatus[plan.id] === "Planning..."}
                      >
                        {dryRunStatus[plan.id] === "Planning..." ? <Loader2 className="h-4 w-4 animate-spin" /> : t("images.dryRun")}
                      </Button>
                      <Button
                        variant={canUpdate ? "destructive" : "outline"}
                        size="sm"
                        className="flex-1"
                        onClick={() => {
                          setConfirmPlan(plan);
                          setConfirmName("");
                          setMaintenanceConfirmed(false);
                        }}
                        disabled={!canUpdate || updating}
                      >
                        {updating ? <Loader2 className="h-4 w-4 animate-spin" /> : canUpdate ? `${updateLabel(plan)}…` : updateLabel(plan)}
                      </Button>
                    </div>
                    {dryRunStatus[plan.id] && dryRunStatus[plan.id] !== "Planning..." && (
                      <p className="break-words text-xs text-muted-foreground" role="status">{dryRunStatus[plan.id]}</p>
                    )}
                    {updateStatus[plan.id] && updateStatus[plan.id] !== "Starting..." && (
                      <p className="break-words text-xs text-muted-foreground" role="status">{updateStatus[plan.id]}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </details>

      {confirmPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="system-confirm-title">
          <div className="w-full max-w-md space-y-4 rounded-xl border bg-background p-5 shadow-lg">
            <div>
              <h3 id="system-confirm-title" className="text-base font-semibold">{updateLabel(confirmPlan)}: {SERVICE_META[IMAGE_SERVICE[confirmPlan.id]]?.name ?? confirmPlan.id}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {translateInterface("m85b09d810b47", {container: confirmPlan.containerName, image: confirmPlan.desiredImage})}
              </p>
            </div>
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
              {translateInterface("m75c8cf9bedc5")}</div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={maintenanceConfirmed} onChange={(event) => setMaintenanceConfirmed(event.target.checked)} />
              <span>{translateInterface("m66f00da6573e")}</span>
            </label>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="system-confirm-name">{translateInterface("m9f19f38a7e23", {container: confirmPlan.containerName})}</label>
              <Input id="system-confirm-name" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} placeholder={confirmPlan.containerName} autoComplete="off" spellCheck={false} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmPlan(null)}>{translateInterface("m19766ed6ccb2")}</Button>
              <Button variant="destructive" onClick={() => runConfirmedUpdate(confirmPlan)} disabled={!maintenanceConfirmed || confirmName !== confirmPlan.containerName}>
                {updateLabel(confirmPlan)}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
