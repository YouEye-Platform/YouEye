"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
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

type TrackingStatus = "tracked" | "legacy-compatible" | "legacy-untracked" | "missing";

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
const SERVICE_META: Record<string, { name: string; desc: string; icon: LucideIcon }> = {
  spine: { name: "System core", desc: "Keeps the platform healthy and updated", icon: Server },
  postgres: { name: "Database", desc: "Stores app data on this server", icon: Database },
  caddy: { name: "Web gateway", desc: "Routes your addresses with automatic HTTPS", icon: Route },
  pihole: { name: "Network shield", desc: "Ad-blocking DNS for your whole network", icon: ShieldCheck },
};
const PLATFORM_ORDER = ["spine", "__cp__", "postgres", "caddy", "pihole"];

function fmtMB(mb: number) {
  if (!mb || mb <= 0) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
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
  const ok = status === "running" || status === "ok" || status === "healthy" || status === "image-managed";
  const label = status === "image-managed" ? "Image-managed" : ok ? "Running" : status;
  return (
    <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <span className={`inline-block size-2 rounded-full ${ok ? "bg-green-500" : "bg-amber-500"}`} />
      {label}
    </span>
  );
}

export function SystemClient({ cpVersion }: { cpVersion?: string }) {
  const [data, setData] = useState<SystemInfo | null>(null);
  const [health, setHealth] = useState<ServiceHealth[]>([]);
  const [restarting, setRestarting] = useState<string | null>(null);
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

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await fetch("/settings/api/settings/system");
    if (res.ok) setData(await res.json());
    else setError((await res.json().catch(() => ({}))).error || "Failed to load system information");
    setLoading(false);
  }, []);

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
      setPlanError((await res.json().catch(() => ({}))).error || "Failed to load Market system plans");
    }
    setPlansLoading(false);
  }, []);

  useEffect(() => {
    load();
    loadSystemPlans();
  }, [load, loadSystemPlans]);

  // Live usage refreshes every 5s.
  useEffect(() => {
    loadHealth();
    const id = setInterval(loadHealth, 5000);
    return () => clearInterval(id);
  }, [loadHealth]);

  async function restartService(slug: string) {
    setRestarting(slug);
    try {
      const res = await fetch(`/api/health/services/${slug}/restart`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Restart failed");
      await loadHealth();
    } catch {
      // surfaced via the next health poll; keep the button responsive.
    } finally {
      setRestarting(null);
    }
  }

  async function readSystemUpdateStream(response: Response, onMessage: (message: string) => void, fallback: string) {
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || "System update request failed");
    }
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let latest = "";
    if (!reader) throw new Error("No update stream returned");
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
          forceLegacy: plan.trackingStatus !== "tracked",
          allowDatabaseUpdate: plan.id === "postgresql",
        }),
      });
      await readSystemUpdateStream(
        response,
        (message) => setDryRunStatus((current) => ({ ...current, [plan.id]: message })),
        "Dry run complete",
      );
    } catch (err) {
      setDryRunStatus((current) => ({
        ...current,
        [plan.id]: err instanceof Error ? err.message : "Dry run failed",
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
          forceLegacy: plan.trackingStatus !== "tracked",
          allowDatabaseUpdate: plan.id === "postgresql",
          confirmMaintenanceWindow: true,
          confirmContainerName: plan.containerName,
        }),
      });
      await readSystemUpdateStream(
        response,
        (message) => setUpdateStatus((current) => ({ ...current, [plan.id]: message })),
        "Update complete",
      );
      await loadSystemPlans();
    } catch (err) {
      setUpdateStatus((current) => ({
        ...current,
        [plan.id]: err instanceof Error ? err.message : "Update failed",
      }));
    }
  }

  function updateLabel(plan: SystemUpdatePlan) {
    if (!plan.exists) return "Missing";
    if (plan.trackingStatus !== "tracked") return "Adopt/Recreate";
    return plan.updateAvailable ? "Update" : "No Update";
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
      return { key: "__cp__", icon: Monitor, name: "Server interface", desc: "This dashboard and settings", version: cpVersion ? `v${cpVersion}` : "", status: "running" };
    }
    if (slug === "spine" && isAppliance) {
      return {
        key: "spine",
        icon: PackageCheck,
        name: "System image",
        desc: "Operating system, System core, and container engine",
        version: showVersion(data.runtime.image_version),
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
      <div>
        <h1 className="text-2xl font-bold tracking-tight">System</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your server at a glance — live usage, services, and updates</p>
      </div>

      <Card className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-[15px] font-semibold">Health and repairs</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Durable issue registry, self-heal timeline, and one-click repair actions.
          </p>
        </div>
        <Button asChild>
          <Link href="/settings/system/health">Open Health</Link>
        </Button>
      </Card>

      {isAppliance && (
        <Card className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-3">
            <KeyRound className="mt-0.5 size-5 text-primary" />
            <div>
              <h2 className="text-[15px] font-semibold">Secure shell access</h2>
              <p className="mt-1 text-sm text-muted-foreground">Manage authorised keys for appliance administration.</p>
            </div>
          </div>
          <Button asChild><Link href="/settings/system/ssh">SSH</Link></Button>
        </Card>
      )}
      <Card className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3">
          <Sparkles className="mt-0.5 size-5 text-primary" />
          <div>
            <h2 className="text-[15px] font-semibold">AI service</h2>
            <p className="mt-1 text-sm text-muted-foreground">Version, readiness, database migration, and backup health.</p>
          </div>
        </div>
        <Button variant="outline" asChild><Link href="/settings/system/ai">Open AI health</Link></Button>
      </Card>

      {/* Stat row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Cpu} label="CPU" value={`${Math.round(cpuUsage)}%`} meter={cpuUsage} />
        <StatCard icon={MemoryStick} label="Memory" value={fmtMB(memUsed)} meter={pct(memUsed, memTotal)} warn={pct(memUsed, memTotal) >= 85} />
        <StatCard icon={HardDrive} label="Disk" value={`${diskUsed} GB`} meter={pct(diskUsed, diskTotal)} warn={pct(diskUsed, diskTotal) >= 85} />
        <StatCard icon={Clock} label="Uptime" value={data.uptime} sub={data.hostname} />
      </div>

      {isAppliance && <HostNetworkCard />}
      {isAppliance && <ApplianceSystemUpdate />}
      {isAppliance && <DevelopmentAccessCard />}

      {/* Platform services */}
      <Card className="gap-0 py-0">
        <div className="flex items-center justify-between gap-4 border-b p-4">
          <h2 className="text-[15px] font-semibold">Platform</h2>
          <Button variant="ghost" size="sm" onClick={refreshAll} disabled={plansLoading}>
            <RefreshCw className="size-4" /> Check for updates
          </Button>
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
          <h2 className="text-[15px] font-semibold">Live usage</h2>
          <span className="text-[12.5px] text-muted-foreground">refreshes every 5s</span>
        </div>
        {usageRows.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Collecting usage…</div>
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
                    <p className="text-[13px] text-muted-foreground">{fmtMB(h.memory)} memory</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(Math.max(cpu ?? 0, 0), 100)}%` }} />
                    </div>
                    <span className="w-9 text-right text-[12px] tabular-nums text-muted-foreground">{cpu === null ? "—" : `${cpu}%`}</span>
                    <Button variant="ghost" size="sm" onClick={() => restartService(h.slug)} disabled={restarting === h.slug}>
                      {restarting === h.slug ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                      Restart
                    </Button>
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
            <h3 className="flex items-center gap-2 text-[15px] font-semibold"><Database className="h-4 w-4" />System images</h3>
            <p className="mt-1 text-sm text-muted-foreground">Database, Web gateway, and Network shield image tracking from Market.</p>
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
                      <span className="text-muted-foreground">Current</span>
                      <p className="break-words font-mono">{plan.currentVersion || plan.currentImage || "unknown"}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Market</span>
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
                      <span>Database image changes require an explicit maintenance window.</span>
                    </div>
                  )}
                  <Button
                    variant={isTracked && plan.updateAvailable ? "default" : "outline"}
                    size="sm"
                    className="w-full"
                    onClick={() => dryRun(plan)}
                    disabled={!plan.exists || dryRunStatus[plan.id] === "Planning..."}
                  >
                    {dryRunStatus[plan.id] === "Planning..." ? <Loader2 className="h-4 w-4 animate-spin" /> : "Dry Run"}
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
                This will stop and rebuild {confirmPlan.containerName} from the Market image {confirmPlan.desiredImage}.
              </p>
            </div>
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
              System services affect sign-in, routing, DNS, and app data. Run this only during a maintenance window after a successful dry-run.
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={maintenanceConfirmed} onChange={(event) => setMaintenanceConfirmed(event.target.checked)} />
              <span>I have a maintenance window and understand this rebuild can temporarily interrupt YouEye.</span>
            </label>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="system-confirm-name">Type {confirmPlan.containerName} to continue</label>
              <Input id="system-confirm-name" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} placeholder={confirmPlan.containerName} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmPlan(null)}>Cancel</Button>
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
