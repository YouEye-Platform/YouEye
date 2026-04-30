/**
 * App Settings Detail — Per-app settings with consolidated tabs
 *
 * Tabs:
 * 1. App Settings — Iframe embed of the app's own settings page (native apps only)
 * 2. Overview — App info, status, version, subdomain (local DB)
 * 3. Permissions — Per-app user permission management (local DB)
 * 4. Network (admin only) — CP embed iframe for bridges + grants
 * 5. Link Handling — URL rewrite handlers (local DB)
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ArrowLeft,
  Link2,
  Globe,
  ExternalLink,
  Shield,
  ShieldCheck,
  ShieldX,
  Trash2,
  RefreshCw,
  Info,
  Loader2,
  Sliders,
  Search,
  BookOpen,
  StickyNote,
  Film,
  CloudSun,
  Languages,
  Camera,
  MessageCircle,
  Package,
} from "lucide-react";
import type { ComponentType } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AdminEmbed } from "@/components/settings/admin-embed";

/* ── Types ── */

interface AppInfo {
  id: string;
  name: string;
  icon: string | null;
  subdomain: string | null;
  version: string | null;
  status: string | null;
  containerUrl: string | null;
  hasSettingsPanel: boolean;
}

interface Permission {
  id: string;
  appId: string;
  permission: string;
  granted: boolean;
  grantType: string | null;
  grantedAt: string | null;
}

interface LinkHandler {
  type: string;
  description: string;
  endpoint: string;
  triggers: string[];
}

/* ── Tab type ── */

type TabId = "app-settings" | "overview" | "permissions" | "network" | "link-handling";

/* ── Icon helpers ── */

const ICON_MAP: Record<string, ComponentType<{ className?: string }>> = {
  search: Search,
  "book-open": BookOpen,
  "sticky-note": StickyNote,
  film: Film,
  "cloud-sun": CloudSun,
  languages: Languages,
  camera: Camera,
  "message-circle": MessageCircle,
  package: Package,
};

function toKebabCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function AppHeaderIcon({ name, icon }: { name: string; icon: string | null }) {
  if (icon && icon.startsWith("emoji:")) {
    return (
      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
        <span className="text-xl leading-none">{icon.slice(6)}</span>
      </div>
    );
  }
  if (icon && (icon.startsWith("http") || icon.startsWith("/"))) {
    return (
      <div className="w-10 h-10 rounded-xl overflow-hidden bg-primary/10 flex items-center justify-center">
        <img src={icon} alt={name} className="w-10 h-10 rounded-xl object-cover" />
      </div>
    );
  }
  if (icon) {
    const key = toKebabCase(icon);
    const IconComponent = ICON_MAP[key];
    if (IconComponent) {
      return (
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <IconComponent className="w-5 h-5 text-primary" />
        </div>
      );
    }
  }
  return (
    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
      <span className="text-sm font-bold text-primary">{name.charAt(0).toUpperCase()}</span>
    </div>
  );
}

/* ── Main Component ── */

