"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import {
  Server, Box, Cog, Monitor, Database, ShieldCheck, Globe, Shield,
  LayoutDashboard, Search, BookOpen, StickyNote, Film, CloudSun,
  Languages, Camera, MessageCircle, Package,
} from "lucide-react";
import type { ComponentType } from "react";

const ICON_MAP: Record<string, ComponentType<{ style?: React.CSSProperties }>> = {
  Server, Box, Cog, Monitor, Database, ShieldCheck, Globe, Shield,
  LayoutDashboard, Search, BookOpen, StickyNote, Film, CloudSun,
  Languages, Camera, MessageCircle, Package,
};

function toKebabCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function toPascalCase(s: string): string {
  return s.split("-").map(p => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

function resolveIcon(iconName: string): ComponentType<{ style?: React.CSSProperties }> | null {
  // Try direct PascalCase match first (e.g. "Server", "ShieldCheck")
  if (ICON_MAP[iconName]) return ICON_MAP[iconName];
  // Try converting kebab-case to PascalCase (e.g. "cloud-sun" -> "CloudSun")
  const pascal = toPascalCase(iconName);
  if (ICON_MAP[pascal]) return ICON_MAP[pascal];
  // Try converting to kebab then PascalCase
  const kebab = toKebabCase(iconName);
  const pascal2 = toPascalCase(kebab);
  if (ICON_MAP[pascal2]) return ICON_MAP[pascal2];
  return null;
}

interface AppInfo {
  id: string;
  displayName: string;
  description: string;
  icon: string;
  iconUrl?: string;
  category: string;
  type: string;
  integration?: "native" | "basic";
  containers: Array<{ name: string; status: string; ip?: string }>;
  version?: string;
  status: string;
  updateAvailable: boolean;
  updateInfo?: string;
}

interface UpdateStatus {
  component: string;
  status: string;
  message: string;
  progress: number;
  version_after?: string;
  error?: string;
}

const STATUS_COLORS: Record<string, string> = {
  running: "var(--embed-success)",
  stopped: "var(--embed-danger)",
  partial: "var(--embed-warning)",
  "not-installed": "var(--embed-text-muted)",
  unknown: "var(--embed-text-muted)",
};

const STATUS_LABELS: Record<string, string> = {
  running: "Running",
  stopped: "Stopped",
  partial: "Partial",
  "not-installed": "Not installed",
  unknown: "Unknown",
};

const CATEGORY_LABELS: Record<string, string> = {
  system: "System",
  infrastructure: "Infrastructure",
  user: "Apps",
};

const SELF_DESTRUCTIVE = new Set(["control-panel", "youeye-ui"]);

const COMPONENT_MAP: Record<string, string> = {
  "control-panel": "control",
  "youeye-ui": "ui",
  spine: "spine",
};

export function AppsEmbedClient() {
  const searchParams = useSearchParams();
  const section = searchParams.get("section") as "updates" | "system" | null;

  const [apps, setApps] = useState<AppInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [statuses, setStatuses] = useState<Map<string, UpdateStatus>>(new Map());
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [restartOverlay, setRestartOverlay] = useState<string | null>(null);
  const [editingApp, setEditingApp] = useState<AppInfo | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchApps = useCallback(async (refresh = false) => {
    try {
      setError(null);
      const url = refresh ? "/api/ui-bridge/apps?refresh=true" : "/api/ui-bridge/apps";
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setApps(json.apps ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
      setChecking(false);
    }
  }, []);

  const fetchStatuses = useCallback(async () => {
    try {
      const res = await fetch("/api/ui-bridge/updates/status");
      if (!res.ok) return;
      const json = await res.json();
      const map = new Map<string, UpdateStatus>();
      for (const s of json.statuses || []) map.set(s.component, s);
      setStatuses(map);
    } catch { /* best-effort */ }
  }, []);

  useEffect(() => {
    fetchApps();
    fetchStatuses();
  }, [fetchApps, fetchStatuses]);

  useEffect(() => {
    const hasActive = Array.from(statuses.values()).some(
      s => !["idle", "completed", "failed"].includes(s.status)
    );
    if (hasActive && !pollingRef.current) {
      pollingRef.current = setInterval(fetchStatuses, 2000);
    } else if (!hasActive && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
      fetchApps();
    }
    return () => { if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; } };
  }, [statuses, fetchStatuses, fetchApps]);

  const handleUpdate = async (appId: string) => {
    if (SELF_DESTRUCTIVE.has(appId) && confirmId !== appId) {
      setConfirmId(appId);
      return;
    }
    setConfirmId(null);

    const component = COMPONENT_MAP[appId] || appId;

    if (SELF_DESTRUCTIVE.has(appId)) {
      const action = appId === "control-panel" ? "control-restarting" : "ui-restarting";
      window.parent.postMessage({ type: "youeye-embed-action", action }, "*");
      setRestartOverlay(appId === "control-panel" ? "Control Panel" : "YouEye UI");
    }

    // Start polling BEFORE the POST so intermediate progress states are visible
    if (!pollingRef.current) {
      pollingRef.current = setInterval(fetchStatuses, 2000);
    }

    // Fire POST without awaiting — progress comes from polling /status
    fetch(`/api/ui-bridge/updates/${component}`, { method: "POST" })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "Update failed" }));
          console.error("Update failed:", body.error);
        }
        fetchStatuses();
      })
      .catch((err) => {
        console.error(`Update ${appId} failed:`, err);
        fetchStatuses();
      });
  };

  if (loading) {
    // For the updates section, render nothing while loading — the parent
    // UI keeps the embed invisible until it reports non-zero content height,
    // so showing a skeleton here would cause a brief flicker before collapsing.
    if (section === "updates") return <div />;
    return (
      <div style={{ padding: 16 }}>
        <div className="embed-skeleton" style={{ height: 20, width: 200, marginBottom: 16 }} />
        {[1, 2, 3, 4, 5].map(i => (
          <div key={i} className="embed-card" style={{ marginBottom: 8 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <div className="embed-skeleton" style={{ width: 40, height: 40, borderRadius: 8 }} />
              <div style={{ flex: 1 }}>
                <div className="embed-skeleton" style={{ height: 14, width: 120, marginBottom: 6 }} />
                <div className="embed-skeleton" style={{ height: 12, width: 200 }} />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) return <div className="embed-error">{error}</div>;

  const appsWithUpdates = apps.filter(a => a.updateAvailable);
  const appsWithout = apps.filter(a => !a.updateAvailable);
  const grouped = appsWithout.reduce<Record<string, AppInfo[]>>((acc, app) => {
    const cat = app.category || "user";
    (acc[cat] ??= []).push(app);
    return acc;
  }, {});

  // section="updates" → only show updates available banner
  if (section === "updates") {
    if (appsWithUpdates.length === 0) return <div />;
    return (
      <div style={{ padding: 16 }}>
        {restartOverlay && <RestartOverlay name={restartOverlay} />}
        <div className="embed-header">
          <div>
            <div className="embed-title">Updates Available</div>
            <div className="embed-subtitle">{appsWithUpdates.length} update{appsWithUpdates.length !== 1 ? "s" : ""} available</div>
          </div>
          <button className="embed-btn" onClick={() => { setChecking(true); fetchApps(true); }} disabled={checking}>
            {checking ? "Checking..." : "Check for Updates"}
          </button>
        </div>
        {appsWithUpdates.map(app => (
          <AppCard key={app.id} app={app} statuses={statuses} confirmId={confirmId}
            onUpdate={handleUpdate} onCancelConfirm={() => setConfirmId(null)} onEdit={setEditingApp} />
        ))}
        {editingApp && (
          <EditAppDialog app={editingApp} onSaved={() => { setEditingApp(null); fetchApps(); }} onClose={() => setEditingApp(null)} />
        )}
      </div>
    );
  }

  // section="system" → only show system + infrastructure categories
  if (section === "system") {
    const systemCats = ["infrastructure", "system"];
    const hasAny = systemCats.some(cat => grouped[cat]?.length);
    if (!hasAny) return <div />;
    return (
      <div style={{ padding: 16 }}>
        {restartOverlay && <RestartOverlay name={restartOverlay} />}
        <div className="embed-header">
          <div>
            <div className="embed-title">System Components</div>
            <div className="embed-subtitle">Infrastructure and system services</div>
          </div>
        </div>
        {systemCats.map(cat => {
          const catApps = grouped[cat];
          if (!catApps?.length) return null;
          return (
            <div key={cat} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--embed-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                {CATEGORY_LABELS[cat] || cat}
              </div>
              {catApps.map(app => (
                <AppCard key={app.id} app={app} statuses={statuses} confirmId={confirmId}
                  onUpdate={handleUpdate} onCancelConfirm={() => setConfirmId(null)} onEdit={setEditingApp} />
              ))}
            </div>
          );
        })}
        {editingApp && (
          <EditAppDialog app={editingApp} onSaved={() => { setEditingApp(null); fetchApps(); }} onClose={() => setEditingApp(null)} />
        )}
      </div>
    );
  }

  // Default: render everything (backwards compatible)
  return (
    <div style={{ padding: 16 }}>
      {/* Restart overlay */}
      {restartOverlay && <RestartOverlay name={restartOverlay} />}

      {/* Header */}
      <div className="embed-header">
        <div>
          <div className="embed-title">Apps &amp; Updates</div>
          <div className="embed-subtitle">All installed apps and services with version info</div>
        </div>
        <button className="embed-btn" onClick={() => { setChecking(true); fetchApps(true); }} disabled={checking}>
          {checking ? "Checking..." : "Check for Updates"}
        </button>
      </div>

      {/* Updates Available */}
      {appsWithUpdates.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <span style={{ color: "var(--embed-warning)", fontSize: 13, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Updates Available ({appsWithUpdates.length})
            </span>
          </div>
          {appsWithUpdates.map(app => (
            <AppCard key={app.id} app={app} statuses={statuses} confirmId={confirmId}
              onUpdate={handleUpdate} onCancelConfirm={() => setConfirmId(null)} onEdit={setEditingApp} />
          ))}
        </div>
      )}

      {/* Categories */}
      {["user", "infrastructure", "system"].map(cat => {
        const catApps = grouped[cat];
        if (!catApps?.length) return null;
        return (
          <div key={cat} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--embed-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
              {CATEGORY_LABELS[cat] || cat}
            </div>
            {catApps.map(app => (
              <AppCard key={app.id} app={app} statuses={statuses} confirmId={confirmId}
                onUpdate={handleUpdate} onCancelConfirm={() => setConfirmId(null)} onEdit={setEditingApp} />
            ))}
          </div>
        );
      })}

      {/* Edit Dialog */}
      {editingApp && (
        <EditAppDialog app={editingApp} onSaved={() => { setEditingApp(null); fetchApps(); }} onClose={() => setEditingApp(null)} />
      )}
    </div>
  );
}

function RestartOverlay({ name }: { name: string }) {
  return (
    <div style={{
      position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.6)", zIndex: 200,
    }}>
      <div className="embed-card" style={{ textAlign: "center", maxWidth: 360, padding: 32 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
          {name} is restarting...
        </div>
        <div className="embed-muted" style={{ fontSize: 13 }}>
          The page will reload automatically when the service is back online.
        </div>
        <div style={{ marginTop: 16 }}>
          <div className="embed-skeleton" style={{ height: 4, width: "100%", borderRadius: 2 }} />
        </div>
      </div>
    </div>
  );
}

function AppIconBox({ app, isUserApp, onClick }: { app: AppInfo; isUserApp: boolean; onClick: () => void }) {
  const [imgFailed, setImgFailed] = useState(false);
  const Icon = resolveIcon(app.icon);
  const showImg = app.iconUrl && !imgFailed;

  return (
    <div style={{
      width: 36, height: 36, borderRadius: 8,
      display: "flex", alignItems: "center", justifyContent: "center",
      overflow: "hidden", flexShrink: 0,
      cursor: isUserApp ? "pointer" : "default",
    }} onClick={onClick}>
      {showImg ? (
        <img src={app.iconUrl} alt="" style={{ width: 20, height: 20, objectFit: "contain" }}
          onError={() => setImgFailed(true)} />
      ) : Icon ? (
        <Icon style={{ width: 18, height: 18, color: "var(--embed-text-muted)" }} />
      ) : (
        <span style={{ fontSize: 16, fontWeight: 700, color: "var(--embed-text-muted)" }}>
          {app.displayName.charAt(0)}
        </span>
      )}
    </div>
  );
}

function AppCard({ app, statuses, confirmId, onUpdate, onCancelConfirm, onEdit }: {
  app: AppInfo;
  statuses: Map<string, UpdateStatus>;
  confirmId: string | null;
  onUpdate: (id: string) => void;
  onCancelConfirm: () => void;
  onEdit: (app: AppInfo) => void;
}) {
  const component = COMPONENT_MAP[app.id] || app.id;
  const ps = statuses.get(component);
  const isUpdating = ps && !["idle", "completed", "failed"].includes(ps.status);
  const statusColor = STATUS_COLORS[app.status] || STATUS_COLORS.unknown;
  const isUserApp = app.category === "user";

  const handleNavigate = () => {
    if (isUserApp) {
      window.parent.postMessage({ type: "youeye-app-navigate", appId: app.id }, "*");
    }
  };

  return (
    <div className="embed-card" style={{ marginBottom: 6, padding: "10px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* Icon */}
        <AppIconBox app={app} isUserApp={isUserApp} onClick={handleNavigate} />

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0, cursor: isUserApp ? "pointer" : "default" }} onClick={handleNavigate}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontWeight: 500, fontSize: 13 }}>{app.displayName}</span>
            {app.version && <span className="embed-muted" style={{ fontSize: 12 }}>v{app.version}</span>}
            <span className="embed-badge" style={{ fontSize: 10 }}>
              {app.integration === "native" ? "native" : "community"}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: statusColor }}>
              <span className="embed-dot" style={{ width: 5, height: 5, background: statusColor }} />
              {STATUS_LABELS[app.status] || app.status}
            </span>
            <span className="embed-muted" style={{ fontSize: 12 }}>{app.description}</span>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {app.category === "user" && (
            <button className="embed-btn" style={{ padding: "3px 8px", fontSize: 12 }}
              onClick={() => onEdit(app)}>Edit</button>
          )}
          {app.updateAvailable && !isUpdating && (
            <span style={{ fontSize: 12, color: "var(--embed-warning)", display: "flex", alignItems: "center", gap: 4 }}>
              {app.updateInfo || "Update available"}
            </span>
          )}
          {app.updateAvailable && (
            <button className="embed-btn" style={{
              padding: "4px 10px", fontSize: 12,
              borderColor: "var(--embed-primary)", color: "var(--embed-primary)",
            }}
              onClick={() => onUpdate(app.id)} disabled={!!isUpdating}>
              {isUpdating ? "..." : "Update"}
            </button>
          )}
        </div>
      </div>

      {/* Self-destructive warning */}
      {confirmId === app.id && (
        <div style={{
          marginTop: 8, padding: "8px 12px", borderRadius: 6, fontSize: 12,
          background: "color-mix(in srgb, var(--embed-warning) 10%, transparent)",
          border: "1px solid color-mix(in srgb, var(--embed-warning) 25%, transparent)",
        }}>
          <div style={{ display: "flex", alignItems: "start", gap: 8 }}>
            <div>
              <div style={{ color: "var(--embed-warning)", fontWeight: 500, marginBottom: 4 }}>
                This will restart {app.displayName}. The page may become temporarily unavailable.
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button className="embed-btn" style={{ padding: "3px 10px", fontSize: 12, borderColor: "var(--embed-danger)", color: "var(--embed-danger)" }}
                  onClick={() => onUpdate(app.id)}>Continue</button>
                <button className="embed-btn" style={{ padding: "3px 10px", fontSize: 12 }}
                  onClick={onCancelConfirm}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Inline progress */}
      {ps && ps.status !== "idle" && <InlineProgress status={ps} />}
    </div>
  );
}

function InlineProgress({ status }: { status: UpdateStatus }) {
  const isActive = !["completed", "failed"].includes(status.status);
  const isCompleted = status.status === "completed";
  const isFailed = status.status === "failed";
  const color = isActive ? "var(--embed-primary)" : isCompleted ? "var(--embed-success)" : "var(--embed-danger)";

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color }}>
        {isActive && <span style={{ animation: "embed-pulse 1s infinite" }}>●</span>}
        {isCompleted && <span>✓</span>}
        {isFailed && <span>✗</span>}
        <span>{status.message}</span>
      </div>
      {isActive && (
        <div className="embed-progress-track" style={{ marginTop: 4 }}>
          <div className="embed-progress-bar" style={{ width: `${status.progress}%`, background: color }} />
        </div>
      )}
      {isCompleted && status.version_after && (
        <div style={{ fontSize: 12, color: "var(--embed-success)", marginTop: 2, fontWeight: 500 }}>
          Updated to v{status.version_after}
        </div>
      )}
      {isFailed && status.error && (
        <div style={{ fontSize: 12, color: "var(--embed-danger)", marginTop: 2 }}>{status.error}</div>
      )}
    </div>
  );
}

function EditAppDialog({ app, onSaved, onClose }: {
  app: AppInfo; onSaved: () => void; onClose: () => void;
}) {
  const [name, setName] = useState(app.displayName);
  const [subdomain, setSubdomain] = useState("");
  const [showSubdomain, setShowSubdomain] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (name.trim() && name.trim() !== app.displayName) body.name = name.trim();
      if (showSubdomain && subdomain.trim()) body.subdomain = subdomain.trim().toLowerCase();
      if (Object.keys(body).length === 0) { onClose(); return; }

      const res = await fetch(`/api/ui-bridge/apps/${app.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Failed" }));
        setError(data.error || "Failed to save");
        return;
      }
      onSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.5)", zIndex: 100,
    }} onClick={onClose}>
      <div className="embed-card" style={{ maxWidth: 400, width: "90%" }} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 12 }}>Edit {app.displayName}</div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Display Name</div>
          <input type="text" value={name} onChange={e => setName(e.target.value)}
            placeholder={app.displayName}
            style={{
              width: "100%", padding: "6px 10px", fontSize: 13, borderRadius: 6,
              border: "1px solid var(--embed-border)", background: "var(--embed-bg)",
              color: "var(--embed-text)", outline: "none",
            }} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <button type="button" onClick={() => setShowSubdomain(!showSubdomain)}
            style={{ fontSize: 13, color: "var(--embed-primary)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            {showSubdomain ? "Hide subdomain change" : "Change subdomain..."}
          </button>
          {showSubdomain && (
            <div style={{ marginTop: 8 }}>
              <input type="text" value={subdomain} onChange={e => setSubdomain(e.target.value)}
                placeholder="new-subdomain"
                style={{
                  width: "100%", padding: "6px 10px", fontSize: 13, borderRadius: 6,
                  border: "1px solid var(--embed-border)", background: "var(--embed-bg)",
                  color: "var(--embed-text)", outline: "none", marginBottom: 6,
                }} />
              <div style={{
                padding: "6px 10px", borderRadius: 6, fontSize: 11,
                background: "color-mix(in srgb, var(--embed-warning) 10%, transparent)",
                border: "1px solid color-mix(in srgb, var(--embed-warning) 20%, transparent)",
                color: "var(--embed-warning)",
              }}>
                This will update Caddy routing, Authentik SSO redirects, and all bookmark URLs.
              </div>
            </div>
          )}
        </div>

        {error && <div style={{ fontSize: 13, color: "var(--embed-danger)", marginBottom: 8 }}>{error}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="embed-btn" onClick={onClose}>Cancel</button>
          <button className="embed-btn" style={{ borderColor: "var(--embed-primary)", color: "var(--embed-primary)" }}
            onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
