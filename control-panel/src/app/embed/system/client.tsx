"use client";

import { useEffect, useState } from "react";

interface SystemInfo {
  hostname: string;
  os: string;
  kernel: string;
  uptime: string;
  load_average?: string;
  cpu: { cores: number; model: string; usage_percent?: string };
  memory: { total_mb: number; used_mb: number; free_mb: number };
  disk: { total_gb: number; used_gb: number; free_gb: number };
  incus: { version: string; storage_pool: string };
  containers: { total: number; running: number; stopped: number };
}

function ProgressBar({ used, total, unit }: { used: number; total: number; unit: string }) {
  const percent = total > 0 ? Math.round((used / total) * 100) : 0;
  const color = percent > 90 ? "var(--embed-danger)" : percent > 70 ? "var(--embed-warning)" : "var(--embed-primary)";

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 13 }}>
        <span className="embed-muted">{unit}</span>
        <span className="embed-value">{used.toLocaleString()} / {total.toLocaleString()} {unit} ({percent}%)</span>
      </div>
      <div className="embed-progress-track">
        <div className="embed-progress-bar" style={{ width: `${Math.min(percent, 100)}%`, background: color }} />
      </div>
    </div>
  );
}

export function SystemEmbedClient() {
  const [data, setData] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function fetchData() {
    try {
      setError(null);
      const res = await fetch("/api/ui-bridge/system");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    fetchData();
  }, []);

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <div className="embed-skeleton" style={{ height: 20, width: 200, marginBottom: 16 }} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="embed-card">
              <div className="embed-skeleton" style={{ height: 16, width: 80, marginBottom: 12 }} />
              <div className="embed-skeleton" style={{ height: 12, width: "100%", marginBottom: 8 }} />
              <div className="embed-skeleton" style={{ height: 12, width: "70%" }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) return <div className="embed-error">{error}</div>;
  if (!data) return null;

  return (
    <div style={{ padding: 16 }}>
      <div className="embed-header">
        <div>
          <div className="embed-title">System</div>
          <div className="embed-subtitle">Host information and resource usage</div>
        </div>
        <button className="embed-btn" onClick={() => { setRefreshing(true); fetchData(); }} disabled={refreshing}>
          {refreshing ? "..." : "Refresh"}
        </button>
      </div>

      <div className="embed-card">
        <div className="embed-card-title">Host</div>
        <div className="embed-grid">
          <div><div className="embed-label">Hostname</div><div className="embed-value">{data.hostname}</div></div>
          <div><div className="embed-label">Operating System</div><div className="embed-value">{data.os}</div></div>
          <div><div className="embed-label">Kernel</div><div className="embed-value">{data.kernel}</div></div>
          <div><div className="embed-label">Uptime</div><div className="embed-value">{data.uptime}</div></div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
        <div className="embed-card">
          <div className="embed-card-title">CPU</div>
          <div><div className="embed-label">Model</div><div className="embed-value">{data.cpu.model}</div></div>
          <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
            <div><div className="embed-label">Cores</div><div className="embed-value">{data.cpu.cores}</div></div>
            {data.cpu.usage_percent && (
              <div><div className="embed-label">Usage</div><div className="embed-value">{data.cpu.usage_percent}%</div></div>
            )}
          </div>
          {data.load_average && (
            <div style={{ marginTop: 8 }}><div className="embed-label">Load Average</div><div className="embed-value">{data.load_average}</div></div>
          )}
        </div>

        <div className="embed-card">
          <div className="embed-card-title">Memory</div>
          <ProgressBar used={data.memory.used_mb} total={data.memory.total_mb} unit="MB" />
        </div>

        <div className="embed-card">
          <div className="embed-card-title">Disk</div>
          <ProgressBar used={data.disk.used_gb} total={data.disk.total_gb} unit="GB" />
        </div>

        <div className="embed-card">
          <div className="embed-card-title">Containers</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 8 }}>
            <span className="embed-muted">Incus</span>
            <span className="embed-badge">{data.incus.version}</span>
            <span className="embed-muted">Pool: {data.incus.storage_pool}</span>
          </div>
          <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
            <span><span className="embed-dot" style={{ background: "var(--embed-primary)", marginRight: 6 }} />{data.containers.total} Total</span>
            <span><span className="embed-dot" style={{ background: "var(--embed-success)", marginRight: 6 }} />{data.containers.running} Running</span>
            <span><span className="embed-dot" style={{ background: "var(--embed-text-muted)", marginRight: 6 }} />{data.containers.stopped} Stopped</span>
          </div>
        </div>
      </div>
    </div>
  );
}
