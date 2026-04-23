"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ArrowLeft,
  Plug,
  PlugZap,
  RefreshCw,
  Plus,
  X,
  Eye,
  EyeOff,
  Check,
  AlertTriangle,
  Globe,
  Server,
  Key,
  Download,
  ExternalLink,
  Loader2,
  CheckCircle2,
  XCircle,
  Star,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

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

/* ── Connector Logo ── */

function ConnectorLogo({ connector, size = 20 }: { connector: { name: string; icon: string; logoUrl?: string | null }; size?: number }) {
  const [imgError, setImgError] = useState(false);
  if (connector.logoUrl && !imgError) {
    return (
      <img
        src={connector.logoUrl}
        alt={connector.name}
        width={size}
        height={size}
        className="rounded-sm object-contain"
        onError={() => setImgError(true)}
      />
    );
  }
  return (
    <span
      className="inline-flex items-center justify-center rounded-sm bg-muted text-[10px] font-bold"
      style={{ width: size, height: size }}
    >
      {connector.name.charAt(0).toUpperCase()}
    </span>
  );
}

/* ── Credential Entry ── */

interface CredentialEntryProps {
  connectorId: string;
  field: ConfigField;
  onSaved: () => void;
}

function CredentialEntry({ connectorId, field, onSaved }: CredentialEntryProps) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const t = useTranslations("connectorSettings");

  const save = async () => {
    if (!value.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/settings/connectors/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectorId,
          key: field.name,
          value: value.trim(),
          boundHost: null,
        }),
      });
      if (res.ok) {
        setSaved(true);
        setValue("");
        onSaved();
        setTimeout(() => setSaved(false), 2000);
      }
    } catch {
      // silent
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-2 mt-2">
      <div className="flex-1 relative">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={field.label || field.name}
          className="w-full px-3 py-1.5 text-sm border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring pr-8"
        />
        <button
          type="button"
          onClick={() => setShow(!show)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </div>
      <button
        onClick={save}
        disabled={saving || !value.trim()}
        className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1"
      >
        {saved ? <Check className="w-3.5 h-3.5" /> : <Key className="w-3.5 h-3.5" />}
        {saved ? t("saved") : t("save")}
      </button>
    </div>
  );
}

/* ── Dual Mode Connector Picker ── */

