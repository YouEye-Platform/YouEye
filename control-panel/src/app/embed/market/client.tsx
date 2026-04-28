"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";

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
  source?: string;
  sourceUrl?: string;
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

// ─── Icon Map (Lucide-style SVG icons for native apps) ────

const ICON_SVGS: Record<string, (size: number) => React.ReactElement> = {
  "book-open": (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  ),
  search: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  "sticky-note": (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z" /><path d="M14 3v4a2 2 0 0 0 2 2h4" />
    </svg>
  ),
  film: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" /><line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" /><line x1="2" y1="12" x2="22" y2="12" /><line x1="2" y1="7" x2="7" y2="7" /><line x1="2" y1="17" x2="7" y2="17" /><line x1="17" y1="7" x2="22" y2="7" /><line x1="17" y1="17" x2="22" y2="17" />
    </svg>
  ),
  "cloud-sun": (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="M20 12h2" /><path d="m19.07 4.93-1.41 1.41" /><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128" /><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z" />
    </svg>
  ),
  languages: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="m22 22-5-10-5 10" /><path d="M14 18h6" />
    </svg>
  ),
  cloud: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  ),
  globe: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z" />
    </svg>
  ),
  shield: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  package: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="m7.5 4.27 9 5.15" /><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" />
    </svg>
  ),
};

function renderIcon(icon: string | undefined, size: number) {
  if (!icon) return null;
  const renderer = ICON_SVGS[icon];
  if (renderer) return renderer(size);
  // Try as emoji/unicode char
  if (icon.length <= 4) return <span style={{ fontSize: size * 0.7 }}>{icon}</span>;
  // Unknown icon name — show first letter
  return <span style={{ fontSize: size * 0.5, fontWeight: 700 }}>{icon.charAt(0).toUpperCase()}</span>;
}

// ─── Small SVG Icons ──────────────────────────────────────

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

function PlusIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function SearchIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function RefreshIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

function LinkIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 17H7A5 5 0 0 1 7 7h2" /><path d="M15 7h2a5 5 0 1 1 0 10h-2" /><line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}

// ─── App Icon Component ──────────────────────────────────

