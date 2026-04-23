/**
 * App Settings Detail — Tabbed per-app settings page
 *
 * Three tabs:
 * 1. Data Sources — connector capability management (from connector-detail.tsx)
 * 2. Link Handling — placeholder for link rewrite system (Session C)
 * 3. Permissions — per-app permission management
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ArrowLeft,
  Plug,
  Link2,
  Globe,
  ExternalLink,
  Shield,
  ShieldCheck,
  ShieldX,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CapabilityRow } from "./connector-detail";

/* ── Types ── */

interface ConfigField {
  name: string;
  label: string;
  type: string;
  required: boolean;
  managed?: boolean;
}

interface Backend {
  appId: string;
  appName: string;
  installed: boolean;
  internalUrl: string | null;
}

interface AvailableConnector {
  id: string;
  name: string;
  icon: string;
  logoUrl: string | null;
  network: string;
  authMethod: string;
  authProvider?: string;
  authProviderName?: string;
  authProviderConnected?: boolean;
  configFields: ConfigField[];
  credentialsConfigured: boolean;
  backends: Backend[];
  available: boolean;
  hasCompatibleApps: boolean;
  isDefault: boolean;
  customUrl: string | null;
}

interface Connection {
  id: string;
  connectorId: string;
  persistent: boolean;
}

interface Capability {
  capability: string;
  multiple: boolean;
  availableConnectors: AvailableConnector[];
  connections: Connection[];
}

