"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

interface Bridge {
  id: string;
  from: string;
  to: string;
  direction: "one-way" | "both-ways";
  approved: boolean;
  active: boolean;
  activatedAt?: string;
}

export default function AppNetworkEmbed() {
  const { appId } = useParams<{ appId: string }>();
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
    return (
      <div style={{ padding: 16, fontFamily: "system-ui", color: "#999" }}>
        Loading...
      </div>
    );
  }

  const outgoing = bridges.filter((b) => b.from === appId);
  const incoming = bridges.filter((b) => b.to === appId && b.from !== appId);

  return (
    <div
      style={{
        padding: 16,
        fontFamily: "system-ui",
        fontSize: 14,
        color: "#e0e0e0",
        background: "transparent",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 12 }}>
        Direct App Access
      </div>

      {outgoing.length === 0 && incoming.length === 0 && (
        <div style={{ color: "#888", marginBottom: 12 }}>
          No bridges configured.
        </div>
      )}

      {outgoing.map((b) => (
        <div
          key={b.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 0",
            borderBottom: "1px solid #333",
          }}
        >
          <span style={{ flex: 1 }}>
            {b.to}
            <span style={{ color: "#888", marginLeft: 8 }}>
              {b.direction === "both-ways" ? "\u21c4" : "\u2192"}{" "}
              {b.direction}
            </span>
          </span>
          <span
            style={{
              color: b.active ? "#4ade80" : "#fbbf24",
              fontSize: 12,
            }}
          >
            {b.active ? "active" : "pending"}
          </span>
          <button
            onClick={() => handleToggleDirection(b.id)}
            style={{
              background: "#333",
              border: "1px solid #555",
              color: "#e0e0e0",
              padding: "4px 8px",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {b.direction === "one-way" ? "Make both ways" : "Make one-way"}
          </button>
          <button
            onClick={() => handleRemove(b.id)}
            style={{
              background: "#333",
              border: "1px solid #555",
              color: "#f87171",
              padding: "4px 8px",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Remove
          </button>
        </div>
      ))}

      {incoming.map((b) => (
        <div
          key={b.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 0",
            borderBottom: "1px solid #333",
            color: "#888",
          }}
        >
          <span style={{ flex: 1 }}>
            \u2190 {b.from} can reach this app
          </span>
          <span style={{ color: b.active ? "#4ade80" : "#fbbf24", fontSize: 12 }}>
            {b.active ? "active" : "pending"}
          </span>
        </div>
      ))}

      <div
        style={{
          display: "flex",
          gap: 8,
          marginTop: 12,
          alignItems: "center",
        }}
      >
        <input
          type="text"
          placeholder="App ID to bridge to..."
          value={newTarget}
          onChange={(e) => setNewTarget(e.target.value)}
          style={{
            flex: 1,
            background: "#1a1a1a",
            border: "1px solid #444",
            color: "#e0e0e0",
            padding: "6px 10px",
            borderRadius: 4,
            fontSize: 13,
          }}
        />
        <button
          onClick={handleAdd}
          style={{
            background: "#333",
            border: "1px solid #555",
            color: "#e0e0e0",
            padding: "6px 12px",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          + Add
        </button>
      </div>
    </div>
  );
}
