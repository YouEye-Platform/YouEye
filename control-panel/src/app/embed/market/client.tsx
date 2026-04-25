"use client";

import { useEffect, useState, useCallback, useRef } from "react";

// ─── Types ────────────────────────────────────────────────

interface MarketApp {
  id: string;
  name: string;
  description: string;
  icon?: string;
  iconUrl?: string;
  category: string;
  integration?: "native" | "basic";
  tags?: string[];
  version?: string;
  type?: string;
  sso?: boolean;
  supportsSSO?: boolean;
  website?: string;
  installed: boolean;
  installInfo?: { appId: string; status: string };
  installedVersion?: string | null;
  updateAvailable?: boolean;
  catalogVersion?: string | null;
  entrances?: Array<{ name: string; subdomain?: string; path?: string; port?: number; authLevel?: string }>;
  installParams?: Array<{
    name: string;
    label?: string;
    type?: string;
    default?: string;
    required?: boolean;
    choices?: string[];
    description?: string;
  }>;
  forwardAuth?: string;
  detail?: {
    longDescription?: string;
    screenshots?: Array<{ url: string; caption?: string }>;
  };
}

interface InstallProgress {
  step: number;
  totalSteps: number;
  status: "running" | "success" | "error" | "skipped" | "warning";
  message: string;
  detail?: string;
  phase?: "install" | "verify";
  duration?: number;
  errorContext?: {
    url?: string;
    method?: string;
    statusCode?: number;
    responseBody?: string;
    resolvedVars?: Record<string, string>;
    suggestion?: string;
  };
}

interface ActiveInstall {
  appId: string;
  appName: string;
  events: InstallProgress[];
  done: boolean;
  error?: string;
}

interface ConnectionInfo {
  targetAppId: string;
  targetAppName: string;
  description?: string;
  installed: boolean;
  defaultPort?: number;
}

interface ConnectionsData {
  outgoing: ConnectionInfo[];
  incoming: ConnectionInfo[];
  internet: { hosts: string[]; needsInternet: boolean };
}

// ─── Constants ────────────────────────────────────────────

const CATEGORY_ORDER = ["productivity", "search", "media", "social", "utilities"];
const CATEGORY_LABELS: Record<string, string> = {
  productivity: "Productivity",
  search: "Search",
  media: "Media",
  social: "Social",
  utilities: "Utilities",
};

// ─── SVG Icons (inline, no external deps) ─────────────────

function ShieldIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function ArrowLeftIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

function ExternalLinkIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function ChevronLeftIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronRightIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function GlobeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z" />
    </svg>
  );
}

function Link2Icon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 17H7A5 5 0 0 1 7 7h2" /><path d="M15 7h2a5 5 0 1 1 0 10h-2" /><line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}

// ─── Main Component ───────────────────────────────────────

