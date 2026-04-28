"use client";

import { useEffect, useState, useCallback, useRef } from "react";

/* ── Types ── */

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
  container_details?: ContainerDetail[];
}

interface ContainerDetail {
  name: string;
  status: string;
  type: string;
  ipv4: string | null;
  memory_usage_mb: number;
  memory_limit_mb: number;
  cpu_usage_ns: number;
  disk_usage_mb: number;
}

interface HistoryPoint {
  cpu: number;
  mem: number;
  disk: number;
  ts: number;
}

const POLL_INTERVAL = 5_000;
const MAX_HISTORY = 60; // 5 min at 5s intervals

/* ── Mini Area Chart (pure SVG) ── */

function AreaChart({
  data,
  max,
  color,
  height = 48,
  width = "100%",
}: {
  data: number[];
  max: number;
  color: string;
  height?: number;
  width?: string | number;
}) {
  if (data.length < 2) return null;
  const w = 200;
  const h = height;
  const step = w / (MAX_HISTORY - 1);
  const effectiveMax = max > 0 ? max : 1;

  const points = data.map((v, i) => {
    const x = (data.length - 1 - i) * step;
    const y = h - (v / effectiveMax) * h;
    return `${w - x},${y}`;
  });

  const linePath = `M${points.join(" L")}`;
  const areaPath = `${linePath} L${w},${h} L${w - (data.length - 1) * step},${h} Z`;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ width, height, display: "block" }}
    >
      <defs>
        <linearGradient id={`grad-${color.replace(/[^a-z0-9]/gi, "")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#grad-${color.replace(/[^a-z0-9]/gi, "")})`} />
      <path d={linePath} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ── Progress Bar ── */

function ProgressBar({ used, total, unit, color }: { used: number; total: number; unit: string; color?: string }) {
  const percent = total > 0 ? Math.round((used / total) * 100) : 0;
  const barColor = color ?? (percent > 90 ? "var(--embed-danger)" : percent > 70 ? "var(--embed-warning)" : "var(--embed-primary)");

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 13 }}>
        <span className="embed-muted">{unit}</span>
        <span className="embed-value">
          {used.toLocaleString()} / {total.toLocaleString()} {unit} ({percent}%)
        </span>
      </div>
      <div className="embed-progress-track">
        <div className="embed-progress-bar" style={{ width: `${Math.min(percent, 100)}%`, background: barColor }} />
      </div>
    </div>
  );
}

/* ── Container Row ── */

