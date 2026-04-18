"use client";

import { useEffect, useState } from "react";

interface BackupEntry {
  timestamp: string;
  archive_path: string;
  archive_size: number;
  version: string;
}

interface BackupData {
  config: {
    enabled: boolean;
    target_path: string;
    schedule: {
      core: { frequency: string; retention: number; time: string; last_run?: string };
      default_app: { frequency: string; retention: number };
      overrides: Record<string, { frequency: string; retention: number }>;
    };
  };
  index: {
    last_updated: string;
    core: BackupEntry[];
    apps: Record<string, BackupEntry[]>;
  } | null;
  apps: Array<{ appId: string; type: string }>;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function timeAgo(ts: string): string {
  try {
    const diffMs = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  } catch {
    return "";
  }
}

export function BackupEmbedClient() {
  const [data, setData] = useState<BackupData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function fetchData() {
    try {
      setError(null);
      const res = await fetch("/api/ui-bridge/backup");
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

  useEffect(() => {
    if (!data) return;
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [data]);

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <div className="embed-skeleton" style={{ height: 20, width: 200, marginBottom: 16 }} />
        <div className="embed-skeleton" style={{ height: 100, width: "100%", marginBottom: 12 }} />
        <div className="embed-skeleton" style={{ height: 150, width: "100%" }} />
      </div>
    );
  }

  if (error) return <div className="embed-error">{error}</div>;
  if (!data) return null;

  const { config: rawConfig, index, apps } = data;
  const config = {
    ...rawConfig,
    schedule: rawConfig.schedule ?? {
      core: { frequency: "daily", retention: 7, time: "03:00" },
      default_app: { frequency: "daily", retention: 7 },
      overrides: {},
    },
  };

  const totalBackups =
    (index?.core?.length ?? 0) +
    Object.values(index?.apps ?? {}).reduce((sum, arr) => sum + arr.length, 0);

  return (
    <div style={{ padding: 16 }}>
      <div className="embed-header">
        <div>
          <div className="embed-title">Backup & Restore</div>
          <div className="embed-subtitle">Automated backups and restore history</div>
        </div>
        <button className="embed-btn" onClick={() => { setRefreshing(true); fetchData(); }} disabled={refreshing}>
          {refreshing ? "..." : "Refresh"}
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <div className="embed-card">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="embed-dot" style={{ background: config.enabled ? "var(--embed-success)" : "var(--embed-warning)" }} />
            <div>
              <div className="embed-value" style={{ fontSize: 13 }}>{config.enabled ? "Backups Active" : "Not Configured"}</div>
              <div className="embed-label">{config.target_path}</div>
            </div>
          </div>
        </div>
        <div className="embed-card">
          <div className="embed-value" style={{ fontSize: 13 }}>{totalBackups} Backup{totalBackups !== 1 ? "s" : ""}</div>
          <div className="embed-label">{index?.last_updated ? `Last: ${timeAgo(index.last_updated)}` : "No backups yet"}</div>
        </div>
        <div className="embed-card">
          <div className="embed-value" style={{ fontSize: 13 }}>Core: {config.schedule.core.frequency}</div>
          <div className="embed-label">at {config.schedule.core.time}, keep {config.schedule.core.retention}</div>
        </div>
      </div>

      <div className="embed-card" style={{ marginTop: 12 }}>
        <div className="embed-card-title">Backup Schedule</div>
        <div className="embed-row" style={{ background: "color-mix(in srgb, var(--embed-primary) 5%, transparent)" }}>
          <span className="embed-dot" style={{ background: "var(--embed-primary)" }} />
          <span className="embed-value" style={{ width: 120 }}>Core Platform</span>
          <span className="embed-badge">{config.schedule.core.frequency}</span>
          <span className="embed-muted" style={{ fontSize: 12 }}>at {config.schedule.core.time}, keep {config.schedule.core.retention}</span>
        </div>
        {apps.map((app) => {
          const override = config.schedule.overrides[app.appId];
          const freq = override?.frequency || config.schedule.default_app.frequency;
          const ret = override?.retention || config.schedule.default_app.retention;
          return (
            <div key={app.appId} className="embed-row">
              <span className="embed-dot" style={{ background: "var(--embed-text-muted)" }} />
              <span className="embed-value" style={{ width: 120 }}>{app.appId}</span>
              <span className="embed-badge">{freq}</span>
              {freq !== "never" && <span className="embed-muted" style={{ fontSize: 12 }}>keep {ret}</span>}
            </div>
          );
        })}
      </div>

      {index && (index.core?.length ?? 0) > 0 && (
        <div className="embed-card" style={{ marginTop: 12 }}>
          <div className="embed-card-title">Core Backups</div>
          {index.core.map((entry, i) => (
            <div key={i} className="embed-row">
              <span className="embed-muted" style={{ flex: 1, fontSize: 13 }}>{new Date(entry.timestamp).toLocaleString()}</span>
              <span className="embed-badge">{formatBytes(entry.archive_size)}</span>
              {entry.version && <span className="embed-badge">v{entry.version}</span>}
            </div>
          ))}
        </div>
      )}

      {index && Object.entries(index.apps || {}).map(([appId, entries]) =>
        entries.length > 0 ? (
          <div key={appId} className="embed-card" style={{ marginTop: 12 }}>
            <div className="embed-card-title">{appId}</div>
            {entries.map((entry, i) => (
              <div key={i} className="embed-row">
                <span className="embed-muted" style={{ flex: 1, fontSize: 13 }}>{new Date(entry.timestamp).toLocaleString()}</span>
                <span className="embed-badge">{formatBytes(entry.archive_size)}</span>
                {entry.version && <span className="embed-badge">v{entry.version}</span>}
              </div>
            ))}
          </div>
        ) : null
      )}
    </div>
  );
}