function DualModePicker({
  connector,
  capability,
  appId,
  isAdmin,
  onConnect,
  onCancel,
}: {
  connector: AvailableConnector;
  capability: string;
  appId: string;
  isAdmin: boolean;
  onConnect: (capability: string, connectorId: string, config?: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"internal" | "external">(
    connector.backends.some((b) => b.installed) ? "internal" : "external"
  );
  const [customUrl, setCustomUrl] = useState(connector.customUrl ?? "");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const t = useTranslations("connectorSettings");

  const installedBackend = connector.backends.find((b) => b.installed);
  const hasInternalOption = connector.hasCompatibleApps;

  const testConnection = async () => {
    if (!customUrl.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/settings/connectors/${appId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test-connection", url: customUrl.trim() }),
      });
      const data = await res.json();
      setTestResult({ ok: data.reachable, error: data.error });
    } catch {
      setTestResult({ ok: false, error: "Request failed" });
    } finally {
      setTesting(false);
    }
  };

  const connectInternal = () => {
    onConnect(capability, connector.id, {});
  };

  const connectExternal = () => {
    if (!customUrl.trim()) return;
    onConnect(capability, connector.id, { customUrl: customUrl.trim() });
  };

  // If no compatible apps, skip dual mode — just connect directly
  if (!hasInternalOption) {
    return null;
  }

  return (
    <div className="border rounded-lg p-4 mt-2 space-y-3 bg-card">
      <div className="flex items-center gap-2 mb-2">
        <ConnectorLogo connector={connector} size={24} />
        <span className="font-medium text-sm">{connector.name}</span>
      </div>

      {/* Internal mode */}
      <label className="flex items-start gap-3 p-3 rounded-md border cursor-pointer hover:bg-accent/30 transition-colors">
        <input
          type="radio"
          name={`mode-${connector.id}`}
          checked={mode === "internal"}
          onChange={() => setMode("internal")}
          className="mt-0.5"
        />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-green-500" />
            <span className="text-sm font-medium">{t("useOnServer")}</span>
          </div>
          {installedBackend ? (
            <div className="mt-1 flex items-center gap-1.5 text-xs text-green-600">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {installedBackend.appName} {t("installed")}
            </div>
          ) : isAdmin ? (
            <div className="mt-1 flex items-center gap-1.5 text-xs text-amber-600">
              <Download className="w-3.5 h-3.5" />
              {connector.backends[0]?.appName ?? connector.name} {t("notInstalled")}
              <button
                onClick={(e) => { e.preventDefault(); window.open("/settings/market", "_blank"); }}
                className="text-primary underline ml-1"
              >
                {t("installFromMarket")}
              </button>
            </div>
          ) : (
            <div className="mt-1 text-xs text-muted-foreground">
              {t("askAdminToInstall")}
            </div>
          )}
        </div>
      </label>

      {/* External mode */}
      <label className="flex items-start gap-3 p-3 rounded-md border cursor-pointer hover:bg-accent/30 transition-colors">
        <input
          type="radio"
          name={`mode-${connector.id}`}
          checked={mode === "external"}
          onChange={() => setMode("external")}
          className="mt-0.5"
        />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-blue-500" />
            <span className="text-sm font-medium">{t("useYourOwn")}</span>
          </div>
          {mode === "external" && (
            <div className="mt-2 space-y-2">
              <input
                type="url"
                value={customUrl}
                onChange={(e) => { setCustomUrl(e.target.value); setTestResult(null); }}
                placeholder="https://searx.example.com"
                className="w-full px-3 py-1.5 text-sm border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                onClick={(e) => e.stopPropagation()}
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={(e) => { e.preventDefault(); testConnection(); }}
                  disabled={testing || !customUrl.trim()}
                  className="px-3 py-1 text-xs border rounded-md hover:bg-accent disabled:opacity-50 flex items-center gap-1"
                >
                  {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <ExternalLink className="w-3 h-3" />}
                  {t("testConnection")}
                </button>
                {testResult && (
                  <span className={`text-xs flex items-center gap-1 ${testResult.ok ? "text-green-600" : "text-red-500"}`}>
                    {testResult.ok ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                    {testResult.ok ? t("reachable") : (testResult.error || t("unreachable"))}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </label>

      {/* Action buttons */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => mode === "internal" ? connectInternal() : connectExternal()}
          disabled={mode === "internal" ? !installedBackend : !customUrl.trim()}
          className="px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
        >
          {t("connect")}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}

/* ── Main Export ── */

export function ConnectorDetail({ appId, directAccessEmbedUrl }: { appId: string; directAccessEmbedUrl?: string }) {
  const [app, setApp] = useState<AppInfo | null>(null);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const t = useTranslations("connectorSettings");

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/settings/connectors/${appId}`);
      if (res.ok) {
        const data = await res.json();
        setApp(data.app);
        setCapabilities(data.capabilities);
        setIsAdmin(data.isAdmin);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const connect = async (capability: string, connectorId: string, config?: Record<string, unknown>) => {
    await fetch(`/api/settings/connectors/${appId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "connect",
        capability,
        connectorId,
        persistent: true,
        config,
      }),
    });
    fetchDetail();
  };

  const disconnect = async (capability: string, connectorId?: string) => {
    await fetch(`/api/settings/connectors/${appId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "disconnect",
        capability,
        connectorId,
      }),
    });
    fetchDetail();
  };

  if (loading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        {t("loading")}
      </div>
    );
  }

  if (!app) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        {t("appNotFound")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <button
        onClick={() => router.push("/settings/apps")}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        {t("backToList")}
      </button>

      <div>
        <h2 className="text-xl font-semibold">{app.name}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t("manageConnections")}
        </p>
      </div>

      {capabilities.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground border rounded-lg">
          <Plug className="w-8 h-8 mx-auto mb-2 opacity-40" />
          {t("noCapabilities")}
        </div>
      ) : (
        <div className="space-y-4">
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
        </div>
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
            style={{
              width: "100%",
              minHeight: 200,
              border: "1px solid hsl(var(--border))",
              borderRadius: 8,
              background: "transparent",
            }}
            title="App Network Bridges"
            sandbox="allow-scripts allow-same-origin allow-forms"
          />
        </div>
      )}
    </div>
  );
}

/* ── Capability Row ── */

export function CapabilityRow({
  cap,
  appId,
  isAdmin,
  onConnect,
  onDisconnect,
  onRefresh,
}: {
  cap: Capability;
  appId: string;
  isAdmin: boolean;
  onConnect: (capability: string, connectorId: string, config?: Record<string, unknown>) => void;
  onDisconnect: (capability: string, connectorId?: string) => void;
  onRefresh: () => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const [dualModeConnector, setDualModeConnector] = useState<AvailableConnector | null>(null);
  const t = useTranslations("connectorSettings");

  const connectedIds = new Set(cap.connections.map((c) => c.connectorId));
  const hasConnection = cap.connections.length > 0;

  const formatCapability = (s: string) =>
    s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  // Filter connectors: show available ones + already-connected ones
  // For non-admin: hide unavailable local connectors from picker
  const pickableConnectors = cap.availableConnectors.filter((c) => {
    if (connectedIds.has(c.id)) return false; // already connected
    if (c.available) return true;
    // Unavailable local connector — only show to admins
    return isAdmin;
  });

  const handlePickerSelect = (connector: AvailableConnector) => {
    // If connector has compatible apps (dual mode), show the mode picker
    if (connector.hasCompatibleApps) {
      setDualModeConnector(connector);
      setShowPicker(false);
      return;
    }
    // Otherwise connect directly
    onConnect(cap.capability, connector.id);
    setShowPicker(false);
  };

  return (
    <div className="border rounded-lg p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {hasConnection ? (
            <PlugZap className="w-4 h-4 text-green-500" />
          ) : (
            <Plug className="w-4 h-4 text-muted-foreground" />
          )}
          <span className="text-sm font-medium">{formatCapability(cap.capability)}</span>
        </div>

        {!cap.multiple && hasConnection ? (
          <button
            onClick={() => onDisconnect(cap.capability)}
            className="text-xs text-destructive hover:underline"
          >
            {t("disconnect")}
          </button>
        ) : null}
      </div>

      {hasConnection && (
        <div className="mt-2 space-y-1.5">
          {cap.connections.map((conn) => {
            const connector = cap.availableConnectors.find((c) => c.id === conn.connectorId);
            const isUnavailable = connector && !connector.available;

            return (
              <div
                key={conn.id}
                className={`flex items-center justify-between py-1.5 px-3 rounded-md ${
                  isUnavailable ? "bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800" : "bg-accent/30"
                }`}
              >
                <div className="flex items-center gap-2">
                  {connector && <ConnectorLogo connector={connector} size={18} />}
                  <span className="text-sm">
                    {connector?.name ?? conn.connectorId}
                  </span>
                  {/* Internal/External badge */}
                  {connector && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-0.5 ${
                      connector.customUrl
                        ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                        : connector.network === "internet"
                          ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                          : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                    }`}>
                      {connector.customUrl ? t("custom") : connector.network === "internet" ? t("external") : t("internal")}
                    </span>
                  )}
                  {/* Default badge */}
                  {connector?.isDefault && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 flex items-center gap-0.5">
                      <Star className="w-2.5 h-2.5" />
                      {t("default")}
                    </span>
                  )}
                  {/* Custom URL display */}
                  {connector?.customUrl && (
                    <span className="text-[10px] text-muted-foreground truncate max-w-[200px]">
                      {connector.customUrl}
                    </span>
                  )}
                  {/* Backend status for internal connectors */}
                  {connector && !connector.customUrl && connector.network === "local" && connector.backends.length > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      {connector.backends.some((b) => b.installed)
                        ? `(${connector.backends.find((b) => b.installed)?.appName})`
                        : ""
                      }
                    </span>
                  )}
                  {/* Unavailable warning */}
                  {isUnavailable && (
                    <span className="text-xs text-red-500 flex items-center gap-0.5">
                      <AlertTriangle className="w-3 h-3" />
                      {t("backendUnavailable")}
                    </span>
                  )}
                  {connector && !isUnavailable && !connector.credentialsConfigured && (
                    <span className="text-xs text-amber-600 flex items-center gap-0.5">
                      <AlertTriangle className="w-3 h-3" />
                      {t("needsApiKey")}
                    </span>
                  )}
                </div>
                {cap.multiple && (
                  <button
                    onClick={() => onDisconnect(cap.capability, conn.connectorId)}
                    className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}

          {/* Credential entry for connected connectors that need keys */}
          {cap.connections.map((conn) => {
            const connector = cap.availableConnectors.find((c) => c.id === conn.connectorId);
            if (!connector || connector.credentialsConfigured) return null;

            const hasManagedFields = connector.configFields.some(
              (f) => f.managed && f.required
            );
            const manualFields = connector.configFields.filter(
              (f) => f.required && f.type === "secret" && !f.managed
            );

            if (!hasManagedFields && manualFields.length === 0) return null;

            return (
              <div key={`cred-${conn.id}`} className="mt-2 pl-3 border-l-2 border-amber-300">
                {hasManagedFields && connector.authProvider && !connector.authProviderConnected && (
                  <div className="mb-2">
                    <a
                      href={`/api/auth/providers/${connector.authProvider}?redirect_uri=${encodeURIComponent(typeof window !== "undefined" ? window.location.pathname : "/")}`}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
                    >
                      <Key className="w-4 h-4" />
                      {t("signInWith")} {connector.authProviderName || connector.authProvider}
                    </a>
                  </div>
                )}
                {hasManagedFields && connector.authProviderConnected && (
                  <div className="mb-2 flex items-center gap-1.5 text-sm text-green-600">
                    <Check className="w-4 h-4" />
                    {connector.authProviderName || connector.authProvider} {t("connected")}
                  </div>
                )}
                {manualFields.length > 0 && (
                  <>
                    <p className="text-xs text-muted-foreground mb-1">{t("enterCredentials")}</p>
                    {manualFields.map((field) => (
                      <CredentialEntry
                        key={field.name}
                        connectorId={conn.connectorId}
                        field={field}
                        onSaved={onRefresh}
                      />
                    ))}
                  </>
                )}
                {/* Manage in Accounts link */}
                <a
                  href="/settings/accounts"
                  className="text-xs text-primary hover:underline flex items-center gap-1 mt-2"
                >
                  <Key className="w-3 h-3" />
                  {t("manageInAccounts")}
                </a>
              </div>
            );
          })}
        </div>
      )}

      {/* Dual mode picker (shown when user clicks a connector with compatible apps) */}
      {dualModeConnector && (
        <DualModePicker
          connector={dualModeConnector}
          capability={cap.capability}
          appId={appId}
          isAdmin={isAdmin}
          onConnect={(capability, connectorId, config) => {
            onConnect(capability, connectorId, config);
            setDualModeConnector(null);
          }}
          onCancel={() => setDualModeConnector(null)}
        />
      )}

      {/* Picker for new connections */}
      {(!hasConnection || cap.multiple) && !dualModeConnector && (
        <div className="mt-2">
          {showPicker ? (
            <div className="space-y-1.5">
              {pickableConnectors.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">{t("noConnectorsAvailable")}</p>
              ) : (
                pickableConnectors.map((connector) => (
                  <button
                    key={connector.id}
                    onClick={() => handlePickerSelect(connector)}
                    disabled={!connector.available && !isAdmin}
                    className="w-full flex items-center justify-between py-2 px-3 rounded-md border hover:bg-accent/50 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div className="flex items-center gap-2">
                      <ConnectorLogo connector={connector} size={18} />
                      <span className="text-sm">{connector.name}</span>
                      {/* Internal/External badge */}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                        connector.network === "internet"
                          ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                          : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                      }`}>
                        {connector.network === "internet" ? t("external") : t("internal")}
                      </span>
                      {/* Default badge */}
                      {connector.isDefault && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 flex items-center gap-0.5">
                          <Star className="w-2.5 h-2.5" />
                          {t("default")}
                        </span>
                      )}
                      {/* Backend status */}
                      {connector.network === "local" && connector.backends.length > 0 && (
                        <>
                          {connector.backends.some((b) => b.installed) ? (
                            <span className="text-[10px] text-green-600 flex items-center gap-0.5">
                              <Check className="w-2.5 h-2.5" />
                              {connector.backends.find((b) => b.installed)?.appName}
                            </span>
                          ) : !connector.available ? (
                            <span className="text-[10px] text-red-500 flex items-center gap-0.5">
                              <AlertTriangle className="w-2.5 h-2.5" />
                              {t("notInstalled")}
                            </span>
                          ) : null}
                        </>
                      )}
                    </div>
                    {connector.credentialsConfigured ? (
                      <Check className="w-3.5 h-3.5 text-green-500" />
                    ) : (
                      <Key className="w-3.5 h-3.5 text-amber-500" />
                    )}
                  </button>
                ))
              )}
              <button
                onClick={() => setShowPicker(false)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {t("cancel")}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowPicker(true)}
              className="flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              <Plus className="w-3.5 h-3.5" />
              {hasConnection ? t("addAnother") : t("connectSource")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
