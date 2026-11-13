"use client";

import { PageHeader } from "./page-header";

import { useLocale } from "next-intl";
import { useTranslations as useInterfaceTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  Database,
  HardDrive,
  KeyRound,
  Loader2,
  type LucideIcon,
  MemoryStick,
  Monitor,
  PackageCheck,
  RefreshCw,
  Route,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApplianceSystemUpdate } from "@/components/settings-shell/appliance-system-update";
import { DevelopmentAccessCard } from "@/components/settings-shell/development-access-card";
import { HostNetworkCard } from "@/components/settings-shell/host-network-card";
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
  sourceId?: string;
  manifestPath?: string;
  manifestDigest?: string;
  exists: boolean;
  running: boolean;
  trackingStatus: TrackingStatus;
  currentImage?: string;
  currentVersion?: string;
  updateAvailable: boolean;
  recreateRecommended: boolean;
  reason: string;
}

// Human service names (skill copy rule / D4 — never surface raw component names).

const PLATFORM_ORDER = ["spine", "__cp__", "postgres", "caddy", "pihole"];

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
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="mt-1 text-[22px] font-bold tracking-tight">{value}</div>
      {meter !== undefined ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className={`h-full rounded-full ${warn ? "bg-amber-500" : "bg-primary"}`} style={{ width: `${Math.min(Math.max(meter, 0), 100)}%` }} />
        </div>
      ) : sub ? (
        <div className="mt-1 text-[12px] text-muted-foreground">{sub}</div>
      ) : null}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const translateInterface = useInterfaceTranslations("interface");

  const ok = status === "running" || status === "ok" || status === "healthy" || status === "image-managed";
  const label = status === "image-managed" ? translateInterface("m60392a796c39") : ok ? translateInterface("mf4ccae29e1bb") : status;
  return (
    <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <span className={`inline-block size-2 rounded-full ${ok ? "bg-green-500" : "bg-amber-500"}`} />
      {label}
    </span>
  );
}

