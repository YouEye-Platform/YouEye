"use client";

import { useEffect, useState, useCallback } from "react";

interface DnsStats {
  status: "enabled" | "disabled";
  queries_today: number;
  blocked_today: number;
  percent_blocked: number;
  top_queries: Array<{ domain: string; count: number }>;
  top_blocked: Array<{ domain: string; count: number }>;
  gravity_size: number;
}

export function DnsEmbedClient() {
  const [data, setData] = useState<DnsStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [upstreams, setUpstreams] = useState<string[]>([]);
  const [upstreamDraft, setUpstreamDraft] = useState<string[]>([]);
  const [upstreamSaving, setUpstreamSaving] = useState(false);
  const [upstreamError, setUpstreamError] = useState<string | null>(null);
  const [upstreamEditing, setUpstreamEditing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/ui-bridge/dns/stats");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    fetch("/api/ui-bridge/dns/upstream")
      .then((r) => r.json())
      .then((d) => { setUpstreams(d.upstreams || []); setUpstreamDraft(d.upstreams || []); })
      .catch(() => {});
  }, [fetchData]);

  const handleUpstreamSave = async () => {
    const filtered = upstreamDraft.map((s) => s.trim()).filter(Boolean);
    if (filtered.length === 0) { setUpstreamError("At least one upstream server required"); return; }
    setUpstreamSaving(true);
    setUpstreamError(null);
    try {
      const res = await fetch("/api/ui-bridge/dns/upstream", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upstreams: filtered }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Failed");
      setUpstreams(result.upstreams || filtered);
      setUpstreamDraft(result.upstreams || filtered);
      setUpstreamEditing(false);
    } catch (err) {
      setUpstreamError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setUpstreamSaving(false);
    }
  };

  const handleToggle = async () => {
    if (!data) return;
    setToggling(true);
    const action = data.status === "enabled" ? "disable" : "enable";
    try {
      const res = await fetch("/api/ui-bridge/dns/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        const result = await res.json();
        setData((prev) => (prev ? { ...prev, status: result.status } : prev));
      }
    } catch {
      // toggle failed silently — user can retry
    } finally {
      setToggling(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <div className="embed-skeleton" style={{ height: 20, width: 200, marginBottom: 16 }} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="embed-card">
              <div className="embed-skeleton" style={{ height: 12, width: 80, marginBottom: 12 }} />
              <div className="embed-skeleton" style={{ height: 24, width: 60 }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) return <div className="embed-error">{error}</div>;
  if (!data) return null;

  const isEnabled = data.status === "enabled";

  return (
    <div style={{ padding: 16 }}>
      <div className="embed-header">
        <div>
          <div className="embed-title">DNS</div>
          <div className="embed-subtitle">Pi-Hole DNS filtering statistics</div>
        </div>
        <button
          className="embed-btn"
          onClick={() => { setRefreshing(true); fetchData(); }}
          disabled={refreshing}
        >
          {refreshing ? "..." : "Refresh"}
        </button>
      </div>

      {/* Status + Toggle */}
      <div className="embed-card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            className="embed-dot"
            style={{ background: isEnabled ? "var(--embed-success)" : "var(--embed-danger)", width: 10, height: 10 }}
          />
          <span style={{ fontWeight: 500 }}>
            Pi-Hole is{" "}
            <span
              className="embed-badge"
              style={isEnabled
                ? { color: "var(--embed-success)", borderColor: "color-mix(in srgb, var(--embed-success) 30%, transparent)" }
                : { color: "var(--embed-danger)", borderColor: "color-mix(in srgb, var(--embed-danger) 30%, transparent)" }
              }
            >
              {isEnabled ? "Enabled" : "Disabled"}
            </span>
          </span>
        </div>
        <button
          className="embed-btn"
          style={isEnabled
            ? { borderColor: "var(--embed-danger)", color: "var(--embed-danger)" }
            : { borderColor: "var(--embed-success)", color: "var(--embed-success)" }
          }
          onClick={handleToggle}
          disabled={toggling}
        >
          {toggling ? "..." : isEnabled ? "Disable" : "Enable"}
        </button>
      </div>

      {/* Upstream DNS */}
      <div className="embed-card" style={{ marginTop: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div className="embed-card-title" style={{ margin: 0 }}>Upstream DNS Servers</div>
          {!upstreamEditing ? (
            <button className="embed-btn" onClick={() => { setUpstreamEditing(true); setUpstreamDraft([...upstreams]); }}>
              Edit
            </button>
          ) : (
            <div style={{ display: "flex", gap: 6 }}>
              <button className="embed-btn" onClick={() => { setUpstreamEditing(false); setUpstreamError(null); }}>
                Cancel
              </button>
              <button
                className="embed-btn"
                style={{ borderColor: "var(--embed-success)", color: "var(--embed-success)" }}
                onClick={handleUpstreamSave}
                disabled={upstreamSaving}
              >
                {upstreamSaving ? "..." : "Save"}
              </button>
            </div>
          )}
        </div>
        {upstreamError && <div style={{ color: "var(--embed-danger)", fontSize: 12, marginBottom: 8 }}>{upstreamError}</div>}
        {upstreamEditing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {upstreamDraft.map((s, i) => (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  className="embed-input"
                  value={s}
                  onChange={(e) => { const d = [...upstreamDraft]; d[i] = e.target.value; setUpstreamDraft(d); }}
                  placeholder="e.g. 8.8.8.8 or 1.1.1.1#53"
                  style={{ flex: 1, padding: "4px 8px", fontSize: 13, border: "1px solid var(--embed-border)", borderRadius: 4, background: "transparent", color: "inherit" }}
                />
                {upstreamDraft.length > 1 && (
                  <button className="embed-btn" style={{ padding: "2px 8px", color: "var(--embed-danger)", borderColor: "var(--embed-danger)" }}
                    onClick={() => setUpstreamDraft(upstreamDraft.filter((_, j) => j !== i))}>✕</button>
                )}
              </div>
            ))}
            <button className="embed-btn" style={{ alignSelf: "flex-start", fontSize: 12 }}
              onClick={() => setUpstreamDraft([...upstreamDraft, ""])}>+ Add server</button>
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {upstreams.length > 0 ? upstreams.map((s) => (
              <span key={s} className="embed-badge embed-mono" style={{ fontSize: 12 }}>{s}</span>
            )) : (
              <span className="embed-muted" style={{ fontSize: 13 }}>No upstream servers configured</span>
            )}
          </div>
        )}
      </div>

      {/* Stats Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginTop: 12 }}>
        <StatCard label="Total Queries" value={data.queries_today.toLocaleString()} />
        <StatCard label="Blocked Today" value={data.blocked_today.toLocaleString()} />
        <StatCard label="Block Percentage" value={`${data.percent_blocked.toFixed(1)}%`} />
        <StatCard label="Gravity Size" value={data.gravity_size.toLocaleString()} />
      </div>

      {/* Top Queries & Top Blocked */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
        <DomainTable title="Top Queries" entries={data.top_queries} />
        <DomainTable title="Top Blocked" entries={data.top_blocked} />
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="embed-card">
      <div className="embed-label" style={{ marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function DomainTable({ title, entries }: { title: string; entries: Array<{ domain: string; count: number }> }) {
  return (
    <div className="embed-card">
      <div className="embed-card-title">{title}</div>
      {entries.length === 0 ? (
        <div className="embed-muted" style={{ fontSize: 13 }}>No data</div>
      ) : (
        <table className="embed-table">
          <thead>
            <tr>
              <th>Domain</th>
              <th style={{ textAlign: "right" }}>Count</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.domain}>
                <td className="embed-mono">{e.domain}</td>
                <td style={{ textAlign: "right" }}>{e.count.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
