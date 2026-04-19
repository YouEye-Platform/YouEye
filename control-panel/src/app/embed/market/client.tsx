"use client";

import { useEffect, useState, useCallback, useRef } from "react";

interface MarketApp {
  id: string;
  name: string;
  description: string;
  icon?: string;
  category: string;
  tags?: string[];
  version?: string;
  type?: string;
  sso?: boolean;
  installed: boolean;
  installInfo?: { appId: string; status: string };
  installedVersion?: string | null;
  updateAvailable?: boolean;
  catalogVersion?: string | null;
  entrances?: Array<{ name: string; subdomain?: string }>;
  installParams?: Array<{
    name: string;
    label?: string;
    type?: string;
    default?: string;
    required?: boolean;
    choices?: string[];
    description?: string;
  }>;
}

interface InstallProgress {
  step: number;
  totalSteps: number;
  status: "running" | "success" | "error" | "skipped";
  message: string;
  detail?: string;
}

interface ActiveInstall {
  appId: string;
  appName: string;
  events: InstallProgress[];
  done: boolean;
  error?: string;
}

const CATEGORY_ORDER = ["productivity", "search", "media", "social", "utilities"];
const CATEGORY_LABELS: Record<string, string> = {
  productivity: "Productivity",
  search: "Search",
  media: "Media",
  social: "Social",
  utilities: "Utilities",
};

