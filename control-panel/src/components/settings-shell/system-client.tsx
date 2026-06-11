"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Cpu, Database, GitBranch, HardDrive, Loader2, MemoryStick, RefreshCw, Save, Server, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

interface ReleaseSource {
  repo_url?: string;
  provider?: string;
  base_url?: string;
  organization?: string;
  repository?: string;
}

interface PlatformSettings {
  releaseBranch?: string;
  releaseSource?: ReleaseSource;
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
  const [updateStatus, setUpdateStatus] = useState<Record<string, string>>({});
  const [confirmPlan, setConfirmPlan] = useState<SystemUpdatePlan | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [maintenanceConfirmed, setMaintenanceConfirmed] = useState(false);
  const [releaseBranch, setReleaseBranch] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [sourceLoading, setSourceLoading] = useState(true);
  const [sourceSaving, setSourceSaving] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [sourceMessage, setSourceMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await fetch("/settings/api/settings/system");
    if (res.ok) setData(await res.json());
    else setError((await res.json().catch(() => ({}))).error || "Failed to load system information");
    setLoading(false);
  }, []);

  const loadUpdateSource = useCallback(async () => {
    setSourceLoading(true);
    setSourceError("");
    setSourceMessage("");
    const res = await fetch("/api/settings");
    if (res.ok) {
      const settings = await res.json() as PlatformSettings;
      setReleaseBranch(settings.releaseBranch || "main");
      setRepoUrl(settings.releaseSource?.repo_url || "");
    } else {
      setSourceError((await res.json().catch(() => ({}))).error || "Failed to load update source");
    }
    setSourceLoading(false);
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

  useEffect(() => { load(); loadSystemPlans(); loadUpdateSource(); }, [load, loadSystemPlans, loadUpdateSource]);

  async function saveUpdateSource() {
    const branch = releaseBranch.trim();
    const normalizedRepoUrl = repoUrl.trim().replace(/\/$/, "").replace(/\.git$/, "");
    setSourceError("");
    setSourceMessage("");

    if (!branch) {
      setSourceError("Release branch is required");
      return;
    }
    if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..")) {
      setSourceError("Release branch contains unsupported characters");
      return;
    }
    try {
      const parsed = new URL(normalizedRepoUrl);
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (!["http:", "https:"].includes(parsed.protocol) || parts.length < 2) {
        throw new Error("Repo URL must include an owner and repository");
      }
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : "Repo URL is invalid");
      return;
    }

    setSourceSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          releaseBranch: branch,
          releaseSource: { repo_url: normalizedRepoUrl },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Failed to save update source");
      const updated = body as PlatformSettings;
      setReleaseBranch(updated.releaseBranch || branch);
      setRepoUrl(updated.releaseSource?.repo_url || normalizedRepoUrl);
      setSourceMessage("Update source saved");
      await loadSystemPlans();
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : "Failed to save update source");
    } finally {
      setSourceSaving(false);
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
    loadSystemPlans();
    loadUpdateSource();
  }, [load, loadSystemPlans, loadUpdateSource]);

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (error) return <div className="rounded-lg border p-6 text-sm text-destructive">{error}</div>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
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

      <div className="space-y-4 rounded-lg border p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="flex items-center gap-2 text-base font-semibold"><GitBranch className="h-4 w-4" />Core Update Source</h3>
            <p className="mt-1 text-sm text-muted-foreground">Release source for Spine, Control Panel, and YouEye UI.</p>
          </div>
          <Button size="sm" onClick={saveUpdateSource} disabled={sourceLoading || sourceSaving}>
            {sourceSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save
          </Button>
        </div>
        <div className="grid gap-4 md:grid-cols-[minmax(180px,240px)_1fr]">
          <div className="space-y-2">
            <Label htmlFor="release-branch">Release Branch</Label>
            <Input
              id="release-branch"
              value={releaseBranch}
              onChange={(event) => setReleaseBranch(event.target.value)}
              disabled={sourceLoading || sourceSaving}
              placeholder="main"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="release-repo-url">Repo URL</Label>
            <Input
              id="release-repo-url"
              value={repoUrl}
              onChange={(event) => setRepoUrl(event.target.value)}
              disabled={sourceLoading || sourceSaving}
              placeholder="https://git.potemk.in/potemsla/YouEye"
            />
          </div>
        </div>
        {sourceError && <p className="text-sm text-destructive">{sourceError}</p>}
        {sourceMessage && <p className="text-sm text-muted-foreground">{sourceMessage}</p>}
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
              const canUpdate = plan.exists && (plan.updateAvailable || plan.trackingStatus !== "tracked");
              const updating = updateStatus[plan.id] === "Starting..." || updateStatus[plan.id]?.startsWith("Stopping") || updateStatus[plan.id]?.startsWith("Rebuilding") || updateStatus[plan.id]?.startsWith("Starting") || updateStatus[plan.id]?.startsWith("Verifying");
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
          <div className="w-full max-w-md space-y-4 rounded-lg border bg-background p-5 shadow-lg">
            <div>
              <h3 className="text-base font-semibold">{updateLabel(confirmPlan)} {confirmPlan.id}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                This will stop and rebuild {confirmPlan.containerName} from the Market image {confirmPlan.desiredImage}.
              </p>
            </div>
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              System services affect sign-in, routing, DNS, and app data. Run this only during a maintenance window after a successful dry-run.
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={maintenanceConfirmed}
                onChange={(event) => setMaintenanceConfirmed(event.target.checked)}
              />
              <span>I have a maintenance window and understand this rebuild can temporarily interrupt YouEye.</span>
            </label>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="system-confirm-name">Type {confirmPlan.containerName} to continue</label>
              <Input
                id="system-confirm-name"
                value={confirmName}
                onChange={(event) => setConfirmName(event.target.value)}
                placeholder={confirmPlan.containerName}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmPlan(null)}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={() => runConfirmedUpdate(confirmPlan)}
                disabled={!maintenanceConfirmed || confirmName !== confirmPlan.containerName}
              >
                {updateLabel(confirmPlan)}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
