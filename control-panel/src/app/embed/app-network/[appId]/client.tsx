"use client";

import { useEffect, useState } from "react";

interface Bridge {
  id: string;
  from: string;
  to: string;
  direction: "one-way" | "both-ways";
  approved: boolean;
  active: boolean;
  activatedAt?: string;
}

export function AppNetworkClient({ appId }: { appId: string }) {
  const [bridges, setBridges] = useState<Bridge[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTarget, setNewTarget] = useState("");

  useEffect(() => {
    fetchBridges();
  }, [appId]);

  async function fetchBridges() {
    try {
      const res = await fetch(`/api/bridges?appId=${appId}`);
      const data = await res.json();
      setBridges(data.bridges || []);
    } catch {
      // ignore
    }
    setLoading(false);
  }

  async function handleToggleDirection(bridgeId: string) {
    const bridge = bridges.find((b) => b.id === bridgeId);
    if (!bridge) return;
    const newDir = bridge.direction === "one-way" ? "both-ways" : "one-way";
    await fetch(`/api/bridges/${bridgeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: newDir }),
    });
    fetchBridges();
  }

  async function handleRemove(bridgeId: string) {
    await fetch(`/api/bridges/${bridgeId}`, { method: "DELETE" });
    fetchBridges();
  }

  async function handleAdd() {
    if (!newTarget.trim()) return;
    await fetch("/api/bridges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: appId,
        to: newTarget.trim(),
        direction: "one-way",
        activate: true,
        approvedBy: "admin",
      }),
    });
    setNewTarget("");
    fetchBridges();
  }

  if (loading) {
    return <div style={{ padding: 16 }} className="embed-muted">Loading...</div>;
  }

  const outgoing = bridges.filter((b) => b.from === appId);
  const incoming = bridges.filter((b) => b.to === appId && b.from !== appId);

  return (
    <div style={{ padding: 16 }}>
      <div className="embed-card-title">Direct App Access</div>

      {outgoing.length === 0 && incoming.length === 0 && (
        <div className="embed-muted" style={{ marginBottom: 12 }}>No bridges configured.</div>
      )}

      {outgoing.map((b) => (
        <div key={b.id} className="embed-row">
          <span style={{ flex: 1 }}>
            {b.to}
            <span className="embed-muted" style={{ marginLeft: 8 }}>
              {b.direction === "both-ways" ? "\u21c4" : "\u2192"} {b.direction}
            </span>
          </span>
          <span style={{ color: b.active ? "var(--embed-success)" : "var(--embed-warning)", fontSize: 12 }}>
            {b.active ? "active" : "pending"}
          </span>
          <button className="embed-btn" onClick={() => handleToggleDirection(b.id)}>
            {b.direction === "one-way" ? "Make both ways" : "Make one-way"}
          </button>
          <button className="embed-btn" style={{ color: "var(--embed-danger)" }} onClick={() => handleRemove(b.id)}>
            Remove
          </button>
        </div>
      ))}

      {incoming.map((b) => (
        <div key={b.id} className="embed-row embed-muted">
          <span style={{ flex: 1 }}>{"\u2190"} {b.from} can reach this app</span>
          <span style={{ color: b.active ? "var(--embed-success)" : "var(--embed-warning)", fontSize: 12 }}>
            {b.active ? "active" : "pending"}
          </span>
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          type="text"
          placeholder="App ID to bridge to..."
          value={newTarget}
          onChange={(e) => setNewTarget(e.target.value)}
          style={{
            flex: 1,
            background: "var(--embed-card-bg)",
            border: "1px solid var(--embed-border)",
            color: "var(--embed-text)",
            padding: "6px 10px",
            borderRadius: 4,
            fontSize: 13,
          }}
        />
        <button className="embed-btn" onClick={handleAdd}>+ Add</button>
      </div>
    </div>
  );
}
