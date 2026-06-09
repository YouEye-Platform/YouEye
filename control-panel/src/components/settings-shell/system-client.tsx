"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Cpu, Database, HardDrive, Loader2, MemoryStick, RefreshCw, Server, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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

function Usage({ label, used, total, unit }: { label: string; used: number; total: number; unit: string }) {
  const percent = total > 0 ? Math.round((used / total) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-sm"><span className="text-muted-foreground">{label}</span><span className="font-medium">{used} / {total} {unit} ({percent}%)</span></div>
      <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(percent, 100)}%` }} /></div>
    </div>
  );
}

export function SystemClient() {
  const [data, setData] = useState<SystemInfo | null>(null);
  const [systemPlans, setSystemPlans] = useState<SystemUpdatePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [plansLoading, setPlansLoading] = useState(true);
  const [error, setError] = useState("");
  const [planError, setPlanError] = useState("");
  const [dryRunStatus, setDryRunStatus] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await fetch("/settings/api/settings/system");
    if (res.ok) setData(await res.json());
    else setError((await res.json().catch(() => ({}))).error || "Failed to load system information");
    setLoading(false);
  }, []);

  const loadSystemPlans = useCallback(async () => {
    setPlansLoading(true);
    setPlanError("");
    const res = await fetch("/api/deploy/infrastructure/system-updates");
    if (res.ok) {
      const body = await res.json();
      setSystemPlans(body.systems ?? []);
    } else {
      setPlanError((await res.json().catch(() => ({}))).error || "Failed to load Market system plans");
    }
    setPlansLoading(false);
  }, []);

  useEffect(() => { load(); loadSystemPlans(); }, [load, loadSystemPlans]);

  async function dryRun(plan: SystemUpdatePlan) {
    setDryRunStatus((current) => ({ ...current, [plan.id]: "Planning..." }));
    try {
      const response = await fetch("/api/deploy/infrastructure/system-updates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemId: plan.id,
          dryRun: true,
          forceLegacy: plan.trackingStatus !== "tracked",
          allowDatabaseUpdate: plan.id === "postgresql",
        }),
      });
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
          setDryRunStatus((current) => ({ ...current, [plan.id]: event.message }));
        }
      }
      if (!latest) setDryRunStatus((current) => ({ ...current, [plan.id]: "Dry run complete" }));
    } catch (err) {
      setDryRunStatus((current) => ({
        ...current,
        [plan.id]: err instanceof Error ? err.message : "Dry run failed",
      }));
    }
  }

  const refreshAll = useCallback(() => {
    load();
    loadSystemPlans();
  }, [load, loadSystemPlans]);

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (error) return <div className="rounded-lg border p-6 text-sm text-destructive">{error}</div>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold"><Server className="h-5 w-5" />System</h2>
          <p className="mt-1 text-sm text-muted-foreground">Host info, resource usage, and container summary.</p>
        </div>
        <Button variant="outline" size="sm" onClick={refreshAll}><RefreshCw className="h-4 w-4" />Refresh</Button>
      </div>

      <div className="rounded-lg border p-4">
        <div className="grid gap-4 text-sm sm:grid-cols-2">
          <div><span className="text-muted-foreground">Hostname</span><p className="font-medium">{data.hostname}</p></div>
          <div><span className="text-muted-foreground">Operating System</span><p className="font-medium">{data.os}</p></div>
          <div><span className="text-muted-foreground">Kernel</span><p className="font-medium">{data.kernel}</p></div>
          <div><span className="text-muted-foreground">Uptime</span><p className="font-medium">{data.uptime}</p></div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3 rounded-lg border p-4">
          <h3 className="flex items-center gap-2 text-base font-semibold"><Cpu className="h-4 w-4" />CPU</h3>
          <p className="text-sm text-muted-foreground">{data.cpu?.model || "unknown"}</p>
          <p className="text-sm">{data.cpu?.cores || 0} cores{data.cpu?.usage_percent ? ` · ${data.cpu.usage_percent}% usage` : ""}</p>
        </div>
        <div className="space-y-3 rounded-lg border p-4">
          <h3 className="flex items-center gap-2 text-base font-semibold"><MemoryStick className="h-4 w-4" />Memory</h3>
          {data.memory && <Usage label="Memory" used={data.memory.used_mb} total={data.memory.total_mb} unit="MB" />}
        </div>
        <div className="space-y-3 rounded-lg border p-4">
          <h3 className="flex items-center gap-2 text-base font-semibold"><HardDrive className="h-4 w-4" />Disk</h3>
          {data.disk && <Usage label="Disk" used={data.disk.used_gb} total={data.disk.total_gb} unit="GB" />}
        </div>
        <div className="space-y-3 rounded-lg border p-4">
          <h3 className="text-base font-semibold">Containers</h3>
          <p className="text-sm text-muted-foreground">{data.containers.running} running / {data.containers.total} total</p>
          <div className="flex flex-wrap gap-2">
            {data.containers.items.slice(0, 8).map((container) => <Badge key={container.name} variant="outline">{container.name}: {container.status}</Badge>)}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="flex items-center gap-2 text-base font-semibold"><Database className="h-4 w-4" />Market System Manifests</h3>
            <p className="mt-1 text-sm text-muted-foreground">Postgres, Caddy, and Pi-hole image tracking from Market.</p>
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
              return (
                <div key={plan.id} className="space-y-3 rounded-lg border p-4">
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
                    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
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
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