function ContainerRow({
  c,
  onAction,
  actionLoading,
}: {
  c: ContainerDetail;
  onAction: (name: string, action: string) => void;
  actionLoading: string | null;
}) {
  const isRunning = c.status === "running";
  const isStopped = c.status === "stopped";
  const memPercent = c.memory_limit_mb > 0 ? Math.round((c.memory_usage_mb / c.memory_limit_mb) * 100) : 0;
  const memColor = memPercent > 90 ? "var(--embed-danger)" : memPercent > 70 ? "var(--embed-warning)" : "var(--embed-primary)";

  const statusColor = isRunning
    ? "var(--embed-success)"
    : isStopped
      ? "var(--embed-text-muted)"
      : "var(--embed-warning)";

  return (
    <tr>
      <td style={{ fontWeight: 500, whiteSpace: "nowrap" }}>{c.name}</td>
      <td>
        <span
          className="embed-badge"
          style={{ color: statusColor, borderColor: `color-mix(in srgb, ${statusColor} 30%, transparent)` }}
        >
          <span className="embed-dot" style={{ background: statusColor, marginRight: 4, width: 6, height: 6 }} />
          {c.status.charAt(0).toUpperCase() + c.status.slice(1)}
        </span>
      </td>
      <td className="embed-muted" style={{ fontVariantNumeric: "tabular-nums" }}>{c.ipv4 ?? "\u2014"}</td>
      <td>
        {isRunning ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 120 }}>
            <div className="embed-progress-track" style={{ flex: 1, height: 6 }}>
              <div className="embed-progress-bar" style={{ width: `${memPercent}%`, background: memColor, height: 6 }} />
            </div>
            <span style={{ fontSize: 11, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }} className="embed-muted">
              {c.memory_usage_mb} MB
            </span>
          </div>
        ) : (
          <span className="embed-muted">\u2014</span>
        )}
      </td>
      <td style={{ fontVariantNumeric: "tabular-nums" }} className="embed-muted">
        {isRunning ? `${c.disk_usage_mb} MB` : "\u2014"}
      </td>
      <td style={{ textAlign: "right" }}>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 4 }}>
          {isStopped && (
            <button
              className="embed-btn"
              style={{ padding: "2px 8px", fontSize: 11 }}
              disabled={actionLoading === `${c.name}-start`}
              onClick={() => onAction(c.name, "start")}
            >
              {actionLoading === `${c.name}-start` ? "..." : "Start"}
            </button>
          )}
          {isRunning && (
            <>
              <button
                className="embed-btn"
                style={{ padding: "2px 8px", fontSize: 11, borderColor: "var(--embed-danger)", color: "var(--embed-danger)" }}
                disabled={actionLoading === `${c.name}-stop`}
                onClick={() => onAction(c.name, "stop")}
              >
                {actionLoading === `${c.name}-stop` ? "..." : "Stop"}
              </button>
              <button
                className="embed-btn"
                style={{ padding: "2px 8px", fontSize: 11 }}
                disabled={actionLoading === `${c.name}-restart`}
                onClick={() => onAction(c.name, "restart")}
              >
                {actionLoading === `${c.name}-restart` ? "..." : "Restart"}
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

/* ── Main Component ── */

export function SystemEmbedClient() {
  const [data, setData] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ name: string; action: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async (silent = false) => {
    try {
      if (!silent) setError(null);
      const res = await fetch("/api/ui-bridge/system");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const info: SystemInfo = await res.json();
      setData(info);
      setError(null);

      // Append to history
      const cpuVal = parseFloat(info.cpu.usage_percent ?? "0");
      const memPct = info.memory.total_mb > 0 ? (info.memory.used_mb / info.memory.total_mb) * 100 : 0;
      const diskPct = info.disk.total_gb > 0 ? (info.disk.used_gb / info.disk.total_gb) * 100 : 0;
      setHistory((prev) => {
        const next = [...prev, { cpu: cpuVal, mem: memPct, disk: diskPct, ts: Date.now() }];
        return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
      });
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    pollRef.current = setInterval(() => fetchData(true), POLL_INTERVAL);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchData]);

  const handleAction = async (name: string, action: string) => {
    setConfirm(null);
    setActionLoading(`${name}-${action}`);
    try {
      await fetch(`/api/ui-bridge/containers/${name}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      // Refresh data after action
      await fetchData(true);
    } catch { /* next poll will pick up state */ }
    finally { setActionLoading(null); }
  };

  // Notify parent iframe of size changes
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      window.parent?.postMessage(
        { type: "youeye-embed-resize", height: document.body.scrollHeight },
        "*"
      );
    });
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <div className="embed-skeleton" style={{ height: 20, width: 200, marginBottom: 16 }} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="embed-card">
              <div className="embed-skeleton" style={{ height: 16, width: 80, marginBottom: 12 }} />
              <div className="embed-skeleton" style={{ height: 48, width: "100%" }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) return <div className="embed-error">{error}</div>;
  if (!data) return null;

  const cpuPercent = parseFloat(data.cpu.usage_percent ?? "0");
  const memPercent = data.memory.total_mb > 0 ? Math.round((data.memory.used_mb / data.memory.total_mb) * 100) : 0;
  const diskPercent = data.disk.total_gb > 0 ? Math.round((data.disk.used_gb / data.disk.total_gb) * 100) : 0;

  const containers = data.container_details ?? [];
  const sorted = [...containers].sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (a.status !== "running" && b.status === "running") return 1;
    return b.memory_usage_mb - a.memory_usage_mb;
  });

  return (
    <div style={{ padding: 16 }}>
      {/* Header */}
      <div className="embed-header">
        <div>
          <div className="embed-title">System</div>
          <div className="embed-subtitle">
            {data.hostname} &mdash; {data.os} &mdash; up {data.uptime}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }} className="embed-muted">
          <span>Auto-refresh 5s</span>
          <span className="embed-dot" style={{ background: "var(--embed-success)", width: 6, height: 6, animation: "pulse 2s infinite" }} />
        </div>
      </div>

      {/* Resource Cards with Graphs */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
        {/* CPU */}
        <div className="embed-card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
            <div className="embed-card-title" style={{ margin: 0 }}>CPU</div>
            <span style={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
              {cpuPercent.toFixed(1)}%
            </span>
          </div>
          <div style={{ fontSize: 11, marginBottom: 6 }} className="embed-muted">
            {data.cpu.model} &middot; {data.cpu.cores} cores
            {data.load_average && <> &middot; load {data.load_average}</>}
          </div>
          <div style={{ borderRadius: 6, overflow: "hidden", background: "var(--embed-bg)" }}>
            <AreaChart data={history.map((h) => h.cpu)} max={100} color="#3b82f6" />
          </div>
        </div>

        {/* Memory */}
        <div className="embed-card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
            <div className="embed-card-title" style={{ margin: 0 }}>Memory</div>
            <span style={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
              {memPercent}%
            </span>
          </div>
          <div style={{ fontSize: 11, marginBottom: 6 }} className="embed-muted">
            {data.memory.used_mb.toLocaleString()} / {data.memory.total_mb.toLocaleString()} MB
          </div>
          <div style={{ borderRadius: 6, overflow: "hidden", background: "var(--embed-bg)" }}>
            <AreaChart data={history.map((h) => h.mem)} max={100} color="#8b5cf6" />
          </div>
        </div>

        {/* Disk */}
        <div className="embed-card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
            <div className="embed-card-title" style={{ margin: 0 }}>Disk</div>
            <span style={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
              {diskPercent}%
            </span>
          </div>
          <div style={{ fontSize: 11, marginBottom: 6 }} className="embed-muted">
            {data.disk.used_gb.toFixed(1)} / {data.disk.total_gb.toFixed(1)} GB
          </div>
          <div style={{ borderRadius: 6, overflow: "hidden", background: "var(--embed-bg)" }}>
            <AreaChart data={history.map((h) => h.disk)} max={100} color="#10b981" />
          </div>
        </div>
      </div>

      {/* System Info Row */}
      <div className="embed-card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 24, fontSize: 12, flexWrap: "wrap" }}>
          <div><span className="embed-muted">Kernel</span> <span className="embed-value">{data.kernel}</span></div>
          <div><span className="embed-muted">Incus</span> <span className="embed-badge">{data.incus.version}</span></div>
          <div><span className="embed-muted">Storage</span> <span className="embed-value">{data.incus.storage_pool}</span></div>
          <div>
            <span className="embed-dot" style={{ background: "var(--embed-success)", marginRight: 4 }} />
            <span className="embed-value">{data.containers.running} running</span>
            {data.containers.stopped > 0 && (
              <span className="embed-muted" style={{ marginLeft: 8 }}>{data.containers.stopped} stopped</span>
            )}
          </div>
        </div>
      </div>

      {/* Container Task Manager */}
      <div className="embed-card" style={{ padding: 0 }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--embed-border)" }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Containers</div>
          <div className="embed-muted" style={{ fontSize: 11 }}>Resource usage per container</div>
        </div>
        {sorted.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center" }} className="embed-muted">No containers found.</div>
        ) : (
          <table className="embed-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>IP</th>
                <th>Memory</th>
                <th>Disk</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => (
                <ContainerRow
                  key={c.name}
                  c={c}
                  onAction={(name, action) => setConfirm({ name, action })}
                  actionLoading={actionLoading}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Confirmation Dialog */}
      {confirm && (
        <div
          style={{
            position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.5)", zIndex: 100,
          }}
          onClick={() => setConfirm(null)}
        >
          <div
            className="embed-card"
            style={{ maxWidth: 400, width: "90%" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>
              {confirm.action.charAt(0).toUpperCase() + confirm.action.slice(1)} &ldquo;{confirm.name}&rdquo;?
            </div>
            <div className="embed-muted" style={{ fontSize: 13, marginBottom: 16 }}>
              {confirm.action === "stop"
                ? `This will stop the "${confirm.name}" container. Services inside will become unavailable.`
                : confirm.action === "restart"
                  ? `This will restart the "${confirm.name}" container. Services will be briefly unavailable.`
                  : `This will start the "${confirm.name}" container.`}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="embed-btn" onClick={() => setConfirm(null)}>Cancel</button>
              <button
                className="embed-btn"
                style={confirm.action === "stop"
                  ? { borderColor: "var(--embed-danger)", color: "var(--embed-danger)" }
                  : { borderColor: "var(--embed-primary)", color: "var(--embed-primary)" }}
                onClick={() => handleAction(confirm.name, confirm.action)}
              >
                {confirm.action.charAt(0).toUpperCase() + confirm.action.slice(1)}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