export function SystemClient({ cpVersion, spine }: { cpVersion?: string; spine?: { running: string; seed: string } }) {
  const locale = useLocale();
  const translateInterface = useInterfaceTranslations("interface");
const SERVICE_META: Record<string, { name: string; desc: string; icon: LucideIcon }> = {
  spine: { name: translateInterface("m6a81c94a4745"), desc: translateInterface("m0fc6d6605ce1"), icon: Server },
  postgres: { name: translateInterface("mfa7fe67124e9"), desc: translateInterface("me73f7545c5d6"), icon: Database },
  caddy: { name: translateInterface("m0ffcd855ea52"), desc: translateInterface("mcf227fcff97c"), icon: Route },
  pihole: { name: translateInterface("m434eceb156ee"), desc: translateInterface("m5694cd21cd72"), icon: ShieldCheck },
};


  const [data, setData] = useState<SystemInfo | null>(null);
  const [health, setHealth] = useState<ServiceHealth[]>([]);
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

  useEffect(() => {
    load();
    loadSystemPlans();
  }, [load, loadSystemPlans]);

  // Refresh the main cards as well as the service rows. Schedule after each
  // response so slow requests cannot overlap or flash the full-page loader.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      await load(true);
      if (!stopped) timer = setTimeout(refresh, 15_000);
    };
    timer = setTimeout(refresh, 15_000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [load]);

  // Live usage refreshes every 5s.
  useEffect(() => {
    loadHealth();
    const id = setInterval(loadHealth, 5000);
    return () => clearInterval(id);
  }, [loadHealth]);

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
        headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json" },
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
    if (!plan.exists) return "Missing";
    if (plan.trackingStatus !== "tracked") return "Adopt/Recreate";
    return plan.updateAvailable ? "Update" : translateInterface("m6cb9539bf90d");
  }

  const refreshAll = useCallback(() => {
    load();
    loadHealth();
    loadSystemPlans();
  }, [load, loadHealth, loadSystemPlans]);

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (error) return <div className="rounded-lg border p-6 text-sm text-destructive">{error}</div>;
  if (!data) return null;

  const healthBySlug = Object.fromEntries(health.map((h) => [h.slug, h]));
  const isAppliance = data.runtime.kind === "appliance-image";
  const platformRows = PLATFORM_ORDER.map((slug) => {
    if (slug === "__cp__") {
      return { key: "__cp__", icon: Monitor, name: translateInterface("m0d6a16e62a51"), desc: translateInterface("m52858a1e8a21"), version: cpVersion ? `v${cpVersion}` : "", status: "running" };
    }
    if (slug === "spine" && isAppliance) {
      return {
        key: "spine",
        icon: PackageCheck,
        name: translateInterface("m996eea0a4157"),
        desc: translateInterface("mc474624e6d25"),
        // Image version, then the Spine the slot runs (it updates without a new image).
        version: showVersion(data.runtime.image_version) + (spine ? ` · Spine ${showVersion(spine.running)}${spine.running !== spine.seed ? ` (seed ${showVersion(spine.seed)})` : ""}` : ""),
        status: data.runtime.repair_required ? "repair-required" : "image-managed",
      };
    }
    const h = healthBySlug[slug];
    const meta = SERVICE_META[slug];
    if (!meta) return null;
    return {
      key: slug,
      icon: meta.icon,
      name: meta.name,
      desc: meta.desc,
      version: showVersion(h?.version),
      status: h?.status || "running",
    };
  }).filter((row): row is NonNullable<typeof row> => row !== null);

  const usageRows = health
    .filter((h) => h.restartable && (h.memory > 0 || h.cpuPercent >= 0))
    .sort((a, b) => b.memory - a.memory);

  const memUsed = data.memory?.used_mb ?? 0;
  const memTotal = data.memory?.total_mb ?? 0;
  const diskUsed = data.disk?.used_gb ?? 0;
  const diskTotal = data.disk?.total_gb ?? 0;
  const cpuUsage = data.cpu?.usage_percent ? Number.parseFloat(data.cpu.usage_percent) : 0;

  return (
    <div className="space-y-6">
      <PageHeader title={translateInterface("m6725e7bbcd28")} description={translateInterface("m0621419ae136")} />

      <Card className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-[15px] font-semibold">{translateInterface("mfd576da5aa1f")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {translateInterface("mf18eb29c95c2")}</p>
        </div>
        <Button asChild>
          <Link href="/settings/system/health">{translateInterface("m8b2ca2cc5e13")}</Link>
        </Button>
      </Card>

      {isAppliance && (
        <Card className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-3">
            <KeyRound className="mt-0.5 size-5 text-primary" />
            <div>
              <h2 className="text-[15px] font-semibold">{translateInterface("me774fce31fac")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{translateInterface("m8ddb2bf3361e")}</p>
            </div>
          </div>
          <Button asChild><Link href="/settings/system/ssh">SSH</Link></Button>
        </Card>
      )}
      <Card className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3">
          <Sparkles className="mt-0.5 size-5 text-primary" />
          <div>
            <h2 className="text-[15px] font-semibold">{translateInterface("mb535945fa809")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{translateInterface("m4a911e38f8a3")}</p>
          </div>
        </div>
        <Button variant="outline" asChild><Link href="/settings/system/ai">{translateInterface("mb92e45055098")}</Link></Button>
      </Card>

      {/* Stat row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Cpu} label="CPU" value={`${Math.round(cpuUsage)}%`} meter={cpuUsage} />
        <StatCard icon={MemoryStick} label={translateInterface("mc3963aedaac6")} value={fmtMB(memUsed, locale)} meter={pct(memUsed, memTotal)} warn={pct(memUsed, memTotal) >= 85} />
        <StatCard icon={HardDrive} label={translateInterface("m340e0cf3bfa8")} value={`${diskUsed} GB`} meter={pct(diskUsed, diskTotal)} warn={pct(diskUsed, diskTotal) >= 85} />
        <StatCard icon={Clock} label={translateInterface("md63ab4711473")} value={data.uptime} sub={data.hostname} />
      </div>

      {isAppliance && <HostNetworkCard />}
      {isAppliance && <ApplianceSystemUpdate />}
      {isAppliance && <DevelopmentAccessCard />}

      {/* Platform services */}
      <Card className="gap-0 py-0">
        <div className="flex items-center justify-between gap-4 border-b p-4">
          <h2 className="text-[15px] font-semibold">{translateInterface("mc78ffe195710")}</h2>
          <Button variant="ghost" size="sm" onClick={refreshAll} disabled={plansLoading}>
            <RefreshCw className="size-4" /> {" "}{translateInterface("mf26f3275e735")}</Button>
        </div>
        <div className="divide-y">
          {platformRows.map((row) => {
            const Icon = row.icon;
            return (
              <div key={row.key} className="flex items-center gap-3 p-4">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
                  <Icon className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{row.name}</p>
                  <p className="truncate text-[13px] text-muted-foreground">{row.desc}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {row.version && <span className="text-[12px] tabular-nums text-muted-foreground">{row.version}</span>}
                  <StatusDot status={row.status} />
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Live usage (core services with real, already-sampled usage) */}
      <Card className="gap-0 py-0">
        <div className="flex items-center justify-between gap-4 border-b p-4">
          <h2 className="text-[15px] font-semibold">{translateInterface("m5ff9aa406f8b")}</h2>
          <span className="text-[12.5px] text-muted-foreground">{translateInterface("m58643433f1e4")}</span>
        </div>
        {restartError && <p role="alert" className="border-b p-4 text-sm text-destructive">{restartError}</p>}
        {usageRows.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">{translateInterface("m7bbe5547614d")}</div>
        ) : (
          <div className="divide-y">
            {usageRows.map((h) => {
              const meta = SERVICE_META[h.slug];
              const Icon = meta?.icon ?? Server;
              const cpu = h.cpuPercent >= 0 ? Math.round(h.cpuPercent) : null;
              return (
                <div key={h.slug} className="flex items-center gap-3 p-4">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
                    <Icon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{meta?.name ?? h.name}</p>
                    <p className="text-[13px] text-muted-foreground">{fmtMB(h.memory, locale)} {translateInterface("mc064fbca9d9d")}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(Math.max(cpu ?? 0, 0), 100)}%` }} />
                    </div>
                    <span className="w-9 text-right text-[12px] tabular-nums text-muted-foreground">{cpu === null ? "—" : `${cpu}%`}</span>
                    <Button variant="ghost" size="sm" onClick={() => restartService(h.slug)} disabled={restarting === h.slug}>
                      {restarting === h.slug ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                      {translateInterface("m6b983a81e5e8")}</Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Market System Manifests (admin) — image tracking + maintenance-window update flow (unchanged). */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="flex items-center gap-2 text-[15px] font-semibold"><Database className="h-4 w-4" />{translateInterface("m44f668d33a33")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{translateInterface("mc5d2e899b371")}</p>
          </div>
          <Button variant="outline" size="sm" onClick={loadSystemPlans} disabled={plansLoading}>
            {plansLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
        {planError && <div className="rounded-lg border p-4 text-sm text-destructive">{planError}</div>}
        {plansLoading && !systemPlans.length ? (
          <div className="flex justify-center rounded-lg border py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-3">
            {systemPlans.map((plan) => {
              const isTracked = plan.trackingStatus === "tracked";
              const needsAttention = plan.recreateRecommended || plan.updateAvailable || plan.trackingStatus === "missing";
              const canUpdate = plan.exists && (plan.updateAvailable || plan.trackingStatus !== "tracked");
              const updating = updateStatus[plan.id] === "Starting..." || updateStatus[plan.id]?.startsWith("Stopping") || updateStatus[plan.id]?.startsWith("Rebuilding") || updateStatus[plan.id]?.startsWith("Starting") || updateStatus[plan.id]?.startsWith("Verifying");
              return (
                <div key={plan.id} className="space-y-3 rounded-xl border p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-semibold">{plan.id}</h4>
                      <p className="mt-0.5 text-xs text-muted-foreground">{plan.containerName}</p>
                    </div>
                    <Badge variant={needsAttention ? "secondary" : "outline"}>{plan.trackingStatus}</Badge>
                  </div>
                  <div className="space-y-2 text-xs">
                    <div>
                      <span className="text-muted-foreground">{translateInterface("me0d1b68224bf")}</span>
                      <p className="break-words font-mono">{plan.currentVersion || plan.currentImage || translateInterface("mb23a6a8439c0")}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{translateInterface("m5238d9bd03d5")}</span>
                      <p className="break-words font-mono">{plan.desiredVersion} · {plan.desiredImage}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                    {needsAttention ? <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                    <span>{plan.reason}</span>
                  </div>
                  {plan.id === "postgresql" && (
                    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{translateInterface("mce32ec9424c4")}</span>
                    </div>
                  )}
                  <Button
                    variant={isTracked && plan.updateAvailable ? "default" : "outline"}
                    size="sm"
                    className="w-full"
                    onClick={() => dryRun(plan)}
                    disabled={!plan.exists || dryRunStatus[plan.id] === "Planning..."}
                  >
                    {dryRunStatus[plan.id] === "Planning..." ? <Loader2 className="h-4 w-4 animate-spin" /> : translateInterface("m765351d892b4")}
                  </Button>
                  {dryRunStatus[plan.id] && dryRunStatus[plan.id] !== "Planning..." && (
                    <p className="text-xs text-muted-foreground">{dryRunStatus[plan.id]}</p>
                  )}
                  <Button
                    variant={canUpdate ? "destructive" : "outline"}
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      setConfirmPlan(plan);
                      setConfirmName("");
                      setMaintenanceConfirmed(false);
                    }}
                    disabled={!canUpdate || updating}
                  >
                    {updating ? <Loader2 className="h-4 w-4 animate-spin" /> : updateLabel(plan)}
                  </Button>
                  {updateStatus[plan.id] && updateStatus[plan.id] !== "Starting..." && (
                    <p className="text-xs text-muted-foreground">{updateStatus[plan.id]}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {confirmPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md space-y-4 rounded-xl border bg-background p-5 shadow-lg">
            <div>
              <h3 className="text-base font-semibold">{updateLabel(confirmPlan)} {confirmPlan.id}</h3>
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
              <Input id="system-confirm-name" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} placeholder={confirmPlan.containerName} />
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