function AppIcon({ app, size = 48 }: { app: MarketApp; size?: number }) {
  const borderRadius = size > 40 ? 16 : 12;
  return (
    <div style={{
      width: size, height: size, borderRadius, flexShrink: 0,
      background: "color-mix(in srgb, var(--embed-primary) 8%, var(--embed-card-bg))",
      display: "flex", alignItems: "center", justifyContent: "center",
      overflow: "hidden", border: "1px solid color-mix(in srgb, var(--embed-border) 50%, transparent)",
    }}>
      {app.iconUrl ? (
        <img src={app.iconUrl} alt="" style={{ width: size * 0.65, height: size * 0.65, objectFit: "contain" }} />
      ) : app.icon ? (
        <span style={{ color: "var(--embed-primary)" }}>{renderIcon(app.icon, size * 0.5)}</span>
      ) : (
        <span style={{ fontSize: size * 0.35, fontWeight: 700, color: "var(--embed-primary)" }}>
          {app.name.charAt(0)}
        </span>
      )}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────

export function MarketEmbedClient() {
  const [apps, setApps] = useState<MarketApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [domain, setDomain] = useState("");
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>("all");

  // Detail view
  const [selectedApp, setSelectedApp] = useState<MarketApp | null>(null);

  // Install state
  const [installTarget, setInstallTarget] = useState<MarketApp | null>(null);
  const [installForm, setInstallForm] = useState<{ subdomain: string; params: Record<string, string> }>({ subdomain: "", params: {} });
  const [installError, setInstallError] = useState<string | null>(null);

  // Validation state
  const [validationReport, setValidationReport] = useState<{ valid: boolean; errors: { check: string; severity: string; message: string; detail?: string }[]; warnings: { check: string; severity: string; message: string; detail?: string }[]; info: { check: string; severity: string; message: string; detail?: string }[] } | null>(null);
  const [validating, setValidating] = useState(false);

  // Connection toggles
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

  // Custom URL install
  const [showCustomUrl, setShowCustomUrl] = useState(false);
  const [customUrl, setCustomUrl] = useState("");
  const [customFetching, setCustomFetching] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);

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
    } catch { /* non-blocking */ }
  };

  const handleInstall = async () => {
    if (!installTarget || !domain) return;
    const target = installTarget;
    const form = { ...installForm };
    setInstallTarget(null);
    setInstallError(null);

    window.parent.postMessage({ type: "youeye-app-install-started", appId: target.id, appName: target.name }, "*");
    prevActiveRef.current.add(target.id);

    const approvedConnections = connections?.outgoing?.map(c => ({
      targetAppId: c.targetAppId,
      approved: connectionToggles[c.targetAppId] ?? false,
    })) ?? [];

    try {
      const res = await fetch("/api/ui-bridge/market?action=install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: target.id, subdomain: form.subdomain, domain, enableSSO: true,
          installParams: Object.keys(form.params).length > 0 ? form.params : undefined,
          approvedConnections: approvedConnections.length > 0 ? approvedConnections : undefined,
          allowInternet,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Install failed" }));
        window.parent.postMessage({ type: "youeye-app-install-complete", appId: target.id, appName: target.name, error: err.error || "Install failed" }, "*");
        prevActiveRef.current.delete(target.id);
        return;
      }

      if (!pollRef.current) pollRef.current = setInterval(pollActiveInstalls, 2000);

      const reader = res.body?.getReader();
      if (reader) {
        (async () => {
          try { while (true) { const { done } = await reader.read(); if (done) break; } } catch { /* stream ended */ }
          fetchCatalog();
        })();
      }
    } catch (err) {
      window.parent.postMessage({ type: "youeye-app-install-complete", appId: target.id, appName: target.name, error: err instanceof Error ? err.message : "Install failed" }, "*");
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
      setSelectedApp(null);
    }
  };

  // Custom URL install
  const handleCustomUrlFetch = async () => {
    if (!customUrl.trim()) return;
    setCustomFetching(true);
    setCustomError(null);
    try {
      // Construct manifest URL from repo URL
      let manifestUrl = customUrl.trim();
      if (!manifestUrl.includes("youeye-app.yaml") && !manifestUrl.includes(".yaml") && !manifestUrl.includes(".yml")) {
        // Assume it's a repo URL — construct manifest path
        const cleanUrl = manifestUrl.replace(/\/$/, "");
        manifestUrl = cleanUrl.includes("raw/branch")
          ? cleanUrl
          : `${cleanUrl}/raw/branch/main/youeye-app.yaml`;
      }

      const res = await fetch("/api/market/validate-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifestUrl }),
      });
      const data = await res.json();
      if (!data.valid) {
        setCustomError(data.errors?.join(", ") || "Invalid manifest");
        return;
      }

      // Go straight to install — set up the app as install target
      const app: MarketApp = {
        ...data.manifest,
        installed: false,
        source: "url",
        sourceUrl: manifestUrl,
      };
      setShowCustomUrl(false);
      setCustomUrl("");
      setSelectedApp(app);
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : "Failed to fetch manifest");
    } finally {
      setCustomFetching(false);
    }
  };

  // ─── Filter & Group ───────────────────────────────────

  const filtered = apps.filter(a => {
    if (search) {
      const q = search.toLowerCase();
      const matches = a.name.toLowerCase().includes(q)
        || a.description.toLowerCase().includes(q)
        || a.category.toLowerCase().includes(q)
        || (a.tags || []).some(t => t.toLowerCase().includes(q));
      if (!matches) return false;
    }
    if (activeCategory !== "all") {
      return a.category === activeCategory;
    }
    return true;
  });

  // Derive dynamic categories from catalog data
  const allCategories = Array.from(new Set(apps.map(a => a.category).filter(Boolean))).sort();

  const nativeApps = filtered.filter(a => a.integration === "native" || a.type === "native");
  const marketplaceApps = filtered.filter(a => a.integration !== "native" && a.type !== "native");
  const installedApps = filtered.filter(a => a.installed);
  const availableApps = filtered.filter(a => !a.installed);

  // ─── Loading ──────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ padding: "32px 40px" }}>
        <div className="embed-skeleton" style={{ height: 28, width: 200, marginBottom: 8 }} />
        <div className="embed-skeleton" style={{ height: 16, width: 300, marginBottom: 32 }} />
        <div className="embed-skeleton" style={{ height: 44, width: "100%", marginBottom: 24, borderRadius: 12 }} />
        <div style={{ display: "flex", gap: 8, marginBottom: 32 }}>
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="embed-skeleton" style={{ height: 34, width: 90, borderRadius: 17 }} />
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
          {[1, 2, 3, 4, 5, 6].map(i => (
            <div key={i} className="embed-skeleton" style={{ height: 80, borderRadius: 14 }} />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: "32px 40px", textAlign: "center" }}>
        <div style={{ color: "var(--embed-danger)", marginBottom: 12, fontSize: 15 }}>{error}</div>
        <button className="embed-btn" onClick={() => { setLoading(true); fetchCatalog(); }}>Retry</button>
      </div>
    );
  }

  // ─── Render App Detail Page ────────────────────────────

  if (selectedApp) {
    const app = selectedApp;
    const isNative = app.integration === "native";
    const longDesc = app.detail?.longDescription || app.description;
    const screenshots = app.detail?.screenshots || [];
    const sameCategoryApps = apps.filter(a => a.category === app.category && a.id !== app.id).slice(0, 6);

    return (
      <div style={{ padding: "24px 40px", maxWidth: 960, margin: "0 auto" }}>
        {/* Back */}
        <button
          onClick={() => { setSelectedApp(null); setLightboxIndex(null); }}
          style={{
            display: "flex", alignItems: "center", gap: 6, fontSize: 13,
            color: "var(--embed-text-muted)", background: "none", border: "none",
            cursor: "pointer", marginBottom: 20, padding: 0,
          }}
        >
          <ArrowLeftIcon size={16} />
          Back to App Market
        </button>

        {/* Hero Card */}
        <div style={{
          background: "var(--embed-card-bg)", border: "1px solid var(--embed-border)",
          borderRadius: 16, padding: 28, marginBottom: 20,
        }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 20 }}>
            <AppIcon app={app} size={80} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
                <span style={{ fontSize: 24, fontWeight: 700 }}>{app.name}</span>
                {app.version && <span className="embed-badge" style={{ fontSize: 11 }}>v{app.version}</span>}
                {isNative ? (
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600,
                    padding: "3px 10px", borderRadius: 9999,
                    background: "color-mix(in srgb, var(--embed-primary) 12%, transparent)",
                    color: "var(--embed-primary)", border: "1px solid color-mix(in srgb, var(--embed-primary) 25%, transparent)",
                  }}>
                    {renderIcon("shield", 12)} YouEye
                  </span>
                ) : app.source === "url" ? (
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600,
                    padding: "3px 10px", borderRadius: 9999,
                    color: "var(--embed-warning)", border: "1px solid color-mix(in srgb, var(--embed-warning) 30%, transparent)",
                  }}>
                    Custom
                  </span>
                ) : (
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 500,
                    padding: "3px 10px", borderRadius: 9999,
                    color: "var(--embed-text-muted)", border: "1px solid var(--embed-border)",
                  }}>
                    {renderIcon("globe", 11)} Community
                  </span>
                )}
              </div>
              <div style={{ fontSize: 14, color: "var(--embed-text-muted)", marginBottom: 8 }}>{app.description}</div>
              <div style={{ fontSize: 12, color: "var(--embed-text-muted)", textTransform: "capitalize", opacity: 0.7 }}>
                {app.category}
                {app.updateAvailable && (
                  <span style={{
                    marginLeft: 12, color: "var(--embed-primary)", fontWeight: 500,
                  }}>
                    Update available: v{app.catalogVersion}
                  </span>
                )}
              </div>

              {app.installed && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600,
                    color: "var(--embed-success)",
                  }}>
                    Installed
                  </span>
                  {app.installedVersion && (
                    <span style={{ fontSize: 11, color: "var(--embed-text-muted)" }}>v{app.installedVersion}</span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            {!app.installed ? (
              activeInstalls.some(i => i.appId === app.id) ? (
                <button className="embed-btn" disabled style={{ padding: "10px 24px", fontSize: 14, opacity: 0.6 }}>
                  Installing...
                </button>
              ) : (
                <button className="embed-btn" onClick={() => openInstallForm(app)} style={{
                  padding: "10px 24px", fontSize: 14, fontWeight: 600,
                  background: "var(--embed-primary)", color: "#fff",
                  border: "1px solid var(--embed-primary)", borderRadius: 10,
                }}>
                  Install {app.name}
                </button>
              )
            ) : (
              <>
                {app.entrances?.[0]?.subdomain && domain && (
                  <button className="embed-btn" onClick={() => window.open(`https://${app.entrances![0].subdomain}.${domain}`, "_blank")} style={{
                    padding: "10px 24px", fontSize: 14, fontWeight: 600,
                    borderColor: "var(--embed-primary)", color: "var(--embed-primary)", borderRadius: 10,
                  }}>
                    <ExternalLinkIcon size={14} /> Open {app.name}
                  </button>
                )}
                <button className="embed-btn" onClick={() => setUninstallTarget(app)} style={{
                  padding: "10px 20px", fontSize: 13,
                  borderColor: "var(--embed-danger)", color: "var(--embed-danger)", borderRadius: 10,
                }}>
                  Uninstall
                </button>
              </>
            )}
          </div>
        </div>

        {/* Description */}
        <div style={{
          background: "var(--embed-card-bg)", border: "1px solid var(--embed-border)",
          borderRadius: 14, padding: 24, marginBottom: 16,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--embed-text-muted)", marginBottom: 12 }}>
            About
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.75, whiteSpace: "pre-line", color: "var(--embed-text)" }}>{longDesc}</div>
        </div>

        {/* Screenshots */}
        {screenshots.length > 0 && (
          <div style={{
            background: "var(--embed-card-bg)", border: "1px solid var(--embed-border)",
            borderRadius: 14, padding: 24, marginBottom: 16,
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--embed-text-muted)", marginBottom: 12 }}>
              Screenshots
            </div>
            <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 4 }}>
              {screenshots.map((shot, i) => (
                <button key={i} onClick={() => setLightboxIndex(i)} style={{
                  flexShrink: 0, border: "1px solid var(--embed-border)", borderRadius: 10,
                  overflow: "hidden", cursor: "pointer", background: "none", padding: 0,
                  transition: "transform 0.15s, box-shadow 0.15s",
                }}
                onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.02)"; e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.15)"; }}
                onMouseLeave={e => { e.currentTarget.style.transform = ""; e.currentTarget.style.boxShadow = ""; }}
                >
                  <img src={shot.url} alt={shot.caption || `Screenshot ${i + 1}`} style={{ height: 180, width: "auto", objectFit: "cover", display: "block" }} />
                  {shot.caption && (
                    <div style={{ fontSize: 11, padding: "8px 10px", color: "var(--embed-text-muted)", background: "var(--embed-hover)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 280 }}>
                      {shot.caption}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Details */}
        <div style={{
          background: "var(--embed-card-bg)", border: "1px solid var(--embed-border)",
          borderRadius: 14, padding: 24, marginBottom: 16,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--embed-text-muted)", marginBottom: 14 }}>
            Details
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 28px" }}>
            <DetailItem icon="shield" label="SSO Support" value={
              (app.supportsSSO || app.sso !== false)
                ? <span style={{ color: "var(--embed-success)" }}>Enabled</span>
                : app.forwardAuth !== "disabled"
                  ? <span style={{ color: "var(--embed-success)" }}>Forward-auth</span>
                  : <span style={{ color: "var(--embed-text-muted)" }}>No</span>
            } />
            {app.website && (
              <DetailItem icon="globe" label="Website" value={
                <a href={app.website} target="_blank" rel="noopener noreferrer" style={{ color: "var(--embed-primary)", textDecoration: "none", display: "flex", alignItems: "center", gap: 4 }}>
                  {(() => { try { return new URL(app.website).hostname; } catch { return app.website; } })()}
                  <ExternalLinkIcon size={11} />
                </a>
              } />
            )}
          </div>

          {/* Tags */}
          {app.tags && app.tags.length > 0 && (
            <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--embed-border)" }}>
              <div style={{ fontSize: 11, color: "var(--embed-text-muted)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
                Tags
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {app.tags.map(tag => (
                  <span key={tag} style={{
                    fontSize: 11, padding: "4px 12px", borderRadius: 9999,
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
            <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--embed-border)" }}>
              <div style={{ fontSize: 11, color: "var(--embed-text-muted)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
                Access Points
              </div>
              {app.entrances.map((e, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 4 }}>
                  <span style={{ fontWeight: 500 }}>{e.name}</span>
                  {e.path && <span style={{ color: "var(--embed-text-muted)" }}>{e.path}</span>}
                  {e.authLevel && <span className="embed-badge" style={{ fontSize: 10 }}>{e.authLevel}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Related Apps */}
        {sameCategoryApps.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--embed-text-muted)", marginBottom: 12, textTransform: "capitalize" }}>
              More in {app.category}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
              {sameCategoryApps.map(a => (
                <AppCard key={a.id} app={a} onSelect={setSelectedApp} />
              ))}
            </div>
          </div>
        )}

        {/* Lightbox */}
        {lightboxIndex !== null && screenshots[lightboxIndex] && (
          <div onClick={() => setLightboxIndex(null)} style={{
            position: "fixed", inset: 0, zIndex: 200,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.8)", backdropFilter: "blur(6px)",
          }}>
            <div onClick={e => e.stopPropagation()} style={{ position: "relative", maxWidth: "90vw", maxHeight: "90vh" }}>
              {lightboxIndex > 0 && (
                <button onClick={() => setLightboxIndex(lightboxIndex - 1)} style={{
                  position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", zIndex: 10,
                  padding: 10, borderRadius: "50%", background: "rgba(0,0,0,0.6)", color: "white",
                  border: "none", cursor: "pointer",
                }}>
                  <ChevronLeftIcon />
                </button>
              )}
              {lightboxIndex < screenshots.length - 1 && (
                <button onClick={() => setLightboxIndex(lightboxIndex + 1)} style={{
                  position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", zIndex: 10,
                  padding: 10, borderRadius: "50%", background: "rgba(0,0,0,0.6)", color: "white",
                  border: "none", cursor: "pointer",
                }}>
                  <ChevronRightIcon />
                </button>
              )}
              <img src={screenshots[lightboxIndex].url} alt={screenshots[lightboxIndex].caption || ""} style={{ maxHeight: "85vh", width: "auto", objectFit: "contain", borderRadius: 12 }} />
              {screenshots[lightboxIndex].caption && (
                <p style={{ textAlign: "center", fontSize: 13, color: "rgba(255,255,255,0.8)", marginTop: 10 }}>{screenshots[lightboxIndex].caption}</p>
              )}
              <p style={{ textAlign: "center", fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 4 }}>{lightboxIndex + 1} / {screenshots.length}</p>
            </div>
          </div>
        )}

        {renderInstallDialog()}
        {renderUninstallDialog()}
      </div>
    );
  }

  // ─── Catalog View ─────────────────────────────────────

  function renderInstallDialog() {
    if (!installTarget) return null;
    return (
      <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)", zIndex: 100 }}
        onClick={() => setInstallTarget(null)}>
        <div style={{
          maxWidth: 500, width: "92%", maxHeight: "80vh", overflow: "auto",
          background: "var(--embed-card-bg)", border: "1px solid var(--embed-border)",
          borderRadius: 16, padding: 24,
        }} onClick={e => e.stopPropagation()}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <AppIcon app={installTarget} size={40} />
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>Install {installTarget.name}</div>
              <div style={{ fontSize: 12, color: "var(--embed-text-muted)" }}>{installTarget.description}</div>
            </div>
          </div>

          {/* Subdomain */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Subdomain</div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="text" value={installForm.subdomain}
                onChange={e => setInstallForm(f => ({ ...f, subdomain: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") }))}
                style={{
                  flex: 1, padding: "8px 12px", fontSize: 13, borderRadius: 8,
                  border: "1px solid var(--embed-border)", background: "var(--embed-bg, var(--embed-card-bg))",
                  color: "var(--embed-text)", outline: "none",
                }} />
              <span style={{ fontSize: 13, color: "var(--embed-text-muted)" }}>.{domain}</span>
            </div>
          </div>

          {/* Install params */}
          {installTarget.installParams?.map(param => (
            <div key={param.name} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                {param.label || param.name}
                {param.required && <span style={{ color: "var(--embed-danger)" }}> *</span>}
              </div>
              {param.description && <div style={{ fontSize: 11, color: "var(--embed-text-muted)", marginBottom: 4 }}>{param.description}</div>}
              {param.choices ? (
                <select value={installForm.params[param.name] || ""} onChange={e => setInstallForm(f => ({ ...f, params: { ...f.params, [param.name]: e.target.value } }))} style={{
                  width: "100%", padding: "8px 12px", fontSize: 13, borderRadius: 8,
                  border: "1px solid var(--embed-border)", background: "var(--embed-bg, var(--embed-card-bg))",
                  color: "var(--embed-text)", outline: "none",
                }}>
                  <option value="">Select...</option>
                  {param.choices.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <input type={param.type === "number" ? "number" : "text"} value={installForm.params[param.name] || ""} onChange={e => setInstallForm(f => ({ ...f, params: { ...f.params, [param.name]: e.target.value } }))} placeholder={param.default || ""} style={{
                  width: "100%", padding: "8px 12px", fontSize: 13, borderRadius: 8,
                  border: "1px solid var(--embed-border)", background: "var(--embed-bg, var(--embed-card-bg))",
                  color: "var(--embed-text)", outline: "none",
                }} />
              )}
            </div>
          ))}

          {/* Validation */}
          {validating && (
            <div style={{ fontSize: 11, color: "var(--embed-text-muted)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 12, height: 12, border: "2px solid var(--embed-primary)", borderTopColor: "transparent", borderRadius: "50%", animation: "embed-spin 0.8s linear infinite", display: "inline-block" }} />
              Validating manifest...
            </div>
          )}
          {validationReport && !validating && (
            <details style={{ marginBottom: 14, border: `1px solid ${validationReport.errors.length > 0 ? "var(--embed-danger)" : validationReport.warnings.length > 0 ? "var(--embed-warning)" : "var(--embed-success)"}`, borderRadius: 8, overflow: "hidden" }}
              open={validationReport.errors.length > 0}>
              <summary style={{ cursor: "pointer", padding: "8px 10px", fontSize: 12, fontWeight: 500, display: "flex", alignItems: "center", gap: 6,
                color: validationReport.errors.length > 0 ? "var(--embed-danger)" : validationReport.warnings.length > 0 ? "var(--embed-warning)" : "var(--embed-success)",
                background: validationReport.errors.length > 0 ? "rgba(239,68,68,0.06)" : validationReport.warnings.length > 0 ? "rgba(245,158,11,0.06)" : "rgba(34,197,94,0.06)" }}>
                <span>{validationReport.errors.length > 0 ? "\u2717" : validationReport.warnings.length > 0 ? "\u26a0" : "\u2713"}</span>
                {validationReport.errors.length > 0 ? `${validationReport.errors.length} issue${validationReport.errors.length > 1 ? "s" : ""} found`
                  : validationReport.warnings.length > 0 ? `Manifest OK \u2014 ${validationReport.warnings.length} warning${validationReport.warnings.length > 1 ? "s" : ""}`
                  : "Manifest verified"}
              </summary>
              <div style={{ padding: "6px 10px", fontSize: 11 }}>
                {[...validationReport.errors, ...validationReport.warnings, ...validationReport.info].map((item, i) => (
                  <div key={i} style={{ padding: "3px 0", display: "flex", alignItems: "flex-start", gap: 6, color: item.severity === "error" ? "var(--embed-danger)" : item.severity === "warning" ? "var(--embed-warning)" : "var(--embed-text-muted)" }}>
                    <span style={{ flexShrink: 0 }}>{item.severity === "error" ? "\u2717" : item.severity === "warning" ? "\u26a0" : "\u2139"}</span>
                    <div>
                      <div>{item.message}</div>
                      {item.detail && <div style={{ fontSize: 10, color: "var(--embed-text-muted)", marginTop: 2 }}>{item.detail}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Connections */}
          {connections && connections.outgoing.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
                <LinkIcon size={14} /> Connections
              </div>
              <div style={{ fontSize: 11, color: "var(--embed-text-muted)", marginBottom: 8 }}>Toggle to allow or deny app connections.</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {connections.outgoing.map(c => (
                  <div key={c.targetAppId} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "8px 12px", borderRadius: 8, border: "1px solid var(--embed-border)",
                  }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{c.targetAppName}</div>
                      <div style={{ fontSize: 11, color: "var(--embed-text-muted)" }}>
                        {c.description || `Connect to ${c.targetAppName}`}
                        {!c.installed && <span style={{ marginLeft: 6, color: "var(--embed-warning)" }}>(not installed)</span>}
                      </div>
                    </div>
                    <ToggleSwitch on={connectionToggles[c.targetAppId] ?? false} onChange={v => setConnectionToggles(prev => ({ ...prev, [c.targetAppId]: v }))} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Internet */}
          <div style={{ marginBottom: 14 }}>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "8px 12px", borderRadius: 8, border: "1px solid var(--embed-border)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {renderIcon("globe", 16)}
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>Internet &amp; LAN Access</div>
                  <div style={{ fontSize: 11, color: "var(--embed-text-muted)" }}>
                    {connections?.internet?.hosts?.length ? `Uses: ${connections.internet.hosts.join(", ")}` : "Allow outbound network requests"}
                  </div>
                </div>
              </div>
              <ToggleSwitch on={allowInternet} onChange={setAllowInternet} />
            </div>
          </div>

          {(installTarget.supportsSSO || installTarget.sso !== false) && (
            <div style={{ marginBottom: 14, display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 500, padding: "4px 10px", borderRadius: 9999, color: "var(--embed-success)", border: "1px solid color-mix(in srgb, var(--embed-success) 30%, transparent)" }}>
              SSO enabled automatically
            </div>
          )}

          {installError && <div style={{ fontSize: 12, color: "var(--embed-danger)", marginBottom: 8 }}>{installError}</div>}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
            <button className="embed-btn" onClick={() => setInstallTarget(null)} style={{ borderRadius: 8, padding: "8px 16px" }}>Cancel</button>
            <button className="embed-btn" onClick={handleInstall} disabled={!installForm.subdomain} style={{
              borderRadius: 8, padding: "8px 20px", fontWeight: 600,
              background: "var(--embed-primary)", color: "#fff", border: "1px solid var(--embed-primary)",
            }}>
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
      <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)", zIndex: 100 }}
        onClick={() => { if (!uninstalling) setUninstallTarget(null); }}>
        <div style={{
          maxWidth: 420, width: "92%",
          background: "var(--embed-card-bg)", border: "1px solid var(--embed-border)",
          borderRadius: 16, padding: 24,
        }} onClick={e => e.stopPropagation()}>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Uninstall {uninstallTarget.name}?</div>
          <div style={{ fontSize: 13, color: "var(--embed-text-muted)", marginBottom: 6 }}>
            This will remove the container, Caddy route, and SSO configuration.
          </div>
          <div style={{
            padding: "10px 14px", borderRadius: 8, fontSize: 12, marginBottom: 16,
            background: "color-mix(in srgb, var(--embed-danger) 8%, transparent)",
            border: "1px solid color-mix(in srgb, var(--embed-danger) 25%, transparent)",
            color: "var(--embed-danger)",
          }}>
            This action cannot be undone. App data will be permanently deleted.
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="embed-btn" onClick={() => setUninstallTarget(null)} disabled={uninstalling} style={{ borderRadius: 8, padding: "8px 16px" }}>Cancel</button>
            <button className="embed-btn" onClick={handleUninstall} disabled={uninstalling} style={{
              borderRadius: 8, padding: "8px 20px", fontWeight: 600,
              background: "var(--embed-danger)", color: "#fff", border: "1px solid var(--embed-danger)",
            }}>
              {uninstalling ? "Uninstalling..." : "Uninstall"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderCustomUrlDialog() {
    if (!showCustomUrl) return null;
    return (
      <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)", zIndex: 100 }}
        onClick={() => { if (!customFetching) { setShowCustomUrl(false); setCustomError(null); } }}>
        <div style={{
          maxWidth: 520, width: "92%",
          background: "var(--embed-card-bg)", border: "1px solid var(--embed-border)",
          borderRadius: 16, padding: 24,
        }} onClick={e => e.stopPropagation()}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <span style={{ color: "var(--embed-primary)" }}>{renderIcon("globe", 20)}</span>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Add Custom App</div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Repository or Manifest URL</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="text" value={customUrl} onChange={e => setCustomUrl(e.target.value)} placeholder="https://git.example.com/org/app"
                onKeyDown={e => { if (e.key === "Enter" && customUrl.trim()) handleCustomUrlFetch(); }}
                disabled={customFetching} style={{
                  flex: 1, padding: "8px 12px", fontSize: 13, borderRadius: 8,
                  border: "1px solid var(--embed-border)", background: "var(--embed-bg, var(--embed-card-bg))",
                  color: "var(--embed-text)", outline: "none",
                }} />
              <button className="embed-btn" onClick={handleCustomUrlFetch} disabled={customFetching || !customUrl.trim()} style={{
                borderRadius: 8, padding: "8px 16px", fontWeight: 600,
                borderColor: "var(--embed-primary)", color: "var(--embed-primary)",
              }}>
                {customFetching ? (
                  <span style={{ width: 14, height: 14, border: "2px solid var(--embed-primary)", borderTopColor: "transparent", borderRadius: "50%", animation: "embed-spin 0.8s linear infinite", display: "inline-block" }} />
                ) : "Fetch"}
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--embed-text-muted)", marginTop: 6 }}>
              Paste a Gitea repo URL or direct link to a youeye-app.yaml manifest. The app will be fetched, validated, and available for install.
            </div>
          </div>

          {/* Security notice */}
          <div style={{
            display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 12px",
            borderRadius: 8, fontSize: 12,
            background: "color-mix(in srgb, var(--embed-warning) 8%, transparent)",
            border: "1px solid color-mix(in srgb, var(--embed-warning) 25%, transparent)",
            color: "var(--embed-warning)",
          }}>
            <span style={{ flexShrink: 0 }}>{renderIcon("shield", 16)}</span>
            <span>Only install apps from sources you trust. Third-party apps run as containers on your server.</span>
          </div>

          {customError && (
            <div style={{
              marginTop: 12, padding: "10px 12px", borderRadius: 8, fontSize: 12,
              background: "color-mix(in srgb, var(--embed-danger) 8%, transparent)",
              border: "1px solid color-mix(in srgb, var(--embed-danger) 25%, transparent)",
              color: "var(--embed-danger)",
            }}>
              {customError}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
            <button className="embed-btn" onClick={() => { setShowCustomUrl(false); setCustomError(null); }} disabled={customFetching} style={{ borderRadius: 8, padding: "8px 16px" }}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "28px 40px", minHeight: "100vh" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em" }}>App Market</div>
          <div style={{ fontSize: 14, color: "var(--embed-text-muted)", marginTop: 4 }}>
            Discover and install apps for your platform
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="embed-btn" onClick={() => setShowCustomUrl(true)} style={{
            borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600,
            display: "flex", alignItems: "center", gap: 6,
            borderColor: "var(--embed-primary)", color: "var(--embed-primary)",
          }}>
            <PlusIcon size={14} /> Add Custom
          </button>
          <button className="embed-btn" onClick={handleRefresh} disabled={refreshing} style={{
            borderRadius: 8, padding: "8px 14px", fontSize: 13,
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <RefreshIcon size={14} /> {refreshing ? "..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* Search */}
      <div style={{ position: "relative", marginBottom: 20 }}>
        <div style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--embed-text-muted)" }}>
          <SearchIcon size={16} />
        </div>
        <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search apps..."
          style={{
            width: "100%", padding: "12px 16px 12px 40px", fontSize: 14, borderRadius: 12,
            border: "1px solid var(--embed-border)", background: "var(--embed-card-bg)",
            color: "var(--embed-text)", outline: "none", transition: "border-color 0.2s",
          }}
          onFocus={e => e.currentTarget.style.borderColor = "var(--embed-primary)"}
          onBlur={e => e.currentTarget.style.borderColor = "var(--embed-border)"}
        />
      </div>

      {/* Category pills */}
      <div style={{ display: "flex", gap: 8, marginBottom: 28, flexWrap: "wrap" }}>
        <CategoryPill label="All" active={activeCategory === "all"} onClick={() => setActiveCategory("all")} count={apps.length} />
        {allCategories.map(cat => (
          <CategoryPill key={cat} label={cat.charAt(0).toUpperCase() + cat.slice(1)} active={activeCategory === cat} onClick={() => setActiveCategory(cat)}
            count={apps.filter(a => a.category === cat).length} />
        ))}
      </div>

      {/* Active installs banner */}
      {activeInstalls.length > 0 && (
        <div style={{
          background: "var(--embed-card-bg)", border: "1px solid var(--embed-primary)",
          borderRadius: 14, padding: 20, marginBottom: 20,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 700, marginBottom: 10, color: "var(--embed-primary)" }}>
            <span style={{ width: 16, height: 16, border: "2.5px solid var(--embed-primary)", borderTopColor: "transparent", borderRadius: "50%", animation: "embed-spin 0.8s linear infinite", display: "inline-block" }} />
            Installing ({activeInstalls.length})
          </div>
          {activeInstalls.map(inst => {
            const last = inst.events[inst.events.length - 1];
            const pct = last ? Math.round((last.step / Math.max(last.totalSteps, 1)) * 100) : 0;
            const hasError = inst.events.some(e => e.status === "error");
            const barColor = hasError ? "var(--embed-danger)" : "var(--embed-primary)";
            return (
              <div key={inst.appId} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                  <span style={{ fontWeight: 600 }}>{inst.appName}</span>
                  <span style={{ color: "var(--embed-text-muted)", fontSize: 12 }}>{pct}%</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--embed-text-muted)", marginBottom: 4 }}>{last?.message || "Starting..."}</div>
                <div className="embed-progress-track">
                  <div className="embed-progress-bar" style={{ width: `${pct}%`, background: barColor }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Recently completed */}
      {completedInstalls.length > 0 && apps.filter(a => completedInstalls.includes(a.id)).map(app => (
        <div key={app.id} style={{
          background: "var(--embed-card-bg)", border: "1px solid var(--embed-success)",
          borderRadius: 14, padding: "14px 20px", marginBottom: 16,
          display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "var(--embed-success)",
        }}>
          <span style={{ fontWeight: 600 }}>{"\u2713"} {app.name}</span> installed successfully
        </div>
      ))}

      {/* Installed section */}
      {installedApps.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div style={{
            fontSize: 13, fontWeight: 700, color: "var(--embed-text-muted)",
            textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 14,
            display: "flex", alignItems: "center", gap: 8,
          }}>
            <span style={{ color: "var(--embed-success)" }}>{renderIcon("package", 16)}</span>
            Installed ({installedApps.length})
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
            {installedApps.map(app => (
              <AppCard key={app.id} app={app} onSelect={setSelectedApp} showStatus />
            ))}
          </div>
        </div>
      )}

      {/* Available section */}
      {availableApps.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{
            fontSize: 13, fontWeight: 700, color: "var(--embed-text-muted)",
            textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 14,
          }}>
            Available ({availableApps.length})
          </div>

          {/* Native apps featured row */}
          {activeCategory === "all" && nativeApps.filter(a => !a.installed).length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{
                fontSize: 12, fontWeight: 600, color: "var(--embed-primary)",
                marginBottom: 10, display: "flex", alignItems: "center", gap: 6,
              }}>
                {renderIcon("shield", 14)} Built for YouEye
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
                {nativeApps.filter(a => !a.installed).map(app => (
                  <AppCard key={app.id} app={app} onSelect={setSelectedApp} featured />
                ))}
              </div>
            </div>
          )}

          {/* Community / marketplace apps */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
            {(activeCategory === "all" ? marketplaceApps.filter(a => !a.installed) : availableApps.filter(a => a.integration !== "native" && a.type !== "native")).map(app => (
              <AppCard key={app.id} app={app} onSelect={setSelectedApp} />
            ))}
          </div>
        </div>
      )}

      {filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: 48, color: "var(--embed-text-muted)" }}>
          <div style={{ fontSize: 18, marginBottom: 8 }}>No apps found</div>
          <div style={{ fontSize: 13 }}>Try a different search or category.</div>
        </div>
      )}

      {renderInstallDialog()}
      {renderUninstallDialog()}
      {renderCustomUrlDialog()}
    </div>
  );
}

// ─── App Card Component ──────────────────────────────────

function AppCard({ app, onSelect, featured, showStatus }: {
  app: MarketApp;
  onSelect: (app: MarketApp) => void;
  featured?: boolean;
  showStatus?: boolean;
}) {
  const isNative = app.integration === "native";
  const borderDefault = featured
    ? "color-mix(in srgb, var(--embed-primary) 25%, var(--embed-border))"
    : "var(--embed-border)";

  return (
    <div
      onClick={() => onSelect(app)}
      style={{
        display: "flex", alignItems: "center", gap: 14, cursor: "pointer",
        padding: "16px 18px", borderRadius: 14,
        background: "var(--embed-card-bg)",
        border: `1px solid ${borderDefault}`,
        transition: "border-color 0.2s, box-shadow 0.2s, transform 0.15s",
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = "var(--embed-primary)";
        e.currentTarget.style.boxShadow = "0 2px 12px color-mix(in srgb, var(--embed-primary) 10%, transparent)";
        e.currentTarget.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = borderDefault;
        e.currentTarget.style.boxShadow = "";
        e.currentTarget.style.transform = "";
      }}
    >
      <AppIcon app={app} size={48} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{app.name}</span>
          {isNative && (
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 600,
              padding: "1px 6px", borderRadius: 9999,
              background: "color-mix(in srgb, var(--embed-primary) 10%, transparent)",
              color: "var(--embed-primary)",
            }}>
              YouEye
            </span>
          )}
          {app.source === "url" && (
            <span style={{
              fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 9999,
              color: "var(--embed-warning)", border: "1px solid color-mix(in srgb, var(--embed-warning) 30%, transparent)",
            }}>
              Custom
            </span>
          )}
          {app.updateAvailable && (
            <span style={{
              fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 9999,
              color: "var(--embed-primary)", background: "color-mix(in srgb, var(--embed-primary) 10%, transparent)",
            }}>
              Update
            </span>
          )}
        </div>
        <div style={{
          fontSize: 12, color: "var(--embed-text-muted)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {app.description}
        </div>
        {showStatus && app.installed && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 11 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--embed-success)", display: "inline-block" }} />
            <span style={{ color: "var(--embed-text-muted)" }}>
              {app.installedVersion ? `v${app.installedVersion}` : "Installed"}
            </span>
          </div>
        )}
      </div>

      {/* Subtle arrow */}
      <div style={{ color: "var(--embed-text-muted)", opacity: 0.4, flexShrink: 0 }}>
        <ChevronRightIcon size={18} />
      </div>
    </div>
  );
}

// ─── Helper Components ───────────────────────────────────

function CategoryPill({ label, active, onClick, count }: {
  label: string; active: boolean; onClick: () => void; count?: number;
}) {
  return (
    <button onClick={onClick} style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "8px 16px", borderRadius: 20, fontSize: 13, fontWeight: 500,
      border: `1px solid ${active ? "var(--embed-primary)" : "var(--embed-border)"}`,
      background: active ? "color-mix(in srgb, var(--embed-primary) 12%, transparent)" : "var(--embed-card-bg)",
      color: active ? "var(--embed-primary)" : "var(--embed-text-muted)",
      cursor: "pointer", transition: "all 0.2s",
    }}>
      {label}
      {count !== undefined && (
        <span style={{ fontSize: 11, opacity: 0.7 }}>{count}</span>
      )}
    </button>
  );
}

function DetailItem({ icon, label, value }: { icon: string; label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{
        width: 34, height: 34, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
        background: "var(--embed-hover)", color: "var(--embed-text-muted)",
      }}>
        {renderIcon(icon, 16)}
      </div>
      <div>
        <div style={{ fontSize: 11, color: "var(--embed-text-muted)" }}>{label}</div>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{value}</div>
      </div>
    </div>
  );
}

function ToggleSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!on)} style={{
      position: "relative", width: 38, height: 22, borderRadius: 11, border: "none", cursor: "pointer",
      background: on ? "var(--embed-primary)" : "var(--embed-border)",
      transition: "background 0.2s", flexShrink: 0,
    }}>
      <span style={{
        position: "absolute", top: 3, left: on ? 19 : 3,
        width: 16, height: 16, borderRadius: "50%", background: "#fff",
        transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
      }} />
    </button>
  );
}