export function MarketEmbedClient() {
  const [apps, setApps] = useState<MarketApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [domain, setDomain] = useState("");
  const [search, setSearch] = useState("");

  // Install state
  const [installTarget, setInstallTarget] = useState<MarketApp | null>(null);
  const [installForm, setInstallForm] = useState<{ subdomain: string; params: Record<string, string> }>({ subdomain: "", params: {} });
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState<InstallProgress[]>([]);
  const [installDone, setInstallDone] = useState(false);

  // Uninstall state
  const [uninstallTarget, setUninstallTarget] = useState<MarketApp | null>(null);
  const [uninstalling, setUninstalling] = useState(false);

  // Active installs polling
  const [activeInstalls, setActiveInstalls] = useState<ActiveInstall[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressRef = useRef<HTMLDivElement>(null);

  const fetchCatalog = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/ui-bridge/market?action=catalog");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setApps(data.apps ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load catalog");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const fetchDomain = useCallback(async () => {
    try {
      const res = await fetch("/api/ui-bridge/config");
      if (res.ok) {
        const data = await res.json();
        setDomain(data.domain || "");
      }
    } catch { /* best-effort */ }
  }, []);

  const pollActiveInstalls = useCallback(async () => {
    try {
      const res = await fetch("/api/ui-bridge/market?action=install-progress");
      if (res.ok) {
        const data = await res.json();
        const active = (data.installs ?? []).filter((i: ActiveInstall) => !i.done);
        setActiveInstalls(active);
        if (active.length === 0 && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          fetchCatalog();
        }
      }
    } catch { /* best-effort */ }
  }, [fetchCatalog]);

  useEffect(() => {
    fetchCatalog();
    fetchDomain();
    pollActiveInstalls();
  }, [fetchCatalog, fetchDomain, pollActiveInstalls]);

  // Auto-scroll progress
  useEffect(() => {
    if (progressRef.current) {
      progressRef.current.scrollTop = progressRef.current.scrollHeight;
    }
  }, [installProgress]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/ui-bridge/market?action=refresh-catalog", { method: "POST" });
    } catch { /* best-effort */ }
    await fetchCatalog();
    setRefreshing(false);
  };

  const openInstallForm = (app: MarketApp) => {
    const defaultSub = app.entrances?.[0]?.subdomain || app.id.replace(/^ye-app-/i, "").replace(/\s+/g, "-").toLowerCase();
    const params: Record<string, string> = {};
    if (app.installParams) {
      for (const p of app.installParams) {
        params[p.name] = p.default || "";
      }
    }
    setInstallForm({ subdomain: defaultSub, params });
    setInstallProgress([]);
    setInstallDone(false);
    setInstallTarget(app);
  };

  const handleInstall = async () => {
    if (!installTarget || !domain) return;
    setInstalling(true);
    setInstallProgress([]);
    setInstallDone(false);

    try {
      const res = await fetch("/api/ui-bridge/market?action=install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: installTarget.id,
          subdomain: installForm.subdomain,
          domain,
          enableSSO: true,
          installParams: Object.keys(installForm.params).length > 0 ? installForm.params : undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Install failed" }));
        setInstallProgress([{ step: 0, totalSteps: 0, status: "error", message: err.error || "Install failed" }]);
        setInstallDone(true);
        setInstalling(false);
        return;
      }

      // Start polling for other consumers
      if (!pollRef.current) {
        pollRef.current = setInterval(pollActiveInstalls, 2000);
      }

      // Read SSE stream
      const reader = res.body?.getReader();
      if (!reader) { setInstalling(false); return; }
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            try {
              const event: InstallProgress = JSON.parse(trimmed.slice(6));
              setInstallProgress(prev => [...prev, event]);
            } catch { /* skip malformed */ }
          }
        }
      }

      setInstallDone(true);
      setInstalling(false);
      fetchCatalog();
    } catch (err) {
      setInstallProgress(prev => [...prev, {
        step: 0, totalSteps: 0, status: "error",
        message: err instanceof Error ? err.message : "Install failed",
      }]);
      setInstallDone(true);
      setInstalling(false);
    }
  };

  const handleCancelInstall = async () => {
    if (!installTarget) return;
    try {
      await fetch("/api/ui-bridge/market?action=cancel-install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: installTarget.id }),
      });
    } catch { /* best-effort */ }
    setInstalling(false);
    setInstallTarget(null);
  };

  const handleUninstall = async () => {
    if (!uninstallTarget) return;
    setUninstalling(true);
    try {
      const res = await fetch("/api/ui-bridge/market?action=uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: uninstallTarget.id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Uninstall failed" }));
        console.error("Uninstall error:", data.error);
      }
      fetchCatalog();
    } catch (err) {
      console.error("Uninstall failed:", err);
    } finally {
      setUninstalling(false);
      setUninstallTarget(null);
    }
  };

  // Filter + group
  const filtered = apps.filter(a => {
    if (!search) return true;
    const q = search.toLowerCase();
    return a.name.toLowerCase().includes(q)
      || a.description.toLowerCase().includes(q)
      || a.category.toLowerCase().includes(q)
      || (a.tags || []).some(t => t.toLowerCase().includes(q));
  });

  const installed = filtered.filter(a => a.installed);
  const available = filtered.filter(a => !a.installed);
  const grouped: Record<string, MarketApp[]> = {};
  for (const app of available) {
    const cat = app.category || "utilities";
    (grouped[cat] ??= []).push(app);
  }

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <div className="embed-skeleton" style={{ height: 20, width: 200, marginBottom: 16 }} />
        <div className="embed-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
          {[1, 2, 3, 4, 5, 6].map(i => (
            <div key={i} className="embed-card">
              <div className="embed-skeleton" style={{ height: 40, width: 40, borderRadius: 8, marginBottom: 8 }} />
              <div className="embed-skeleton" style={{ height: 14, width: 120, marginBottom: 6 }} />
              <div className="embed-skeleton" style={{ height: 12, width: "80%" }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 16 }}>
        <div className="embed-card" style={{ textAlign: "center", padding: 32 }}>
          <div style={{ color: "var(--embed-danger)", marginBottom: 8 }}>{error}</div>
          <button className="embed-btn" onClick={() => { setLoading(true); fetchCatalog(); }}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div className="embed-title">App Market</div>
          <div className="embed-subtitle">Browse and install apps for your platform</div>
        </div>
        <button className="embed-btn" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {/* Search */}
      <div style={{ marginBottom: 16 }}>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search apps..."
          style={{
            width: "100%", padding: "8px 12px", fontSize: 13, borderRadius: 8,
            border: "1px solid var(--embed-border)", background: "var(--embed-card-bg)",
            color: "var(--embed-text)", outline: "none",
          }}
        />
      </div>

      {/* Active installs banner */}
      {activeInstalls.length > 0 && (
        <div className="embed-card" style={{ marginBottom: 16, borderColor: "var(--embed-primary)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: "var(--embed-primary)" }}>
            Installing...
          </div>
          {activeInstalls.map(inst => {
            const last = inst.events[inst.events.length - 1];
            const pct = last ? Math.round((last.step / Math.max(last.totalSteps, 1)) * 100) : 0;
            return (
              <div key={inst.appId} style={{ fontSize: 12, marginBottom: 4 }}>
                <span style={{ fontWeight: 500 }}>{inst.appName}</span>
                <span className="embed-muted"> — {last?.message || "Starting..."}</span>
                <div className="embed-progress-track" style={{ marginTop: 4 }}>
                  <div className="embed-progress-bar" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Installed */}
      {installed.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--embed-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
            Installed ({installed.length})
          </div>
          <div className="embed-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {installed.map(app => (
              <AppCard key={app.id} app={app} onInstall={openInstallForm} onUninstall={setUninstallTarget} />
            ))}
          </div>
        </div>
      )}

      {/* Available by category */}
      {[...CATEGORY_ORDER, ...Object.keys(grouped).filter(c => !CATEGORY_ORDER.includes(c))].map(cat => {
        const catApps = grouped[cat];
        if (!catApps?.length) return null;
        return (
          <div key={cat} style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--embed-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
              {CATEGORY_LABELS[cat] || cat}
            </div>
            <div className="embed-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
              {catApps.map(app => (
                <AppCard key={app.id} app={app} onInstall={openInstallForm} onUninstall={setUninstallTarget} />
              ))}
            </div>
          </div>
        );
      })}

      {filtered.length === 0 && (
        <div className="embed-card" style={{ textAlign: "center", padding: 32 }}>
          <div className="embed-muted">No apps found</div>
        </div>
      )}

      {/* Install Dialog */}
      {installTarget && (
        <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)", zIndex: 100 }}
          onClick={() => { if (!installing) setInstallTarget(null); }}>
          <div className="embed-card" style={{ maxWidth: 480, width: "90%", maxHeight: "80vh", overflow: "auto" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
              Install {installTarget.name}
            </div>
            <div className="embed-muted" style={{ fontSize: 12, marginBottom: 16 }}>
              {installTarget.description}
            </div>

            {!installing && !installDone && (
              <>
                {/* Subdomain */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Subdomain</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <input type="text" value={installForm.subdomain}
                      onChange={e => setInstallForm(f => ({ ...f, subdomain: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") }))}
                      style={{
                        flex: 1, padding: "6px 10px", fontSize: 13, borderRadius: 6,
                        border: "1px solid var(--embed-border)", background: "var(--embed-bg)",
                        color: "var(--embed-text)", outline: "none",
                      }} />
                    <span className="embed-muted" style={{ fontSize: 13 }}>.{domain}</span>
                  </div>
                </div>

                {/* Install params */}
                {installTarget.installParams?.map(param => (
                  <div key={param.name} style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                      {param.label || param.name}
                      {param.required && <span style={{ color: "var(--embed-danger)" }}> *</span>}
                    </div>
                    {param.description && (
                      <div className="embed-muted" style={{ fontSize: 11, marginBottom: 4 }}>{param.description}</div>
                    )}
                    {param.choices ? (
                      <select
                        value={installForm.params[param.name] || ""}
                        onChange={e => setInstallForm(f => ({ ...f, params: { ...f.params, [param.name]: e.target.value } }))}
                        style={{
                          width: "100%", padding: "6px 10px", fontSize: 13, borderRadius: 6,
                          border: "1px solid var(--embed-border)", background: "var(--embed-bg)",
                          color: "var(--embed-text)", outline: "none",
                        }}>
                        <option value="">Select...</option>
                        {param.choices.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    ) : (
                      <input
                        type={param.type === "number" ? "number" : "text"}
                        value={installForm.params[param.name] || ""}
                        onChange={e => setInstallForm(f => ({ ...f, params: { ...f.params, [param.name]: e.target.value } }))}
                        placeholder={param.default || ""}
                        style={{
                          width: "100%", padding: "6px 10px", fontSize: 13, borderRadius: 6,
                          border: "1px solid var(--embed-border)", background: "var(--embed-bg)",
                          color: "var(--embed-text)", outline: "none",
                        }} />
                    )}
                  </div>
                ))}

                {/* SSO badge */}
                {installTarget.sso !== false && (
                  <div className="embed-badge-green" style={{ marginBottom: 12, display: "inline-block", fontSize: 11 }}>
                    SSO enabled automatically
                  </div>
                )}

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
                  <button className="embed-btn" onClick={() => setInstallTarget(null)}>Cancel</button>
                  <button className="embed-btn" onClick={handleInstall}
                    disabled={!installForm.subdomain}
                    style={{ borderColor: "var(--embed-primary)", color: "var(--embed-primary)" }}>
                    Install
                  </button>
                </div>
              </>
            )}

            {/* Progress */}
            {(installing || installDone) && (
              <>
                <div ref={progressRef} style={{
                  maxHeight: 300, overflowY: "auto", fontSize: 12,
                  background: "var(--embed-bg)", borderRadius: 6,
                  border: "1px solid var(--embed-border)", padding: 10,
                }}>
                  {installProgress.map((ev, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 4 }}>
                      <span style={{
                        flexShrink: 0, width: 14, textAlign: "center",
                        color: ev.status === "success" ? "var(--embed-success)"
                          : ev.status === "error" ? "var(--embed-danger)"
                          : ev.status === "skipped" ? "var(--embed-text-muted)"
                          : "var(--embed-primary)",
                      }}>
                        {ev.status === "success" ? "✓" : ev.status === "error" ? "✗" : ev.status === "skipped" ? "–" : "●"}
                      </span>
                      <span style={{ color: ev.status === "error" ? "var(--embed-danger)" : "var(--embed-text)" }}>
                        {ev.message}
                        {ev.detail && <span className="embed-muted"> — {ev.detail}</span>}
                      </span>
                    </div>
                  ))}
                  {installing && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--embed-primary)" }}>
                      <span style={{ animation: "embed-pulse 1s infinite" }}>●</span>
                      <span>Working...</span>
                    </div>
                  )}
                </div>

                {/* Progress bar */}
                {installing && installProgress.length > 0 && (() => {
                  const last = installProgress[installProgress.length - 1];
                  const pct = Math.round((last.step / Math.max(last.totalSteps, 1)) * 100);
                  return (
                    <div className="embed-progress-track" style={{ marginTop: 8 }}>
                      <div className="embed-progress-bar" style={{ width: `${pct}%` }} />
                    </div>
                  );
                })()}

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                  {installing && (
                    <button className="embed-btn" onClick={handleCancelInstall}
                      style={{ borderColor: "var(--embed-danger)", color: "var(--embed-danger)" }}>
                      Cancel
                    </button>
                  )}
                  {installDone && (
                    <button className="embed-btn" onClick={() => { setInstallTarget(null); setInstallProgress([]); }}
                      style={{ borderColor: "var(--embed-primary)", color: "var(--embed-primary)" }}>
                      Close
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Uninstall Dialog */}
      {uninstallTarget && (
        <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)", zIndex: 100 }}
          onClick={() => { if (!uninstalling) setUninstallTarget(null); }}>
          <div className="embed-card" style={{ maxWidth: 400, width: "90%" }} onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>Uninstall {uninstallTarget.name}?</div>
            <div className="embed-muted" style={{ fontSize: 13, marginBottom: 4 }}>
              This will remove the container, Caddy route, and SSO configuration.
            </div>
            <div style={{
              padding: "8px 12px", borderRadius: 6, fontSize: 12, marginBottom: 12,
              background: "color-mix(in srgb, var(--embed-danger) 10%, transparent)",
              border: "1px solid color-mix(in srgb, var(--embed-danger) 25%, transparent)",
              color: "var(--embed-danger)",
            }}>
              This action cannot be undone. App data will be permanently deleted.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="embed-btn" onClick={() => setUninstallTarget(null)} disabled={uninstalling}>Cancel</button>
              <button className="embed-btn" onClick={handleUninstall} disabled={uninstalling}
                style={{ borderColor: "var(--embed-danger)", color: "var(--embed-danger)" }}>
                {uninstalling ? "Uninstalling..." : "Uninstall"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AppCard({ app, onInstall, onUninstall }: {
  app: MarketApp;
  onInstall: (app: MarketApp) => void;
  onUninstall: (app: MarketApp) => void;
}) {
  return (
    <div className="embed-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 8, flexShrink: 0,
          background: "var(--embed-hover)", display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: app.icon ? 20 : 15, fontWeight: 700, color: "var(--embed-text-muted)",
        }}>
          {app.icon || app.name.charAt(0)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontWeight: 500, fontSize: 13 }}>{app.name}</span>
            {app.version && <span className="embed-muted" style={{ fontSize: 11 }}>v{app.version}</span>}
          </div>
          <div className="embed-muted" style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {app.description}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <span className="embed-badge" style={{ fontSize: 10 }}>{app.category}</span>
          {app.sso !== false && <span className="embed-badge-green" style={{ fontSize: 10 }}>SSO</span>}
          {app.type === "native" && <span className="embed-badge" style={{ fontSize: 10 }}>native</span>}
        </div>
        <div>
          {app.installed ? (
            <button className="embed-btn" onClick={() => onUninstall(app)}
              style={{ padding: "3px 10px", fontSize: 11, borderColor: "var(--embed-danger)", color: "var(--embed-danger)" }}>
              Uninstall
            </button>
          ) : (
            <button className="embed-btn" onClick={() => onInstall(app)}
              style={{ padding: "3px 10px", fontSize: 11, borderColor: "var(--embed-primary)", color: "var(--embed-primary)" }}>
              Install
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