export function MarketEmbedClient() {
  const [apps, setApps] = useState<MarketApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [domain, setDomain] = useState("");
  const [search, setSearch] = useState("");

  // Detail view
  const [selectedApp, setSelectedApp] = useState<MarketApp | null>(null);

  // Install state
  const [installTarget, setInstallTarget] = useState<MarketApp | null>(null);
  const [installForm, setInstallForm] = useState<{ subdomain: string; params: Record<string, string> }>({ subdomain: "", params: {} });
  const [installError, setInstallError] = useState<string | null>(null);

  // Validation state (F1)
  const [validationReport, setValidationReport] = useState<{ valid: boolean; errors: { check: string; severity: string; message: string; detail?: string }[]; warnings: { check: string; severity: string; message: string; detail?: string }[]; info: { check: string; severity: string; message: string; detail?: string }[] } | null>(null);
  const [validating, setValidating] = useState(false);

  // Connection toggles state
  const [connections, setConnections] = useState<ConnectionsData | null>(null);
  const [connectionToggles, setConnectionToggles] = useState<Record<string, boolean>>({});
  const [allowInternet, setAllowInternet] = useState(false);

  // Uninstall state
  const [uninstallTarget, setUninstallTarget] = useState<MarketApp | null>(null);
  const [uninstalling, setUninstalling] = useState(false);

  // Active installs polling
  const [activeInstalls, setActiveInstalls] = useState<ActiveInstall[]>([]);
  const [completedInstalls, setCompletedInstalls] = useState<string[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevActiveRef = useRef<Set<string>>(new Set());

  // Screenshot lightbox
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

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
        const allInstalls: ActiveInstall[] = data.installs ?? [];
        const active = allInstalls.filter((i) => !i.done);
        const done = allInstalls.filter((i) => i.done);

        // Detect newly completed installs → notify parent UI
        const activeIds = new Set(active.map((i) => i.appId));
        for (const id of prevActiveRef.current) {
          if (!activeIds.has(id)) {
            const completed = done.find((i) => i.appId === id);
            window.parent.postMessage({
              type: "youeye-app-install-complete",
              appId: id,
              appName: completed?.appName || id,
              error: completed?.error || null,
            }, "*");
            setCompletedInstalls((prev) => [...prev, id]);
            setTimeout(() => setCompletedInstalls((prev) => prev.filter((x) => x !== id)), 5000);
          }
        }
        prevActiveRef.current = activeIds;

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

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/ui-bridge/market?action=refresh-catalog", { method: "POST" });
    } catch { /* best-effort */ }
    await fetchCatalog();
    setRefreshing(false);
  };

  const openInstallForm = async (app: MarketApp) => {
    const defaultSub = app.entrances?.[0]?.subdomain || app.id.replace(/^ye-app-/i, "").replace(/\s+/g, "-").toLowerCase();
    const params: Record<string, string> = {};
    if (app.installParams) {
      for (const p of app.installParams) {
        params[p.name] = p.default || "";
      }
    }
    setInstallForm({ subdomain: defaultSub, params });
    setInstallError(null);
    setValidationReport(null);
    setConnections(null);
    setConnectionToggles({});
    setAllowInternet(false);
    setInstallTarget(app);

    // F1: trigger async validation
    setValidating(true);
    fetch("/api/ui-bridge/market?action=validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: app.id, checkImages: true, checkUrls: false }),
    })
      .then(r => r.json())
      .then(report => setValidationReport(report))
      .catch(() => {})
      .finally(() => setValidating(false));

    // Fetch connections in background
    try {
      const res = await fetch(`/api/ui-bridge/market?action=connections&app=${encodeURIComponent(app.id)}`);
      if (res.ok) {
        const data: ConnectionsData = await res.json();
        setConnections(data);
        const toggles: Record<string, boolean> = {};
        for (const c of data.outgoing) {
          toggles[c.targetAppId] = c.installed;
        }
        setConnectionToggles(toggles);
        setAllowInternet(data.internet.needsInternet);
      }
    } catch {
      // Non-blocking — dialog still works without connections
    }
  };

  const handleInstall = async () => {
    if (!installTarget || !domain) return;

    const target = installTarget;
    const form = { ...installForm };

    // Close dialog immediately — install proceeds in background
    setInstallTarget(null);
    setInstallError(null);

    // Notify parent UI that install started
    window.parent.postMessage({
      type: "youeye-app-install-started",
      appId: target.id,
      appName: target.name,
    }, "*");

    // Track this install for the banner before polling picks it up
    prevActiveRef.current.add(target.id);

    // Build approved connections from toggles
    const approvedConnections = connections?.outgoing?.map(c => ({
      targetAppId: c.targetAppId,
      approved: connectionToggles[c.targetAppId] ?? false,
    })) ?? [];

    try {
      const res = await fetch("/api/ui-bridge/market?action=install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: target.id,
          subdomain: form.subdomain,
          domain,
          enableSSO: true,
          installParams: Object.keys(form.params).length > 0 ? form.params : undefined,
          approvedConnections: approvedConnections.length > 0 ? approvedConnections : undefined,
          allowInternet,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Install failed" }));
        window.parent.postMessage({
          type: "youeye-app-install-complete",
          appId: target.id,
          appName: target.name,
          error: err.error || "Install failed",
        }, "*");
        prevActiveRef.current.delete(target.id);
        return;
      }

      // Start polling for progress banner
      if (!pollRef.current) {
        pollRef.current = setInterval(pollActiveInstalls, 2000);
      }

      // Consume SSE stream in background (don't block — just drain to avoid leak)
      const reader = res.body?.getReader();
      if (reader) {
        (async () => {
          try {
            while (true) {
              const { done } = await reader.read();
              if (done) break;
            }
          } catch { /* stream ended */ }
          fetchCatalog();
        })();
      }
    } catch (err) {
      window.parent.postMessage({
        type: "youeye-app-install-complete",
        appId: target.id,
        appName: target.name,
        error: err instanceof Error ? err.message : "Install failed",
      }, "*");
      prevActiveRef.current.delete(target.id);
    }
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

  // ─── Filter & Group ─────────────────────────────────────

  const filtered = apps.filter(a => {
    if (!search) return true;
    const q = search.toLowerCase();
    return a.name.toLowerCase().includes(q)
      || a.description.toLowerCase().includes(q)
      || a.category.toLowerCase().includes(q)
      || (a.tags || []).some(t => t.toLowerCase().includes(q));
  });

  const nativeApps = filtered.filter(a => a.integration === "native" || a.type === "native");
  const marketplaceApps = filtered.filter(a => a.integration !== "native" && a.type !== "native");

  const installedMarketplace = marketplaceApps.filter(a => a.installed);
  const availableMarketplace = marketplaceApps.filter(a => !a.installed);

  const groupByCategory = (list: MarketApp[]) => {
    const groups: Record<string, MarketApp[]> = {};
    for (const app of list) {
      const cat = app.category || "utilities";
      (groups[cat] ??= []).push(app);
    }
    return groups;
  };

  const nativeGrouped = groupByCategory(nativeApps);
  const availableGrouped = groupByCategory(availableMarketplace);

  // ─── Loading ────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <div className="embed-skeleton" style={{ height: 20, width: 200, marginBottom: 16 }} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
          {[1, 2, 3, 4, 5, 6].map(i => (
            <div key={i} className="embed-card" style={{ display: "flex", alignItems: "center", gap: 12, padding: 16 }}>
              <div className="embed-skeleton" style={{ height: 40, width: 40, borderRadius: 10, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div className="embed-skeleton" style={{ height: 14, width: 120, marginBottom: 6 }} />
                <div className="embed-skeleton" style={{ height: 12, width: "80%" }} />
              </div>
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

  // ─── App Detail View ────────────────────────────────────

  if (selectedApp) {
    const app = selectedApp;
    const isNative = app.integration === "native";
    const longDesc = app.detail?.longDescription || app.description;
    const screenshots = app.detail?.screenshots || [];

    return (
      <div style={{ padding: 16, maxWidth: 900 }}>
        {/* Back button */}
        <button
          onClick={() => { setSelectedApp(null); setLightboxIndex(null); }}
          style={{
            display: "flex", alignItems: "center", gap: 6, fontSize: 13,
            color: "var(--embed-text-muted)", background: "none", border: "none",
            cursor: "pointer", marginBottom: 16, padding: 0,
          }}
        >
          <ArrowLeftIcon size={16} />
          Back to App Market
        </button>

        {/* Header card */}
        <div className="embed-card" style={{ padding: 20, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
            {/* Icon */}
            <div style={{
              width: 64, height: 64, borderRadius: 14, flexShrink: 0,
              background: "color-mix(in srgb, var(--embed-primary) 10%, transparent)",
              display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
            }}>
              {app.iconUrl ? (
                <img src={app.iconUrl} alt={app.name} style={{ width: 40, height: 40, objectFit: "contain" }} />
              ) : (
                <span style={{ fontSize: 24, fontWeight: 700, color: "var(--embed-primary)" }}>
                  {app.name.charAt(0)}
                </span>
              )}
            </div>

            {/* Info */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 20, fontWeight: 700 }}>{app.name}</span>
                {app.version && (
                  <span className="embed-badge" style={{ fontSize: 11 }}>v{app.version}</span>
                )}
                {isNative ? (
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 500,
                    padding: "2px 8px", borderRadius: 9999,
                    background: "color-mix(in srgb, var(--embed-primary) 12%, transparent)",
                    color: "var(--embed-primary)", border: "1px solid color-mix(in srgb, var(--embed-primary) 25%, transparent)",
                  }}>
                    <ShieldIcon size={11} /> YouEye
                  </span>
                ) : (
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 500,
                    padding: "2px 8px", borderRadius: 9999,
                    color: "var(--embed-text-muted)", border: "1px solid var(--embed-border)",
                  }}>
                    <GlobeIcon size={11} /> External
                  </span>
                )}
              </div>
              <div className="embed-muted" style={{ fontSize: 12, marginTop: 4, textTransform: "capitalize" }}>
                {app.category}
              </div>

              {/* Status if installed */}
              {app.installed && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 13 }}>
                  <span style={{ color: "var(--embed-success)", fontWeight: 500 }}>Installed</span>
                  {app.installInfo?.status === "running" && (
                    <span className="embed-badge-green" style={{ fontSize: 10 }}>Running</span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            {!app.installed ? (
              activeInstalls.some(i => i.appId === app.id) ? (
                <button className="embed-btn" disabled
                  style={{ fontWeight: 500, padding: "8px 20px", opacity: 0.6 }}>
                  Installing...
                </button>
              ) : (
                <button className="embed-btn" onClick={() => openInstallForm(app)}
                  style={{ borderColor: "var(--embed-primary)", color: "var(--embed-primary)", fontWeight: 500, padding: "8px 20px" }}>
                  Install {app.name}
                </button>
              )
            ) : (
              <>
                {app.entrances?.[0]?.subdomain && domain && (
                  <button className="embed-btn" onClick={() => window.open(`https://${app.entrances![0].subdomain}.${domain}`, "_blank")}
                    style={{ borderColor: "var(--embed-primary)", color: "var(--embed-primary)", fontWeight: 500, padding: "8px 20px" }}>
                    <ExternalLinkIcon size={14} /> Open {app.name}
                  </button>
                )}
                <button className="embed-btn" onClick={() => setUninstallTarget(app)}
                  style={{ borderColor: "var(--embed-danger)", color: "var(--embed-danger)", padding: "8px 20px" }}>
                  Uninstall
                </button>
              </>
            )}
          </div>
        </div>

        {/* Description */}
        <div className="embed-card" style={{ padding: 20, marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--embed-text-muted)", marginBottom: 10 }}>
            Description
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-line" }}>{longDesc}</div>
        </div>

        {/* Screenshots */}
        {screenshots.length > 0 && (
          <div className="embed-card" style={{ padding: 20, marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--embed-text-muted)", marginBottom: 10 }}>
              Screenshots
            </div>
            <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4 }}>
              {screenshots.map((shot, i) => (
                <button
                  key={i}
                  onClick={() => setLightboxIndex(i)}
                  style={{
                    flexShrink: 0, border: "1px solid var(--embed-border)", borderRadius: 8,
                    overflow: "hidden", cursor: "pointer", background: "none", padding: 0,
                  }}
                >
                  <img
                    src={shot.url}
                    alt={shot.caption || `Screenshot ${i + 1}`}
                    style={{ height: 160, width: "auto", objectFit: "cover", display: "block" }}
                  />
                  {shot.caption && (
                    <div style={{
                      fontSize: 11, padding: "6px 8px", color: "var(--embed-text-muted)",
                      background: "var(--embed-hover)", whiteSpace: "nowrap", overflow: "hidden",
                      textOverflow: "ellipsis", maxWidth: 260,
                    }}>
                      {shot.caption}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Details */}
        <div className="embed-card" style={{ padding: 20, marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--embed-text-muted)", marginBottom: 12 }}>
            Details
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 24px" }}>
            {/* SSO */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
                background: "var(--embed-hover)",
              }}>
                <ShieldIcon size={16} />
              </div>
              <div>
                <div style={{ fontSize: 11, color: "var(--embed-text-muted)" }}>SSO Support</div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>
                  {(app.supportsSSO || app.sso !== false)
                    ? <span style={{ color: "var(--embed-success)" }}>Enabled</span>
                    : app.forwardAuth !== "disabled"
                      ? <span style={{ color: "var(--embed-success)" }}>Forward-auth</span>
                      : <span style={{ color: "var(--embed-text-muted)" }}>Disabled</span>}
                </div>
              </div>
            </div>

            {/* Website */}
            {app.website && (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
                  background: "var(--embed-hover)",
                }}>
                  <GlobeIcon size={16} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--embed-text-muted)" }}>Website</div>
                  <a href={app.website} target="_blank" rel="noopener noreferrer"
                    style={{ fontSize: 13, fontWeight: 500, color: "var(--embed-primary)", textDecoration: "none", display: "flex", alignItems: "center", gap: 4 }}>
                    {(() => { try { return new URL(app.website).hostname; } catch { return app.website; } })()}
                    <ExternalLinkIcon size={11} />
                  </a>
                </div>
              </div>
            )}
          </div>

          {/* Tags */}
          {app.tags && app.tags.length > 0 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--embed-border)" }}>
              <div style={{ fontSize: 11, color: "var(--embed-text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 500 }}>
                Tags
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {app.tags.map(tag => (
                  <span key={tag} style={{
                    fontSize: 11, padding: "3px 10px", borderRadius: 9999,
                    background: "var(--embed-hover)", color: "var(--embed-text-muted)",
                  }}>
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Entrances */}
          {app.entrances && app.entrances.length > 0 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--embed-border)" }}>
              <div style={{ fontSize: 11, color: "var(--embed-text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 500 }}>
                Access Points
              </div>
              {app.entrances.map((e, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 4 }}>
                  <span style={{ fontWeight: 500 }}>{e.name}</span>
                  {e.path && <span className="embed-muted">{e.path}</span>}
                  {e.authLevel && (
                    <span className="embed-badge" style={{ fontSize: 10 }}>{e.authLevel}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Screenshot Lightbox */}
        {lightboxIndex !== null && screenshots[lightboxIndex] && (
          <div
            onClick={() => setLightboxIndex(null)}
            style={{
              position: "fixed", inset: 0, zIndex: 200,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)",
            }}
          >
            <div onClick={e => e.stopPropagation()} style={{ position: "relative", maxWidth: "90vw", maxHeight: "90vh" }}>
              {lightboxIndex > 0 && (
                <button onClick={() => setLightboxIndex(lightboxIndex - 1)} style={{
                  position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", zIndex: 10,
                  padding: 8, borderRadius: "50%", background: "rgba(0,0,0,0.5)", color: "white",
                  border: "none", cursor: "pointer",
                }}>
                  <ChevronLeftIcon />
                </button>
              )}
              {lightboxIndex < screenshots.length - 1 && (
                <button onClick={() => setLightboxIndex(lightboxIndex + 1)} style={{
                  position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", zIndex: 10,
                  padding: 8, borderRadius: "50%", background: "rgba(0,0,0,0.5)", color: "white",
                  border: "none", cursor: "pointer",
                }}>
                  <ChevronRightIcon />
                </button>
              )}
              <img
                src={screenshots[lightboxIndex].url}
                alt={screenshots[lightboxIndex].caption || `Screenshot ${lightboxIndex + 1}`}
                style={{ maxHeight: "85vh", width: "auto", objectFit: "contain", borderRadius: 8 }}
              />
              {screenshots[lightboxIndex].caption && (
                <p style={{ textAlign: "center", fontSize: 13, color: "rgba(255,255,255,0.8)", marginTop: 10 }}>
                  {screenshots[lightboxIndex].caption}
                </p>
              )}
              <p style={{ textAlign: "center", fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 4 }}>
                {lightboxIndex + 1} / {screenshots.length}
              </p>
            </div>
          </div>
        )}

        {/* Install / Uninstall dialogs rendered below */}
        {renderInstallDialog()}
        {renderUninstallDialog()}
      </div>
    );
  }

  // ─── Catalog View ───────────────────────────────────────

  function renderCategorySection(label: string, apps: MarketApp[]) {
    if (!apps.length) return null;
    return (
      <div style={{ marginBottom: 20 }} key={label}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: "var(--embed-text-muted)",
          textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8,
        }}>
          {label}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10 }}>
          {apps.map(app => (
            <AppCard key={app.id} app={app} onSelect={setSelectedApp} onInstall={openInstallForm} onUninstall={setUninstallTarget} isInstalling={activeInstalls.some(i => i.appId === app.id)} />
          ))}
        </div>
      </div>
    );
  }

  function renderInstallDialog() {
    if (!installTarget) return null;
    return (
      <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)", zIndex: 100 }}
        onClick={() => setInstallTarget(null)}>
        <div className="embed-card" style={{ maxWidth: 480, width: "90%", maxHeight: "80vh", overflow: "auto" }}
          onClick={e => e.stopPropagation()}>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
            Install {installTarget.name}
          </div>
          <div className="embed-muted" style={{ fontSize: 12, marginBottom: 16 }}>
            {installTarget.description}
          </div>

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

          {/* F1: Validation report */}
          {validating && (
            <div style={{ fontSize: 11, color: "var(--embed-muted-text)", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 10, height: 10, border: "2px solid var(--embed-primary)", borderTopColor: "transparent", borderRadius: "50%", animation: "embed-spin 0.8s linear infinite", display: "inline-block" }} />
              Validating manifest...
            </div>
          )}
          {validationReport && !validating && (
            <details style={{ marginBottom: 12, border: `1px solid ${validationReport.errors.length > 0 ? "var(--embed-danger)" : validationReport.warnings.length > 0 ? "var(--embed-warning, #f59e0b)" : "var(--embed-success)"}`, borderRadius: 6, overflow: "hidden" }}
              open={validationReport.errors.length > 0}>
              <summary style={{ cursor: "pointer", padding: "6px 8px", fontSize: 11, fontWeight: 500, display: "flex", alignItems: "center", gap: 6,
                color: validationReport.errors.length > 0 ? "var(--embed-danger)" : validationReport.warnings.length > 0 ? "var(--embed-warning, #f59e0b)" : "var(--embed-success)",
                background: validationReport.errors.length > 0 ? "rgba(239,68,68,0.06)" : validationReport.warnings.length > 0 ? "rgba(245,158,11,0.06)" : "rgba(34,197,94,0.06)" }}>
                <span>{validationReport.errors.length > 0 ? "\u2717" : validationReport.warnings.length > 0 ? "\u26a0" : "\u2713"}</span>
                {validationReport.errors.length > 0
                  ? `${validationReport.errors.length} issue${validationReport.errors.length > 1 ? "s" : ""} found`
                  : validationReport.warnings.length > 0
                    ? `Manifest OK — ${validationReport.warnings.length} warning${validationReport.warnings.length > 1 ? "s" : ""}`
                    : "Manifest verified"}
              </summary>
              <div style={{ padding: "4px 8px", fontSize: 11 }}>
                {[...validationReport.errors, ...validationReport.warnings, ...validationReport.info].map((item, i) => (
                  <div key={i} style={{ padding: "3px 0", display: "flex", alignItems: "flex-start", gap: 6, color: item.severity === "error" ? "var(--embed-danger)" : item.severity === "warning" ? "var(--embed-warning, #f59e0b)" : "var(--embed-muted-text)" }}>
                    <span style={{ flexShrink: 0 }}>{item.severity === "error" ? "\u2717" : item.severity === "warning" ? "\u26a0" : "\u2139"}</span>
                    <div>
                      <div>{item.message}</div>
                      {item.detail && <div style={{ fontSize: 10, color: "var(--embed-muted-text)", marginTop: 2 }}>{item.detail}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}


          {/* Connections */}
          {connections && connections.outgoing.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
                <Link2Icon size={14} />
                Connections
              </div>
              <div className="embed-muted" style={{ fontSize: 11, marginBottom: 8 }}>
                This app can connect to the following apps. Toggle to allow or deny.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {connections.outgoing.map(c => (
                  <div key={c.targetAppId} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "8px 10px", borderRadius: 6,
                    border: "1px solid var(--embed-border)",
                    background: "var(--embed-bg)",
                  }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{c.targetAppName}</div>
                      <div className="embed-muted" style={{ fontSize: 11 }}>
                        {c.description || `Connect to ${c.targetAppName}`}
                        {!c.installed && (
                          <span style={{ marginLeft: 6, color: "var(--embed-warning, #b8860b)" }}>
                            (not installed)
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setConnectionToggles(prev => ({ ...prev, [c.targetAppId]: !prev[c.targetAppId] }))}
                      style={{
                        position: "relative", width: 36, height: 20, borderRadius: 10, border: "none", cursor: "pointer",
                        background: connectionToggles[c.targetAppId] ? "var(--embed-primary, #3b82f6)" : "var(--embed-border, #555)",
                        transition: "background 0.2s",
                        flexShrink: 0,
                      }}>
                      <span style={{
                        position: "absolute", top: 2, left: connectionToggles[c.targetAppId] ? 18 : 2,
                        width: 16, height: 16, borderRadius: "50%", background: "#fff",
                        transition: "left 0.2s", boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                      }} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Internet / LAN Access */}
          <div style={{ marginBottom: 12 }}>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "8px 10px", borderRadius: 6,
              border: "1px solid var(--embed-border)",
              background: "var(--embed-bg)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <GlobeIcon size={16} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>Allow Internet &amp; LAN Access</div>
                  <div className="embed-muted" style={{ fontSize: 11 }}>
                    {connections?.internet?.hosts?.length
                      ? `Uses: ${connections.internet.hosts.join(", ")}`
                      : "Allow this app to make outbound network requests"}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setAllowInternet(prev => !prev)}
                style={{
                  position: "relative", width: 36, height: 20, borderRadius: 10, border: "none", cursor: "pointer",
                  background: allowInternet ? "var(--embed-primary, #3b82f6)" : "var(--embed-border, #555)",
                  transition: "background 0.2s",
                  flexShrink: 0,
                }}>
                <span style={{
                  position: "absolute", top: 2, left: allowInternet ? 18 : 2,
                  width: 16, height: 16, borderRadius: "50%", background: "#fff",
                  transition: "left 0.2s", boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                }} />
              </button>
            </div>
          </div>

          {(installTarget.supportsSSO || installTarget.sso !== false) && (
            <div className="embed-badge-green" style={{ marginBottom: 12, display: "inline-block", fontSize: 11 }}>
              SSO enabled automatically
            </div>
          )}

          {installError && (
            <div style={{ fontSize: 12, color: "var(--embed-danger)", marginBottom: 8 }}>{installError}</div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <button className="embed-btn" onClick={() => setInstallTarget(null)}>Cancel</button>
            <button className="embed-btn" onClick={handleInstall}
              disabled={!installForm.subdomain}
              style={{ borderColor: "var(--embed-primary)", color: "var(--embed-primary)" }}>
              Install
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderUninstallDialog() {
    if (!uninstallTarget) return null;
    return (
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
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, marginBottom: 8, color: "var(--embed-primary)" }}>
            <span style={{ width: 14, height: 14, border: "2px solid var(--embed-primary)", borderTopColor: "transparent", borderRadius: "50%", animation: "embed-spin 0.8s linear infinite", display: "inline-block" }} />
            Installing ({activeInstalls.length})
          </div>
          {activeInstalls.map(inst => {
            const last = inst.events[inst.events.length - 1];
            const pct = last ? Math.round((last.step / Math.max(last.totalSteps, 1)) * 100) : 0;
            const hasError = inst.events.some((e: InstallProgress) => e.status === 'error');
            const hasWarning = inst.events.some((e: InstallProgress) => e.status === 'warning');
            const barColor = hasError ? "var(--embed-danger)" : hasWarning ? "var(--embed-warning, #f59e0b)" : "var(--embed-primary)";
            return (
              <div key={inst.appId} style={{ fontSize: 12, marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
                  <span style={{ fontWeight: 500 }}>{inst.appName}</span>
                  <span className="embed-muted" style={{ fontSize: 11 }}>{pct}%</span>
                </div>
                <span className="embed-muted" style={{ fontSize: 11 }}>{last?.message || "Starting..."}</span>
                <div className="embed-progress-track" style={{ marginTop: 4 }}>
                  <div className="embed-progress-bar" style={{ width: `${pct}%`, background: barColor }} />
                </div>
                {/* Render error/warning events with context */}
                {inst.events.filter((e: InstallProgress) => e.status === 'error' || e.status === 'warning').map((ev: InstallProgress, i: number) => {
                  const ec = ev.errorContext;
                  const isError = ev.status === 'error';
                  const borderCol = isError ? "var(--embed-danger)" : "var(--embed-warning, #f59e0b)";
                  const bgCol = isError ? "rgba(239,68,68,0.08)" : "rgba(245,158,11,0.08)";
                  return (
                    <details key={i} style={{ marginTop: 6, border: `1px solid ${borderCol}`, borderRadius: 6, background: bgCol, overflow: "hidden" }}>
                      <summary style={{ cursor: "pointer", padding: "6px 8px", fontSize: 11, fontWeight: 500, color: borderCol, display: "flex", alignItems: "center", gap: 6 }}>
                        <span>{isError ? "\u2717" : "\u26a0"}</span>
                        <span style={{ flex: 1 }}>{ev.message}</span>
                        {ec?.statusCode && (
                          <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: borderCol, color: "#fff" }}>{ec.statusCode}</span>
                        )}
                      </summary>
                      {ec && (
                        <div style={{ padding: "6px 8px", fontSize: 11, borderTop: `1px solid ${borderCol}` }}>
                          {ec.method && ec.url && (
                            <div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--embed-muted-text)", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={ec.url}>
                              {ec.method} {ec.url}
                            </div>
                          )}
                          {ec.responseBody && (
                            <pre style={{ margin: "4px 0", padding: 6, background: "rgba(0,0,0,0.06)", borderRadius: 4, fontSize: 10, maxHeight: 100, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{ec.responseBody}</pre>
                          )}
                          {ec.suggestion && (
                            <div style={{ marginTop: 4, padding: "4px 8px", background: "rgba(59,130,246,0.1)", borderRadius: 4, color: "var(--embed-text)", fontSize: 11 }}>
                              {"\ud83d\udca1"} {ec.suggestion}
                            </div>
                          )}
                        </div>
                      )}
                    </details>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* Recently completed installs */}
      {completedInstalls.length > 0 && apps.filter(a => completedInstalls.includes(a.id)).map(app => (
        <div key={app.id} className="embed-card" style={{ marginBottom: 16, borderColor: "var(--embed-success)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--embed-success)" }}>
            <span>{"\u2713"}</span>
            <span style={{ fontWeight: 500 }}>{app.name}</span> installed successfully
          </div>
        </div>
      ))}

      {/* Built for YouEye — native apps */}
      {nativeApps.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            fontSize: 12, fontWeight: 600, color: "var(--embed-text-muted)",
            textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12,
          }}>
            <ShieldIcon size={14} />
            Built for YouEye ({nativeApps.length})
          </div>
          {[...CATEGORY_ORDER, ...Object.keys(nativeGrouped).filter(c => !CATEGORY_ORDER.includes(c))].map(cat => {
            const catApps = nativeGrouped[cat];
            if (!catApps?.length) return null;
            return (
              <div key={cat} style={{ marginBottom: 14 }}>
                <div style={{
                  fontSize: 10, fontWeight: 500, color: "var(--embed-text-muted)",
                  textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, opacity: 0.7,
                }}>
                  {CATEGORY_LABELS[cat] || cat}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10 }}>
                  {catApps.map(app => (
                    <AppCard key={app.id} app={app} onSelect={setSelectedApp} onInstall={openInstallForm} onUninstall={setUninstallTarget} isInstalling={activeInstalls.some(i => i.appId === app.id)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Installed marketplace apps */}
      {installedMarketplace.length > 0 && renderCategorySection(`Installed (${installedMarketplace.length})`, installedMarketplace)}

      {/* Available marketplace apps by category */}
      {availableMarketplace.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{
            fontSize: 12, fontWeight: 600, color: "var(--embed-text-muted)",
            textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12,
          }}>
            Available ({availableMarketplace.length})
          </div>
          {[...CATEGORY_ORDER, ...Object.keys(availableGrouped).filter(c => !CATEGORY_ORDER.includes(c))].map(cat => {
            const catApps = availableGrouped[cat];
            if (!catApps?.length) return null;
            return (
              <div key={cat} style={{ marginBottom: 14 }}>
                <div style={{
                  fontSize: 10, fontWeight: 500, color: "var(--embed-text-muted)",
                  textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, opacity: 0.7,
                }}>
                  {CATEGORY_LABELS[cat] || cat}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10 }}>
                  {catApps.map(app => (
                    <AppCard key={app.id} app={app} onSelect={setSelectedApp} onInstall={openInstallForm} onUninstall={setUninstallTarget} isInstalling={activeInstalls.some(i => i.appId === app.id)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {filtered.length === 0 && (
        <div className="embed-card" style={{ textAlign: "center", padding: 32 }}>
          <div className="embed-muted">No apps found</div>
        </div>
      )}

      {renderInstallDialog()}
      {renderUninstallDialog()}
    </div>
  );
}

// ─── App Card Component ───────────────────────────────────

function AppCard({ app, onSelect, onInstall, onUninstall, isInstalling }: {
  app: MarketApp;
  onSelect: (app: MarketApp) => void;
  onInstall: (app: MarketApp) => void;
  onUninstall: (app: MarketApp) => void;
  isInstalling?: boolean;
}) {
  const isNative = app.integration === "native";

  return (
    <div
      className="embed-card"
      onClick={() => onSelect(app)}
      style={{ display: "flex", flexDirection: "column", gap: 8, cursor: "pointer", transition: "border-color 0.15s" }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = "var(--embed-primary)")}
      onMouseLeave={e => (e.currentTarget.style.borderColor = "var(--embed-border)")}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {/* Icon */}
        <div style={{
          width: 40, height: 40, borderRadius: 10, flexShrink: 0,
          background: "color-mix(in srgb, var(--embed-primary) 10%, transparent)",
          display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
        }}>
          {app.iconUrl ? (
            <img src={app.iconUrl} alt="" style={{ width: 24, height: 24, objectFit: "contain" }} />
          ) : (
            <span style={{ fontSize: 16, fontWeight: 700, color: "var(--embed-primary)" }}>
              {app.name.charAt(0)}
            </span>
          )}
        </div>

        {/* Name + type badge */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>{app.name}</span>
            {isNative && (
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 500,
                padding: "1px 6px", borderRadius: 9999,
                background: "color-mix(in srgb, var(--embed-primary) 12%, transparent)",
                color: "var(--embed-primary)",
              }}>
                <ShieldIcon size={9} /> YouEye
              </span>
            )}
            {app.version && <span className="embed-muted" style={{ fontSize: 11 }}>v{app.version}</span>}
          </div>
          <div className="embed-muted" style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {app.description}
          </div>
        </div>
      </div>

      {/* Tags row */}
      {app.tags && app.tags.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {app.tags.slice(0, 4).map(tag => (
            <span key={tag} style={{
              fontSize: 10, padding: "2px 8px", borderRadius: 9999,
              background: "var(--embed-hover)", color: "var(--embed-text-muted)",
            }}>
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Footer: badges + action */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "auto" }}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <span className="embed-badge" style={{ fontSize: 10 }}>{app.category}</span>
          {(app.supportsSSO || app.sso !== false) && <span className="embed-badge-green" style={{ fontSize: 10 }}>SSO</span>}
        </div>
        <div onClick={e => e.stopPropagation()}>
          {app.installed ? (
            <button className="embed-btn" onClick={() => onUninstall(app)}
              style={{ padding: "3px 10px", fontSize: 11, borderColor: "var(--embed-danger)", color: "var(--embed-danger)" }}>
              Uninstall
            </button>
          ) : isInstalling ? (
            <span className="embed-badge" style={{ fontSize: 10, color: "var(--embed-primary)", borderColor: "color-mix(in srgb, var(--embed-primary) 30%, transparent)" }}>
              Installing...
            </span>
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
