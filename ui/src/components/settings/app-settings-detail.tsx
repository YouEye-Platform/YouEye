/**
 * App Settings Detail — Per-app settings with consolidated tabs
 *
 * Four tabs:
 * 1. Overview — App info, status, version, subdomain
 * 2. Permissions — Per-app user permission management
 * 3. Network (admin only) — Bridges + internet grants for THIS app
 * 4. Link Handling — URL rewrite handlers
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
  ArrowRight,
  Info,
  Loader2,
  Check,
  X,
  Search,
  BookOpen,
  StickyNote,
  Film,
  CloudSun,
  Languages,
  Camera,
  MessageCircle,
  Cog,
  Monitor,
  Database,
  LayoutDashboard,
  Box,
  Server,
  Package,
} from "lucide-react";
import type { ComponentType } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/* ── Types ── */

interface AppInfo {
  id: string;
  name: string;
  icon: string | null;
  subdomain: string | null;
  version: string | null;
  status: string | null;
  containerUrl: string | null;
  updateAvailable?: boolean;
  updateInfo?: string | null;
  category?: string;
  description?: string;
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

interface Bridge {
  id: string;
  from: string;
  to: string;
  direction: string;
  active: boolean;
  aclName?: string;
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

/* ── Lucide Icon Map ── */

const DETAIL_ICON_MAP: Record<string, ComponentType<{ className?: string }>> = {
  search: Search,
  "book-open": BookOpen,
  "sticky-note": StickyNote,
  film: Film,
  "cloud-sun": CloudSun,
  languages: Languages,
  camera: Camera,
  "message-circle": MessageCircle,
  package: Package,
  cog: Cog,
  monitor: Monitor,
  database: Database,
  "shield-check": ShieldCheck,
  globe: Globe,
  shield: Shield,
  "layout-dashboard": LayoutDashboard,
  box: Box,
  server: Server,
};

function toKebabCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function DetailAppIcon({ icon, name }: { icon: string | null; name: string }) {
  if (icon && icon.startsWith("emoji:")) {
    return <span className="text-xl leading-none">{icon.slice(6)}</span>;
  }
  if (icon && (icon.startsWith("http") || icon.startsWith("/"))) {
    return <img src={icon} alt={name} className="w-10 h-10 rounded-xl object-cover" />;
  }
  if (icon) {
    const key = toKebabCase(icon);
    const IconComponent = DETAIL_ICON_MAP[key];
    if (IconComponent) {
      return <IconComponent className="w-5 h-5 text-primary" />;
    }
  }
  return <span className="text-sm font-bold text-primary">{name.charAt(0).toUpperCase()}</span>;
}

/* ── Tab type ── */

type TabId = "overview" | "permissions" | "network" | "link-handling";

/* ── Main Component ── */

export function AppSettingsDetail({
  appId,
  isAdmin: isAdminProp,
}: {
  appId: string;
  directAccessEmbedUrl?: string;
  isAdmin: boolean;
}) {
  const [app, setApp] = useState<AppInfo | null>(null);
  const [linkHandlers, setLinkHandlers] = useState<LinkHandler[]>([]);
  const [isAdmin] = useState(isAdminProp);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [permissionsLoading, setPermissionsLoading] = useState(false);
  const router = useRouter();
  const t = useTranslations("common");
  const tp = useTranslations("permissions");

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch from unified API to get versions + update info
      const res = await fetch("/api/v1/apps/unified");
      if (res.ok) {
        const data = await res.json();
        const allApps = data.apps ?? [];
        const allSystem = data.systemApps ?? [];
        // Search both user apps and system components
        const foundApp = allApps.find((a: AppInfo) => a.id === appId);
        const foundSystem = allSystem.find((a: { id: string; name: string; icon: string; status: string; version: string | null; updateAvailable: boolean; updateInfo: string | null; category: string; description: string }) => a.id === appId);
        if (foundApp) {
          setApp(foundApp);
        } else if (foundSystem) {
          setApp({
            id: foundSystem.id,
            name: foundSystem.name,
            icon: foundSystem.icon,
            subdomain: null,
            version: foundSystem.version,
            status: foundSystem.status,
            containerUrl: null,
            updateAvailable: foundSystem.updateAvailable,
            updateInfo: foundSystem.updateInfo,
            category: foundSystem.category,
            description: foundSystem.description,
          });
        } else {
          setApp({ id: appId, name: appId, icon: null, subdomain: null, version: null, status: null, containerUrl: null });
        }
      } else {
        setApp({ id: appId, name: appId, icon: null, subdomain: null, version: null, status: null, containerUrl: null });
      }
      setLinkHandlers([]);
    } finally {
      setLoading(false);
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

  useEffect(() => {
    if (activeTab === "permissions") {
      fetchPermissions();
    }
  }, [activeTab, fetchPermissions]);

  if (loading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">{t("loading")}</div>;
  }

  if (!app) {
    return <div className="py-8 text-center text-sm text-muted-foreground">App not found</div>;
  }

  const tabs: { id: TabId; label: string; icon: React.ReactNode; adminOnly?: boolean }[] = [
    { id: "overview", label: "Overview", icon: <Info className="w-4 h-4" /> },
    { id: "permissions", label: "Permissions", icon: <Shield className="w-4 h-4" /> },
    { id: "network", label: "Network", icon: <Globe className="w-4 h-4" />, adminOnly: true },
    { id: "link-handling", label: "Link Handling", icon: <Link2 className="w-4 h-4" /> },
  ];

  const visibleTabs = tabs.filter((tab) => !tab.adminOnly || isAdmin);

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
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <DetailAppIcon icon={app.icon} name={app.name} />
        </div>
        <div>
          <h2 className="text-xl font-semibold">{app.name}</h2>
          <p className="text-sm text-muted-foreground">
            {app.description || "Manage app settings and permissions"}
          </p>
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
      {activeTab === "overview" && <OverviewTab app={app} isAdmin={isAdmin} />}

      {activeTab === "permissions" && (
        <PermissionsTab
          permissions={permissions}
          loading={permissionsLoading}
          appId={appId}
          onRefresh={fetchPermissions}
        />
      )}

      {activeTab === "network" && isAdmin && <NetworkTab appId={appId} />}

      {activeTab === "link-handling" && <LinkHandlingTab linkHandlers={linkHandlers} appName={app?.name ?? appId} />}
    </div>
  );
}

/* ── Overview Tab ── */

function OverviewTab({ app, isAdmin }: { app: AppInfo; isAdmin: boolean }) {
  const domain = typeof window !== "undefined" ? window.location.hostname : "";
  const appUrl = app.subdomain ? `https://${app.subdomain}.${domain}` : null;
  const [updating, setUpdating] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  async function handleUpdate() {
    setUpdating(true);
    setUpdateStatus(null);
    try {
      const res = await fetch("/api/v1/admin/proxy-cp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: `/api/apps/${app.id}/enqueue`,
          method: "POST",
        }),
      });
      if (res.ok) {
        setUpdateStatus({ ok: true, message: "Update queued successfully" });
      } else {
        const data = await res.json().catch(() => ({}));
        setUpdateStatus({ ok: false, message: data.error ?? "Failed to queue update" });
      }
    } catch {
      setUpdateStatus({ ok: false, message: "Failed to reach server" });
    } finally {
      setUpdating(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Update banner */}
      {app.updateAvailable && isAdmin && (
        <div className="flex items-center justify-between rounded-lg border border-blue-200 dark:border-blue-800/40 bg-blue-50/50 dark:bg-blue-950/20 px-4 py-3">
          <div className="flex items-center gap-2">
            <ArrowLeft className="w-4 h-4 text-blue-500 rotate-90" />
            <div>
              <p className="text-sm font-medium">Update available</p>
              {app.updateInfo && (
                <p className="text-xs text-muted-foreground">{app.updateInfo}</p>
              )}
            </div>
          </div>
          <button
            onClick={handleUpdate}
            disabled={updating}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
          >
            {updating ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            Update Now
          </button>
        </div>
      )}

      {updateStatus && (
        <div
          className={`px-4 py-2 rounded-lg text-sm ${
            updateStatus.ok
              ? "bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300"
              : "bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-300"
          }`}
        >
          {updateStatus.message}
        </div>
      )}

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
        {app.category && (
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">Category</span>
            <span className="text-sm capitalize">{app.category}</span>
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
        {app.description && (
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">Description</span>
            <span className="text-sm text-right max-w-xs">{app.description}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Network Tab (admin only) ── */

function NetworkTab({ appId }: { appId: string }) {
  const [bridges, setBridges] = useState<Bridge[]>([]);
  const [grants, setGrants] = useState<InternetGrant[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState<string | null>(null);

  const fetchNetwork = useCallback(async () => {
    setLoading(true);
    try {
      const [bridgesRes, grantsRes, suggestionsRes] = await Promise.all([
        fetch(`/api/v1/admin/proxy-cp?path=${encodeURIComponent(`/api/bridges?appId=${appId}`)}`),
        fetch(`/api/v1/admin/proxy-cp?path=${encodeURIComponent("/api/internet-grants")}`),
        fetch(`/api/v1/admin/proxy-cp?path=${encodeURIComponent("/api/suggestions")}`),
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
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    fetchNetwork();
  }, [fetchNetwork]);

  async function revokeBridge(id: string) {
    const res = await fetch("/api/v1/admin/proxy-cp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: `/api/bridges/${id}`, method: "DELETE" }),
    });
    if (res.ok) {
      setBridges(bridges.filter((b) => b.id !== id));
    }
  }

  async function revokeGrant(id: string) {
    const res = await fetch("/api/v1/admin/proxy-cp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: `/api/internet-grants/${id}`, method: "DELETE" }),
    });
    if (res.ok) {
      setGrants(grants.filter((g) => g.id !== id));
    }
  }

  async function approveSuggestion(suggestion: Suggestion) {
    setApproving(suggestion.id);
    try {
      const res = await fetch("/api/v1/admin/proxy-cp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/api/suggestions/approve",
          method: "POST",
          body: { suggestionId: suggestion.id },
        }),
      });
      if (res.ok) {
        setSuggestions(suggestions.filter((s) => s.id !== suggestion.id));
        // Refresh to pick up the new bridge
        fetchNetwork();
      }
    } catch {
      // silent
    } finally {
      setApproving(null);
    }
  }

  async function dismissSuggestion(id: string) {
    const res = await fetch("/api/v1/admin/proxy-cp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: `/api/suggestions/${id}/dismiss`,
        method: "POST",
      }),
    });
    if (res.ok) {
      setSuggestions(suggestions.filter((s) => s.id !== id));
    }
  }

  if (loading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading network info...
      </div>
    );
  }

  const activeBridges = bridges.filter((b) => b.active);
  const activeGrants = grants.filter((g) => g.active);

  return (
    <div className="space-y-6">
      {/* Pending Suggestions */}
      {suggestions.length > 0 && (
        <section>
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Pending Connections
          </h3>
          <div className="space-y-2">
            {suggestions.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 p-3"
              >
                <div className="flex items-center gap-2">
                  <Link2 className="h-4 w-4 text-amber-500" />
                  <div>
                    <div className="flex items-center gap-1">
                      <span className="font-medium text-sm">{s.fromAppName}</span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <span className="font-medium text-sm">{s.targetAppName || "Internet"}</span>
                    </div>
                    {s.type === "internet" && s.hosts && (
                      <span className="text-xs text-muted-foreground">
                        Hosts: {s.hosts.join(", ")}
                      </span>
                    )}
                    {s.targetInstalled === false && (
                      <span className="text-xs text-amber-600 dark:text-amber-400">
                        Target not installed yet
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => approveSuggestion(s)}
                    disabled={approving === s.id}
                    className="text-xs text-green-600 hover:underline flex items-center gap-1 disabled:opacity-50"
                  >
                    {approving === s.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Check className="h-3 w-3" />
                    )}
                    Approve
                  </button>
                  <button
                    onClick={() => dismissSuggestion(s.id)}
                    className="text-xs text-muted-foreground hover:underline flex items-center gap-1"
                  >
                    <X className="h-3 w-3" /> Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Bridges */}
      <section>
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
          App Connections (Bridges)
        </h3>
        {activeBridges.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 border rounded-lg text-center">
            No active bridges for this app.
          </p>
        ) : (
          <div className="space-y-2">
            {activeBridges.map((b) => (
              <div
                key={b.id}
                className="flex items-center justify-between rounded-lg border bg-card p-3"
              >
                <div className="flex items-center gap-2">
                  <Link2 className="h-4 w-4 text-green-500" />
                  <span className="font-medium">{b.from}</span>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  <span className="font-medium">{b.to}</span>
                  <span className="text-xs text-muted-foreground ml-2">
                    {b.direction === "both-ways" ? "both ways" : "one-way"}
                  </span>
                </div>
                <button
                  onClick={() => revokeBridge(b.id)}
                  className="text-xs text-destructive hover:underline flex items-center gap-1"
                >
                  <Trash2 className="h-3 w-3" /> Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Internet Grants */}
      <section>
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
          Internet Access
        </h3>
        {activeGrants.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 border rounded-lg text-center">
            No internet access granted for this app.
          </p>
        ) : (
          <div className="space-y-2">
            {activeGrants.map((g) => (
              <div
                key={g.id}
                className="flex items-center justify-between rounded-lg border bg-card p-3"
              >
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4 text-blue-500" />
                  <span className="text-sm">
                    {g.blanket
                      ? "All internet access"
                      : `${g.hosts.length} host${g.hosts.length !== 1 ? "s" : ""}: ${g.hosts.join(", ")}`}
                  </span>
                </div>
                <button
                  onClick={() => revokeGrant(g.id)}
                  className="text-xs text-destructive hover:underline flex items-center gap-1"
                >
                  <Trash2 className="h-3 w-3" /> Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ── Link Handling Tab ── */

function LinkHandlingTab({ linkHandlers, appName }: { linkHandlers: LinkHandler[]; appName: string }) {
  const t = useTranslations("common");

  if (linkHandlers.length === 0) {
    return (
      <div className="py-8 text-center border rounded-lg">
        <Link2 className="w-8 h-8 mx-auto mb-3 text-muted-foreground opacity-40" />
        <p className="text-sm text-muted-foreground">No link handlers configured</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
          Link handling lets apps intercept and rewrite URLs for supported domains.
        </p>
      </div>
    );
  }

  const formatType = (s: string) =>
    s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {`${appName} handles these link types:`}
      </p>

      {linkHandlers.map((handler) => (
        <div key={handler.type} className="border rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium">{formatType(handler.type)}</span>
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

          <p className="text-[11px] text-muted-foreground">
            {`Links matching these domains will be opened in ${appName}.`}
          </p>
        </div>
      ))}
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
  const t = useTranslations("common");
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
