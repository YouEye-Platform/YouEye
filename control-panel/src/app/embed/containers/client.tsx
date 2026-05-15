"use client";

import { useEffect, useState, useCallback, useRef } from "react";

interface ContainerInfo {
  name: string;
  status: string;
  type: string;
  ipv4: string | null;
  created_at: string;
  profiles: string[];
}

const REFRESH_INTERVAL = 30_000;

export function ContainersEmbedClient() {
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ name: string; action: string } | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchContainers = useCallback(async (silent = false) => {
    try {
      if (!silent) setError(null);
      const res = await fetch("/api/ui-bridge/containers");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setContainers(json.containers ?? []);
      setError(null);
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchContainers();
    intervalRef.current = setInterval(() => fetchContainers(true), REFRESH_INTERVAL);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchContainers]);

  const handleAction = async (name: string, action: string) => {
    setConfirm(null);
    setActionLoading(`${name}-${action}`);
    try {
      const res = await fetch(`/api/ui-bridge/containers/${name}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error(`Container ${action} failed:`, body.error);
      }
      await fetchContainers();
    } catch {
      // action failed — next refresh will show current state
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <div className="embed-skeleton" style={{ height: 20, width: 200, marginBottom: 16 }} />
        <div className="embed-card">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} style={{ padding: "10px 12px", borderBottom: "1px solid var(--embed-border)" }}>
              <div className="embed-skeleton" style={{ height: 14, width: "100%" }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) return <div className="embed-error">{error}</div>;

  const statusColor = (s: string) => {
    switch (s.toLowerCase()) {
      case "running": return "var(--embed-success)";
      case "stopped": return "var(--embed-text-muted)";
      case "error": return "var(--embed-danger)";
      default: return "var(--embed-warning)";
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <div className="embed-header">
        <div>
          <div className="embed-title">Containers</div>
          <div className="embed-subtitle">Manage Incus containers. Auto-refreshes every 30s.</div>
        </div>
        <button
          className="embed-btn"
          onClick={() => { setRefreshing(true); fetchContainers(); }}
          disabled={refreshing}
        >
          {refreshing ? "..." : "Refresh"}
        </button>
      </div>

      {containers.length === 0 ? (
        <div className="embed-card" style={{ textAlign: "center", padding: 32 }}>
          <div className="embed-muted">No containers found.</div>
        </div>
      ) : (
        <div className="embed-card" style={{ padding: 0 }}>
          <table className="embed-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>IPv4</th>
                <th>Type</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {containers.map((c) => {
                const isRunning = c.status.toLowerCase() === "running";
                const isStopped = c.status.toLowerCase() === "stopped";

                return (
                  <tr key={c.name}>
                    <td style={{ fontWeight: 500 }}>{c.name}</td>
                    <td>
                      <span
                        className="embed-badge"
                        style={{ color: statusColor(c.status), borderColor: `color-mix(in srgb, ${statusColor(c.status)} 30%, transparent)` }}
                      >
                        <span className="embed-dot" style={{ background: statusColor(c.status), marginRight: 6, width: 6, height: 6 }} />
                        {c.status.charAt(0).toUpperCase() + c.status.slice(1)}
                      </span>
                    </td>
                    <td className="embed-muted">{c.ipv4 ?? "\u2014"}</td>
                    <td className="embed-muted">{c.type}</td>
                    <td style={{ textAlign: "right" }}>
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: 4 }}>
                        {isStopped && (
                          <ActionBtn
                            label="Start"
                            loading={actionLoading === `${c.name}-start`}
                            onClick={() => setConfirm({ name: c.name, action: "start" })}
                          />
                        )}
                        {isRunning && (
                          <>
                            <ActionBtn
                              label="Stop"
                              danger
                              loading={actionLoading === `${c.name}-stop`}
                              onClick={() => setConfirm({ name: c.name, action: "stop" })}
                            />
                            <ActionBtn
                              label="Restart"
                              loading={actionLoading === `${c.name}-restart`}
                              onClick={() => setConfirm({ name: c.name, action: "restart" })}
                            />
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

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
                  : { borderColor: "var(--embed-primary)", color: "var(--embed-primary)" }
                }
                onClick={() => handleAction(confirm.name, confirm.action)}
              >
                {confirm.action.charAt(0).toUpperCase() + confirm.action.slice(1)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ActionBtn({ label, danger, loading, onClick }: {
  label: string; danger?: boolean; loading: boolean; onClick: () => void;
}) {
  return (
    <button
      className="embed-btn"
      style={{
        padding: "3px 8px", fontSize: 12,
        ...(danger ? { borderColor: "var(--embed-danger)", color: "var(--embed-danger)" } : {}),
      }}
      onClick={onClick}
      disabled={loading}
    >
      {loading ? "..." : label}
    </button>
  );
}