export function AppSettingsDetail({
  appId,
  directAccessEmbedUrl,
  isAdmin: isAdminProp,
  initialTab,
}: {
  appId: string;
  directAccessEmbedUrl?: string;
  isAdmin: boolean;
  initialTab?: string;
}) {
  const [app, setApp] = useState<AppInfo | null>(null);
  const [linkHandlers, setLinkHandlers] = useState<LinkHandler[]>([]);
  const [isAdmin] = useState(isAdminProp);
  const [loading, setLoading] = useState(true);
  const validTabs: TabId[] = ["app-settings", "overview", "permissions", "network", "link-handling"];
  const [activeTab, setActiveTab] = useState<TabId>(
    initialTab && validTabs.includes(initialTab as TabId) ? (initialTab as TabId) : "app-settings"
  );
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [permissionsLoading, setPermissionsLoading] = useState(false);
  const router = useRouter();
  const t = useTranslations("common");

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/apps/drawer");
      if (res.ok) {
        const data = await res.json();
        const allApps = data.apps ?? [];
        // Try exact match first, then strip common prefixes (CP sends "ye-search", DB has "search")
        const found = allApps.find((a: { id: string }) => a.id === appId)
          ?? allApps.find((a: { id: string }) => a.id === appId.replace(/^(ye-|app-)/, ""));
        if (found) {
          setApp({
            id: found.id,
            name: found.name,
            icon: found.icon,
            subdomain: found.subdomain ?? null,
            version: found.version ?? null,
            status: found.status ?? null,
            containerUrl: found.containerUrl ?? null,
            hasSettingsPanel: found.hasSettingsPanel ?? false,
          });
        } else {
          setApp({ id: appId, name: appId, icon: null, subdomain: null, version: null, status: null, containerUrl: null, hasSettingsPanel: false });
        }
      } else {
        setApp({ id: appId, name: appId, icon: null, subdomain: null, version: null, status: null, containerUrl: null, hasSettingsPanel: false });
      }
    } finally {
      setLoading(false);
    }
  }, [appId]);

  const fetchLinkHandlers = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/apps/${appId}/link-handlers`);
      if (res.ok) {
        const data = await res.json();
        setLinkHandlers(data.handlers ?? []);
      }
    } catch {
      // silent
    }
  }, [appId]);

  const fetchPermissions = useCallback(async () => {
    setPermissionsLoading(true);
    try {
      const res = await fetch("/api/v1/permissions/list");
      if (res.ok) {
        const data = await res.json();
        const all: Permission[] = data.permissions ?? [];
        setPermissions(all.filter((p) => p.appId === appId));
      }
    } catch {
      // silent
    } finally {
      setPermissionsLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  // If app loaded and has no settings panel, switch away from app-settings tab
  useEffect(() => {
    if (app && !app.hasSettingsPanel && activeTab === "app-settings") {
      setActiveTab("overview");
    }
  }, [app, activeTab]);

  useEffect(() => {
    if (activeTab === "permissions") fetchPermissions();
    if (activeTab === "link-handling") fetchLinkHandlers();
  }, [activeTab, fetchPermissions, fetchLinkHandlers]);

  if (loading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">{t("loading")}</div>;
  }

  if (!app) {
    return <div className="py-8 text-center text-sm text-muted-foreground">App not found</div>;
  }

  // Only show app-settings tab if the app declares settings_panel capability AND has a subdomain for the embed
  const hasAppSettings = app.hasSettingsPanel && !!app.subdomain;

  const tabs: { id: TabId; label: string; icon: React.ReactNode; adminOnly?: boolean; hide?: boolean }[] = [
    { id: "app-settings", label: "App Settings", icon: <Sliders className="w-4 h-4" />, hide: !hasAppSettings },
    { id: "overview", label: "Overview", icon: <Info className="w-4 h-4" /> },
    { id: "permissions", label: "Permissions", icon: <Shield className="w-4 h-4" /> },
    { id: "network", label: "Network", icon: <Globe className="w-4 h-4" />, adminOnly: true },
    { id: "link-handling", label: "Link Handling", icon: <Link2 className="w-4 h-4" /> },
  ];

  const visibleTabs = tabs.filter((tab) => (!tab.adminOnly || isAdmin) && !tab.hide);

  return (
    <div className="space-y-6">
      {/* Back link */}
      <button
        onClick={() => router.push("/settings/apps")}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        {t("back")}
      </button>

      {/* App header */}
      <div className="flex items-center gap-3">
        <AppHeaderIcon name={app.name} icon={app.icon} />
        <div>
          <h2 className="text-xl font-semibold">{app.name}</h2>
          <p className="text-sm text-muted-foreground">Manage app settings and permissions</p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="border-b">
        <nav className="flex gap-6" aria-label="App settings tabs">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      {activeTab === "app-settings" && (
        hasAppSettings ? (
          <AppSettingsEmbed subdomain={app.subdomain!} />
        ) : (
          <div className="py-8 text-center border rounded-lg">
            <Sliders className="w-8 h-8 mx-auto mb-3 text-muted-foreground opacity-40" />
            <p className="text-sm text-muted-foreground">No settings available for this app.</p>
          </div>
        )
      )}

      {activeTab === "overview" && <OverviewTab app={app} />}

      {activeTab === "permissions" && (
        <PermissionsTab
          permissions={permissions}
          loading={permissionsLoading}
          appId={appId}
          onRefresh={fetchPermissions}
        />
      )}

      {activeTab === "network" && isAdmin && directAccessEmbedUrl && (
        <AdminEmbed signedUrl={directAccessEmbedUrl} title="App Network" minHeight={200} />
      )}

      {activeTab === "link-handling" && (
        <LinkHandlingTab
          linkHandlers={linkHandlers}
          appName={app?.name ?? appId}
          appId={appId}
          isAdmin={isAdmin}
          onRefresh={fetchLinkHandlers}
        />
      )}
    </div>
  );
}

/* ── App Settings Embed ── */

function AppSettingsEmbed({ subdomain }: { subdomain: string }) {
  const [iframeHeight, setIframeHeight] = useState(400);
  const domain = typeof window !== "undefined" ? window.location.hostname : "";
  const settingsUrl = `https://${subdomain}.${domain}/settings?embed=true`;

  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type === "youeye-app-settings-resize" && typeof e.data.height === "number") {
        setIframeHeight(Math.max(200, e.data.height));
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return (
    <div className="border rounded-lg overflow-hidden">
      <iframe
        src={settingsUrl}
        className="w-full border-0"
        style={{ height: `${iframeHeight}px`, minHeight: "200px" }}
        title="App Settings"
        allow="clipboard-write"
      />
    </div>
  );
}

