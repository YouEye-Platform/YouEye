"use client";

import { useEffect, useState } from "react";

interface ProxyRoute {
  id: string;
  match_domain: string;
  upstream: string;
  tls_enabled: boolean;
}

export function ProxyEmbedClient() {
  const [routes, setRoutes] = useState<ProxyRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function fetchRoutes() {
    try {
      setError(null);
      const res = await fetch("/api/ui-bridge/proxy/routes");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setRoutes(json.routes ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    fetchRoutes();
  }, []);

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <div className="embed-skeleton" style={{ height: 20, width: 200, marginBottom: 16 }} />
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="embed-skeleton" style={{ height: 40, width: "100%", marginBottom: 8 }} />
        ))}
      </div>
    );
  }

  if (error) return <div className="embed-error">{error}</div>;

  return (
    <div style={{ padding: 16 }}>
      <div className="embed-header">
        <div>
          <div className="embed-title">Proxy Routes</div>
          <div className="embed-subtitle">Caddy reverse proxy routes (read-only)</div>
        </div>
        <button className="embed-btn" onClick={() => { setRefreshing(true); fetchRoutes(); }} disabled={refreshing}>
          {refreshing ? "..." : "Refresh"}
        </button>
      </div>

      {routes.length === 0 ? (
        <div className="embed-error">No proxy routes configured.</div>
      ) : (
        <div className="embed-card" style={{ padding: 0 }}>
          <table className="embed-table">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Upstream</th>
                <th>TLS</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((route) => (
                <tr key={route.id}>
                  <td style={{ fontWeight: 500 }}>{route.match_domain}</td>
                  <td className="embed-mono embed-muted">{route.upstream}</td>
                  <td>
                    {route.tls_enabled ? (
                      <span className="embed-badge embed-badge-green">Enabled</span>
                    ) : (
                      <span className="embed-badge">Disabled</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