interface AppInfo {
  id: string;
  name: string;
  icon: string | null;
  subdomain: string | null;
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

type TabId = "data-sources" | "link-handling" | "permissions";

/* ── Main Component ── */

export function AppSettingsDetail({
  appId,
  directAccessEmbedUrl,
  isAdmin: isAdminProp,
}: {
  appId: string;
  directAccessEmbedUrl?: string;
  isAdmin: boolean;
}) {
  const [app, setApp] = useState<AppInfo | null>(null);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [linkHandlers, setLinkHandlers] = useState<LinkHandler[]>([]);
  const [isAdmin, setIsAdmin] = useState(isAdminProp);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>("data-sources");
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [permissionsLoading, setPermissionsLoading] = useState(false);
  const router = useRouter();
  const t = useTranslations("connectorSettings");
  const tp = useTranslations("permissions");

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/settings/connectors/${appId}`);
      if (res.ok) {
        const data = await res.json();
        setApp(data.app);
        setCapabilities(data.capabilities);
        setLinkHandlers(data.linkHandlers ?? []);
        setIsAdmin(data.isAdmin);
      }
    } catch {
      // silent
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

  const connect = async (capability: string, connectorId: string, config?: Record<string, unknown>) => {
    await fetch(`/api/settings/connectors/${appId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "connect", capability, connectorId, persistent: true, config }),
    });
    fetchDetail();
  };

  const disconnect = async (capability: string, connectorId?: string) => {
    await fetch(`/api/settings/connectors/${appId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "disconnect", capability, connectorId }),
    });
    fetchDetail();
  };

  if (loading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">{t("loading")}</div>;
  }

  if (!app) {
    return <div className="py-8 text-center text-sm text-muted-foreground">{t("appNotFound")}</div>;
  }

  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: "data-sources", label: t("tabDataSources"), icon: <Plug className="w-4 h-4" /> },
    { id: "link-handling", label: t("tabLinkHandling"), icon: <Link2 className="w-4 h-4" /> },
    { id: "permissions", label: t("tabPermissions"), icon: <Shield className="w-4 h-4" /> },
  ];

  return (
    <div className="space-y-6">
      {/* Back link */}
      <button
        onClick={() => router.push("/settings/apps")}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        {t("backToList")}
      </button>

      {/* App header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <span className="text-sm font-bold text-primary">
            {app.name.charAt(0).toUpperCase()}
          </span>
        </div>
        <div>
          <h2 className="text-xl font-semibold">{app.name}</h2>
          <p className="text-sm text-muted-foreground">{t("manageConnections")}</p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="border-b">
        <nav className="flex gap-6" aria-label="App settings tabs">
          {tabs.map((tab) => (
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
      {activeTab === "data-sources" && (
        <DataSourcesTab
          capabilities={capabilities}
          isAdmin={isAdmin}
          onConnect={connect}
          onDisconnect={disconnect}
          onRefresh={fetchDetail}
          directAccessEmbedUrl={directAccessEmbedUrl}
          appId={appId}
        />
      )}

      {activeTab === "link-handling" && <LinkHandlingTab linkHandlers={linkHandlers} appName={app?.name ?? appId} />}

      {activeTab === "permissions" && (
        <PermissionsTab
          permissions={permissions}
          loading={permissionsLoading}
          appId={appId}
          onRefresh={fetchPermissions}
        />
      )}
    </div>
  );
}

/* ── Data Sources Tab ── */
/* Delegates to ConnectorDetail which has the full dual-mode UI, logos, and availability filtering */

function DataSourcesTab({
  directAccessEmbedUrl,
  appId,
}: {
  capabilities: Capability[];
  isAdmin: boolean;
  onConnect: (capability: string, connectorId: string, config?: Record<string, unknown>) => void;
  onDisconnect: (capability: string, connectorId?: string) => void;
  onRefresh: () => void;
  directAccessEmbedUrl?: string;
  appId: string;
}) {
  return <ConnectorDetailInner appId={appId} directAccessEmbedUrl={directAccessEmbedUrl} />;
}

/* Inline version of ConnectorDetail for the tabbed view (no back button/header) */
function ConnectorDetailInner({ appId, directAccessEmbedUrl }: { appId: string; directAccessEmbedUrl?: string }) {
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const t = useTranslations("connectorSettings");

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/settings/connectors/${appId}`);
      if (res.ok) {
        const data = await res.json();
        setCapabilities(data.capabilities);
        setIsAdmin(data.isAdmin);
      }
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [appId]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  const connect = async (capability: string, connectorId: string, config?: Record<string, unknown>) => {
    await fetch(`/api/settings/connectors/${appId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "connect", capability, connectorId, persistent: true, config }),
    });
    fetchDetail();
  };

  const disconnect = async (capability: string, connectorId?: string) => {
    await fetch(`/api/settings/connectors/${appId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "disconnect", capability, connectorId }),
    });
    fetchDetail();
  };

  if (loading) return <div className="py-4 text-center text-sm text-muted-foreground">{t("loading")}</div>;

  return (
    <div className="space-y-4">
      {capabilities.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground border rounded-lg">
          <Plug className="w-8 h-8 mx-auto mb-2 opacity-40" />
          {t("noCapabilities")}
        </div>
      ) : (
        <>
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            {t("connections")}
          </h3>
          {capabilities.map((cap) => (
            <CapabilityRow
              key={cap.capability}
              cap={cap}
              appId={appId}
              isAdmin={isAdmin}
              onConnect={connect}
              onDisconnect={disconnect}
              onRefresh={fetchDetail}
            />
          ))}
        </>
      )}

      {isAdmin && (
        <div className="border-t pt-6">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">
            {t("directAccess")}
          </h3>
          <p className="text-sm text-muted-foreground mb-3">
            {t("directAccessDescription")}
          </p>
          <iframe
            src={directAccessEmbedUrl || `${typeof window !== "undefined" ? window.location.origin : ""}/control/embed/app-network/${appId}`}
            style={{ width: "100%", minHeight: 200, border: "1px solid hsl(var(--border))", borderRadius: 8, background: "transparent" }}
            title="App Network Bridges"
            sandbox="allow-scripts allow-same-origin allow-forms"
          />
        </div>
      )}
    </div>
  );
}

/* ── Link Handling Tab ── */

function LinkHandlingTab({ linkHandlers, appName }: { linkHandlers: LinkHandler[]; appName: string }) {
  const t = useTranslations("connectorSettings");

  if (linkHandlers.length === 0) {
    return (
      <div className="py-8 text-center border rounded-lg">
        <Link2 className="w-8 h-8 mx-auto mb-3 text-muted-foreground opacity-40" />
        <p className="text-sm text-muted-foreground">{t("linkHandlingEmpty")}</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
          {t("linkHandlingDescription")}
        </p>
      </div>
    );
  }

  const formatType = (s: string) =>
    s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("linkHandlingActive", { appName })}
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
              {t("linkHandlingDomains")}
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
            {t("linkHandlingExplanation", { appName })}
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
  const t = useTranslations("connectorSettings");
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
        <p className="text-sm text-muted-foreground">{t("permissionsEmpty")}</p>
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