/* ── Overview Tab ── */

function OverviewTab({ app }: { app: AppInfo }) {
  const domain = typeof window !== "undefined" ? window.location.hostname : "";
  const appUrl = app.subdomain ? `https://${app.subdomain}.${domain}` : null;

  return (
    <div className="space-y-4">
      <div className="border rounded-lg divide-y">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm text-muted-foreground">App ID</span>
          <code className="text-sm font-mono">{app.id}</code>
        </div>
        {app.version && (
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">Version</span>
            <span className="text-sm">{app.version}</span>
          </div>
        )}
        {app.status && (
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">Status</span>
            <span className={`text-sm px-2 py-0.5 rounded-full text-xs font-medium ${
              app.status === "healthy" || app.status === "running"
                ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
            }`}>
              {app.status}
            </span>
          </div>
        )}
        {app.subdomain && (
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">Subdomain</span>
            <span className="text-sm font-mono">{app.subdomain}</span>
          </div>
        )}
        {appUrl && (
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">URL</span>
            <a
              href={appUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline flex items-center gap-1"
            >
              {appUrl}
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Link Handling Tab ── */

function LinkHandlingTab({
  linkHandlers,
  appName,
  appId,
  isAdmin,
  onRefresh,
}: {
  linkHandlers: LinkHandler[];
  appName: string;
  appId: string;
  isAdmin: boolean;
  onRefresh: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [formType, setFormType] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formTriggers, setFormTriggers] = useState("");
  const [formEndpoint, setFormEndpoint] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const formatType = (s: string) =>
    s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  async function handleAdd() {
    setError(null);
    const triggers = formTriggers
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (!formType.trim() || !formDesc.trim() || triggers.length === 0) {
      setError("Type, description, and at least one domain are required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/apps/${appId}/link-handlers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: formType.trim(),
          description: formDesc.trim(),
          endpoint: formEndpoint.trim() || undefined,
          triggers,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Failed to add handler");
        return;
      }
      setFormType("");
      setFormDesc("");
      setFormTriggers("");
      setFormEndpoint("");
      setShowForm(false);
      onRefresh();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(type: string) {
    setDeleting(type);
    try {
      await fetch(`/api/v1/apps/${appId}/link-handlers?type=${encodeURIComponent(type)}`, {
        method: "DELETE",
      });
      onRefresh();
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="space-y-4">
      {linkHandlers.length === 0 && !showForm ? (
        <div className="py-8 text-center border rounded-lg">
          <Link2 className="w-8 h-8 mx-auto mb-3 text-muted-foreground opacity-40" />
          <p className="text-sm text-muted-foreground">No link handlers configured</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
            Link handling lets apps intercept and rewrite URLs for supported domains.
          </p>
          {isAdmin && (
            <button
              onClick={() => setShowForm(true)}
              className="mt-4 text-xs font-medium text-primary hover:underline"
            >
              + Add link handler
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {`${appName} handles these link types:`}
            </p>
            {isAdmin && !showForm && (
              <button
                onClick={() => setShowForm(true)}
                className="text-xs font-medium text-primary hover:underline"
              >
                + Add handler
              </button>
            )}
          </div>

          {linkHandlers.map((handler) => (
            <div key={handler.type} className="border rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Link2 className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium">{formatType(handler.type)}</span>
                {isAdmin && (
                  <button
                    onClick={() => handleDelete(handler.type)}
                    disabled={deleting === handler.type}
                    className="ml-auto text-xs text-destructive hover:underline disabled:opacity-50 flex items-center gap-1"
                  >
                    {deleting === handler.type ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Trash2 className="w-3 h-3" />
                    )}
                    Remove
                  </button>
                )}
              </div>

              {handler.description && (
                <p className="text-xs text-muted-foreground">{handler.description}</p>
              )}

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Domains
                </p>
                {handler.triggers.map((trigger) => (
                  <div
                    key={trigger}
                    className="flex items-center gap-2 py-1.5 px-3 rounded-md bg-accent/30"
                  >
                    <Globe className="w-3.5 h-3.5 text-blue-500" />
                    <code className="text-sm font-mono">{trigger}</code>
                    <ExternalLink className="w-3 h-3 text-muted-foreground ml-auto" />
                  </div>
                ))}
              </div>

              {handler.endpoint && (
                <p className="text-[11px] text-muted-foreground font-mono">
                  Endpoint: {handler.endpoint}
                </p>
              )}

              <p className="text-[11px] text-muted-foreground">
                {`Links matching these domains will be opened in ${appName}.`}
              </p>
            </div>
          ))}
        </>
      )}

      {/* Add handler form */}
      {showForm && isAdmin && (
        <div className="border rounded-lg p-4 space-y-3 bg-accent/10">
          <p className="text-sm font-medium">Add Link Handler</p>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}

          <div className="space-y-2">
            <input
              type="text"
              placeholder="Handler type (e.g. video-streaming)"
              value={formType}
              onChange={(e) => setFormType(e.target.value)}
              className="w-full px-3 py-1.5 text-sm border rounded-md bg-background"
            />
            <input
              type="text"
              placeholder="Description (e.g. Opens video links in Cinema)"
              value={formDesc}
              onChange={(e) => setFormDesc(e.target.value)}
              className="w-full px-3 py-1.5 text-sm border rounded-md bg-background"
            />
            <input
              type="text"
              placeholder="Domains, comma-separated (e.g. youtube.com, vimeo.com)"
              value={formTriggers}
              onChange={(e) => setFormTriggers(e.target.value)}
              className="w-full px-3 py-1.5 text-sm border rounded-md bg-background"
            />
            <input
              type="text"
              placeholder="Endpoint path (optional, e.g. /watch)"
              value={formEndpoint}
              onChange={(e) => setFormEndpoint(e.target.value)}
              className="w-full px-3 py-1.5 text-sm border rounded-md bg-background"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleAdd}
              disabled={saving}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1"
            >
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              Save
            </button>
            <button
              onClick={() => { setShowForm(false); setError(null); }}
              className="px-3 py-1.5 text-xs font-medium rounded-md border hover:bg-accent"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Permissions Tab ── */

const PERMISSION_KEY_MAP: Record<string, string> = {
  "timeline:read": "timelineRead",
  "timeline:write": "timelineWrite",
  "settings:read": "settingsRead",
  "settings:write": "settingsWrite",
  "notifications:send": "notificationsSend",
  "user:profile": "userProfile",
  "apps:communicate": "appsCommunicate",
  "storage:read": "storageRead",
  "storage:write": "storageWrite",
};

function GrantTypeBadge({ type }: { type: string | null }) {
  if (!type) return null;
  const colors: Record<string, string> = {
    persistent: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    once: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    session: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${colors[type] ?? "bg-muted text-muted-foreground"}`}>
      {type}
    </span>
  );
}

function PermissionsTab({
  permissions,
  loading,
  appId,
  onRefresh,
}: {
  permissions: Permission[];
  loading: boolean;
  appId: string;
  onRefresh: () => void;
}) {
  const [revoking, setRevoking] = useState<string | null>(null);
  const tp = useTranslations("permissions");

  function getPermissionLabel(perm: string): string {
    const key = PERMISSION_KEY_MAP[perm];
    if (key) return tp(key as keyof typeof PERMISSION_KEY_MAP);
    return perm;
  }

  const revoke = async (permission: string) => {
    setRevoking(permission);
    try {
      const res = await fetch(`/api/v1/permissions/app/${encodeURIComponent(appId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permission }),
      });
      if (res.ok) onRefresh();
    } catch {
      // silent
    } finally {
      setRevoking(null);
    }
  };

  const revokeAll = async () => {
    setRevoking("all");
    try {
      const res = await fetch(`/api/v1/permissions/app/${encodeURIComponent(appId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) onRefresh();
    } catch {
      // silent
    } finally {
      setRevoking(null);
    }
  };

  if (loading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">{tp("loadingPermissions")}</div>;
  }

  if (permissions.length === 0) {
    return (
      <div className="py-8 text-center border rounded-lg">
        <ShieldCheck className="w-8 h-8 mx-auto mb-2 opacity-40 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No permissions granted for this app.</p>
      </div>
    );
  }

  const grantedCount = permissions.filter((p) => p.granted).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {grantedCount !== 1
            ? tp("permissionsGrantedPlural", { count: grantedCount })
            : tp("permissionsGranted", { count: grantedCount })}
        </p>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="p-2 rounded-md hover:bg-accent transition-colors text-muted-foreground"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="border rounded-lg divide-y">
        {permissions.map((p) => (
          <div
            key={`${p.appId}:${p.permission}`}
            className="flex items-center justify-between px-4 py-3"
          >
            <div className="flex items-center gap-2">
              {p.granted ? (
                <ShieldCheck className="w-4 h-4 text-green-500" />
              ) : (
                <ShieldX className="w-4 h-4 text-red-500" />
              )}
              <span className="text-sm">{getPermissionLabel(p.permission)}</span>
              <GrantTypeBadge type={p.grantType} />
            </div>
            <button
              onClick={() => revoke(p.permission)}
              disabled={revoking === p.permission}
              className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
              title={tp("revokePermission")}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>

      <button
        onClick={revokeAll}
        disabled={revoking === "all"}
        className="w-full py-2 text-xs text-destructive hover:bg-destructive/10 rounded-md transition-colors"
      >
        {tp("revokeAll")}
      </button>
    </div>
  );
}
