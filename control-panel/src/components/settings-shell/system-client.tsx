"use client";

import { useCallback, useEffect, useState } from "react";
import { Cpu, HardDrive, Loader2, MemoryStick, RefreshCw, Server } from "lucide-react";
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await fetch("/settings/api/settings/system");
    if (res.ok) setData(await res.json());
    else setError((await res.json().catch(() => ({}))).error || "Failed to load system information");
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

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
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-4 w-4" />Refresh</Button>
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
    </div>
  );
}
