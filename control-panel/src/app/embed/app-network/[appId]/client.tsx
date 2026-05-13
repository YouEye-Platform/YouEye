"use client";

import { useEffect, useState, useCallback } from "react";

interface Bridge {
  id: string;
  from: string;
  to: string;
  direction: "one-way" | "both-ways";
  approved: boolean;
  active: boolean;
  activatedAt?: string;
}

interface InternetGrant {
  id: string;
  appId: string;
  containerName: string;
  hosts: string[];
  blanket: boolean;
  active: boolean;
}

interface Suggestion {
  id: string;
  type: "bridge" | "internet";
  fromAppId: string;
  fromAppName: string;
  targetAppId?: string;
  targetAppName?: string;
  hosts?: string[];
  targetInstalled?: boolean;
  dismissed: boolean;
}

interface ProviderOption {
  appId: string;
  name: string;
  description?: string;
  port?: number;
  installed: boolean;
}

interface TypeWant {
  type: string;
  name: string;
  description?: string;
  defaultPort?: number;
  providers: ProviderOption[];
  connectedProvider: string | null;
}

export function AppNetworkClient({ appId }: { appId: string }) {
  const [bridges, setBridges] = useState<Bridge[]>([]);
  const [grants, setGrants] = useState<InternetGrant[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [typeWants, setTypeWants] = useState<TypeWant[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTarget, setNewTarget] = useState("");
  const [approving, setApproving] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [bridgesRes, grantsRes, suggestionsRes, providerRes] = await Promise.all([
        fetch(`/api/bridges?appId=${appId}`),
        fetch("/api/internet-grants"),
        fetch("/api/suggestions"),
        fetch(`/api/market/app/${appId}/provider-options`),
      ]);

      if (bridgesRes.ok) {
        const data = await bridgesRes.json();
        const all = Array.isArray(data) ? data : (data.bridges ?? []);
        setBridges(all.filter((b: Bridge) => b.from === appId || b.to === appId));
      }
      if (grantsRes.ok) {
        const data = await grantsRes.json();
        const all = Array.isArray(data) ? data : [];
        setGrants(all.filter((g: InternetGrant) => g.appId === appId));
      }
      if (suggestionsRes.ok) {
        const data = await suggestionsRes.json();
        const all = Array.isArray(data) ? data : (data.suggestions ?? []);
        setSuggestions(
          all.filter((s: Suggestion) => !s.dismissed && (s.fromAppId === appId || s.targetAppId === appId))
        );
      }
      if (providerRes.ok) {
        const data = await providerRes.json();
        setTypeWants(data.typeWants ?? []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  async function handleToggleDirection(bridgeId: string) {
    const bridge = bridges.find((b) => b.id === bridgeId);
    if (!bridge) return;
    const newDir = bridge.direction === "one-way" ? "both-ways" : "one-way";
    await fetch(`/api/bridges/${bridgeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: newDir }),
    });
    fetchAll();
  }

  async function handleRemoveBridge(bridgeId: string) {
    await fetch(`/api/bridges/${bridgeId}`, { method: "DELETE" });
    setBridges(bridges.filter((b) => b.id !== bridgeId));
    notifyParent();
  }

  async function handleAddBridge() {
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
    fetchAll();
    notifyParent();
  }

  async function handleRevokeGrant(id: string) {
    await fetch(`/api/internet-grants/${id}`, { method: "DELETE" });
    setGrants(grants.filter((g) => g.id !== id));
    notifyParent();
  }

  async function handleApproveSuggestion(suggestion: Suggestion) {
    setApproving(suggestion.id);
    try {
      const res = await fetch("/api/suggestions/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggestionId: suggestion.id }),
      });
      if (res.ok) {
        setSuggestions(suggestions.filter((s) => s.id !== suggestion.id));
        fetchAll();
        notifyParent();
      }
    } finally {
      setApproving(null);
    }
  }

  async function handleDismissSuggestion(id: string) {
    await fetch(`/api/suggestions/${id}/dismiss`, { method: "POST" });
    setSuggestions(suggestions.filter((s) => s.id !== id));
  }

  async function handleConnectProvider(providerId: string, currentProvider: string | null) {
    setSwitching(providerId);
    try {
      // Disconnect old provider if one is connected
      if (currentProvider) {
        const oldBridge = bridges.find(
          (b) => b.from === appId && b.to === currentProvider && b.active
        );
        if (oldBridge) {
          await fetch(`/api/bridges/${oldBridge.id}`, { method: "DELETE" });
        }
      }

      // Connect new provider
      await fetch("/api/bridges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: appId,
          to: providerId,
          direction: "one-way",
          activate: true,
          approvedBy: "admin",
        }),
      });

      await fetchAll();
      notifyParent();
    } finally {
      setSwitching(null);
    }
  }

  async function handleDisconnectProvider(providerId: string) {
    setSwitching(providerId);
    try {
      const bridge = bridges.find(
        (b) => b.from === appId && b.to === providerId && b.active
      );
      if (bridge) {
        await fetch(`/api/bridges/${bridge.id}`, { method: "DELETE" });
      }
      await fetchAll();
      notifyParent();
    } finally {
      setSwitching(null);
    }
  }

  function notifyParent() {
    window.parent.postMessage({ type: "youeye-network-changed", appId }, "*");
  }

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <div className="embed-skeleton" style={{ height: 16, width: 160, marginBottom: 12 }} />
        <div className="embed-skeleton" style={{ height: 48, marginBottom: 6 }} />
        <div className="embed-skeleton" style={{ height: 48, marginBottom: 6 }} />
      </div>
    );
  }

  const outgoing = bridges.filter((b) => b.from === appId);
  const incoming = bridges.filter((b) => b.to === appId && b.from !== appId);
  const activeGrants = grants.filter((g) => g.active);
  const pendingSuggestions = suggestions.filter((s) => !s.dismissed);

  // Filter out provider-managed bridges from the manual bridges section
  const providerAppIds = new Set(typeWants.flatMap(tw => tw.providers.map(p => p.appId)));
  const manualOutgoing = outgoing.filter((b) => !providerAppIds.has(b.to));

  return (
    <div style={{ padding: 16 }}>
      {/* Service Providers (type-based wants) */}
      {typeWants.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--embed-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
            Service Providers
          </div>

          {typeWants.map((tw) => (
            <div key={tw.type} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--embed-text)", marginBottom: 6 }}>
                {tw.name}
                {tw.description && (
                  <span className="embed-muted" style={{ fontWeight: 400, marginLeft: 6, fontSize: 12 }}>
                    {tw.description}
                  </span>
                )}
              </div>

              {tw.providers.length === 0 ? (
                <div className="embed-muted" style={{ fontSize: 12, padding: "8px 14px", textAlign: "center", border: "1px dashed var(--embed-border)", borderRadius: 6 }}>
                  No providers installed. Install a compatible app from the marketplace.
                </div>
              ) : (
                tw.providers.map((p) => {
                  const isConnected = tw.connectedProvider === p.appId;
                  const isSwitching = switching === p.appId;

                  return (
                    <div key={p.appId} className="embed-card" style={{
                      marginBottom: 4, padding: "8px 14px",
                      borderColor: isConnected
                        ? "color-mix(in srgb, var(--embed-success) 40%, var(--embed-border))"
                        : undefined,
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{
                          width: 14, height: 14, borderRadius: "50%",
                          border: `2px solid ${isConnected ? "var(--embed-success)" : "var(--embed-border)"}`,
                          background: isConnected ? "var(--embed-success)" : "transparent",
                          display: "inline-flex", alignItems: "center", justifyContent: "center",
                          flexShrink: 0,
                        }}>
                          {isConnected && (
                            <span style={{ color: "#fff", fontSize: 9, lineHeight: 1 }}>{"\u2713"}</span>
                          )}
                        </span>

                        <span style={{ flex: 1, fontSize: 13 }}>
                          {p.name}
                          {p.description && (
                            <span className="embed-muted" style={{ marginLeft: 6, fontSize: 11 }}>
                              {p.description}
                            </span>
                          )}
                        </span>

                        {isConnected ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ color: "var(--embed-success)", fontSize: 11, fontWeight: 500 }}>
                              Connected
                            </span>
                            <button
                              className="embed-btn"
                              style={{ padding: "2px 8px", fontSize: 11, color: "var(--embed-danger)" }}
                              onClick={() => handleDisconnectProvider(p.appId)}
                              disabled={!!switching}
                            >
                              {isSwitching ? "..." : "Disconnect"}
                            </button>
                          </div>
                        ) : (
                          <button
                            className="embed-btn"
                            style={{
                              padding: "2px 10px", fontSize: 11,
                              borderColor: "var(--embed-success)", color: "var(--embed-success)",
                            }}
                            onClick={() => handleConnectProvider(p.appId, tw.connectedProvider)}
                            disabled={!!switching}
                          >
                            {isSwitching ? "..." : tw.connectedProvider ? "Switch" : "Connect"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ))}
        </div>
      )}

      {/* Pending Suggestions */}
      {pendingSuggestions.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--embed-warning)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
            Pending Connections ({pendingSuggestions.length})
          </div>
          {pendingSuggestions.map((s) => (
            <div key={s.id} className="embed-card" style={{
              marginBottom: 6, padding: "10px 14px",
              borderColor: "color-mix(in srgb, var(--embed-warning) 30%, var(--embed-border))",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13 }}>
                  <strong>{s.fromAppName}</strong>
                  {" \u2192 "}
                  <strong>{s.type === "internet" ? "Internet" : (s.targetAppName || "?")}</strong>
                </span>
                {s.type === "internet" && s.hosts && (
                  <span className="embed-muted" style={{ fontSize: 12 }}>
                    ({s.hosts.join(", ")})
                  </span>
                )}
                {s.targetInstalled === false && (
                  <span style={{ fontSize: 11, color: "var(--embed-warning)" }}>not installed</span>
                )}
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button
                    className="embed-btn"
                    style={{ padding: "2px 8px", fontSize: 11, borderColor: "var(--embed-success)", color: "var(--embed-success)" }}
                    onClick={() => handleApproveSuggestion(s)}
                    disabled={approving === s.id}
                  >
                    {approving === s.id ? "..." : "\u2713 Approve"}
                  </button>
                  <button
                    className="embed-btn"
                    style={{ padding: "2px 8px", fontSize: 11 }}
                    onClick={() => handleDismissSuggestion(s.id)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Bridges (manual, non-provider) */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--embed-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
          App Connections (Bridges)
        </div>

        {manualOutgoing.length === 0 && incoming.length === 0 && (
          <div className="embed-muted" style={{ fontSize: 13, marginBottom: 12, padding: "12px 0", textAlign: "center" }}>
            No bridges configured for this app.
          </div>
        )}

        {manualOutgoing.map((b) => (
          <div key={b.id} className="embed-card" style={{ marginBottom: 6, padding: "8px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flex: 1, fontSize: 13 }}>
                {b.to}
                <span className="embed-muted" style={{ marginLeft: 8, fontSize: 12 }}>
                  {b.direction === "both-ways" ? "\u21c4" : "\u2192"} {b.direction}
                </span>
              </span>
              <span style={{ color: b.active ? "var(--embed-success)" : "var(--embed-warning)", fontSize: 11 }}>
                {b.active ? "active" : "pending"}
              </span>
              <button className="embed-btn" style={{ padding: "2px 8px", fontSize: 11 }}
                onClick={() => handleToggleDirection(b.id)}>
                {b.direction === "one-way" ? "Both ways" : "One-way"}
              </button>
              <button className="embed-btn" style={{ padding: "2px 8px", fontSize: 11, color: "var(--embed-danger)" }}
                onClick={() => handleRemoveBridge(b.id)}>
                Remove
              </button>
            </div>
          </div>
        ))}

        {incoming.map((b) => (
          <div key={b.id} className="embed-card embed-muted" style={{ marginBottom: 6, padding: "8px 14px" }}>
            <span style={{ fontSize: 13 }}>{"\u2190"} {b.from} can reach this app</span>
            <span style={{ float: "right", color: b.active ? "var(--embed-success)" : "var(--embed-warning)", fontSize: 11 }}>
              {b.active ? "active" : "pending"}
            </span>
          </div>
        ))}

        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
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
          <button className="embed-btn" onClick={handleAddBridge}>+ Add</button>
        </div>
      </div>

      {/* Internet Grants */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--embed-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
          Internet Access
        </div>

        {activeGrants.length === 0 ? (
          <div className="embed-muted" style={{ fontSize: 13, padding: "12px 0", textAlign: "center" }}>
            No internet access granted for this app.
          </div>
        ) : (
          activeGrants.map((g) => (
            <div key={g.id} className="embed-card" style={{ marginBottom: 6, padding: "8px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, fontSize: 13 }}>
                  {g.blanket
                    ? "All internet access"
                    : `${g.hosts.length} host${g.hosts.length !== 1 ? "s" : ""}: ${g.hosts.join(", ")}`}
                </span>
                <button
                  className="embed-btn"
                  style={{ padding: "2px 8px", fontSize: 11, color: "var(--embed-danger)" }}
                  onClick={() => handleRevokeGrant(g.id)}
                >
                  Revoke
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
