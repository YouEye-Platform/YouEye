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
}

interface AvailableConnector {
  id: string;
  name: string;
  icon: string;
  network: string;
  authMethod: string;
  authProvider?: string;
  authProviderName?: string;
  authProviderConnected?: boolean;
  configFields: ConfigField[];
  credentialsConfigured: boolean;
  backends: Backend[];
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

  const connect = async (capability: string, connectorId: string) => {
    await fetch(`/api/settings/connectors/${appId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "connect",
        capability,
        connectorId,
        persistent: true,
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

function CapabilityRow({
  cap,
  isAdmin,
  onConnect,
  onDisconnect,
  onRefresh,
}: {
  cap: Capability;
  isAdmin: boolean;
  onConnect: (capability: string, connectorId: string) => void;
  onDisconnect: (capability: string, connectorId?: string) => void;
  onRefresh: () => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const t = useTranslations("connectorSettings");

  const connectedIds = new Set(cap.connections.map((c) => c.connectorId));
  const hasConnection = cap.connections.length > 0;

  const formatCapability = (s: string) =>
    s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

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
            return (
              <div
                key={conn.id}
                className="flex items-center justify-between py-1.5 px-3 rounded-md bg-accent/30"
              >
                <div className="flex items-center gap-2">
                  {connector?.network === "internet" ? (
                    <Globe className="w-3.5 h-3.5 text-blue-500" />
                  ) : (
                    <Server className="w-3.5 h-3.5 text-green-500" />
                  )}
                  <span className="text-sm">
                    {connector?.name ?? conn.connectorId}
                  </span>
                  {/* Internal/External badge */}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-0.5 ${
                    connector?.network === "internet"
                      ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                      : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                  }`}>
                    {connector?.network === "internet" ? t("external") : t("internal")}
                  </span>
                  {/* Backend status for internal connectors */}
                  {connector && connector.network === "local" && connector.backends.length > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      {connector.backends.some((b) => b.installed)
                        ? `(${connector.backends.find((b) => b.installed)?.appName})`
                        : ""
                      }
                    </span>
                  )}
                  {connector && !connector.credentialsConfigured && (
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

            // Managed fields use OAuth — show sign-in button
            const hasManagedFields = connector.configFields.some(
              (f) => f.managed && f.required
            );
            // Manual fields need direct entry
            const manualFields = connector.configFields.filter(
              (f) => f.required && f.type === "secret" && !f.managed
            );

            if (!hasManagedFields && manualFields.length === 0) return null;

            return (
              <div key={`cred-${conn.id}`} className="mt-2 pl-3 border-l-2 border-amber-300">
                {hasManagedFields && connector.authProvider && !connector.authProviderConnected && (
                  <div className="mb-2">
                    <a
                      href={`/api/auth/providers/${connector.authProvider}?redirect_uri=${encodeURIComponent(window.location.pathname)}`}
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
              </div>
            );
          })}
        </div>
      )}

      {/* Picker for new connections */}
      {(!hasConnection || cap.multiple) && (
        <div className="mt-2">
          {showPicker ? (
            <div className="space-y-1.5">
              {cap.availableConnectors
                .filter((c) => !connectedIds.has(c.id))
                .map((connector) => (
                  <button
                    key={connector.id}
                    onClick={() => {
                      onConnect(cap.capability, connector.id);
                      setShowPicker(false);
                    }}
                    className="w-full flex items-center justify-between py-2 px-3 rounded-md border hover:bg-accent/50 transition-colors text-left"
                  >
                    <div className="flex items-center gap-2">
                      {connector.network === "internet" ? (
                        <Globe className="w-3.5 h-3.5 text-blue-500" />
                      ) : (
                        <Server className="w-3.5 h-3.5 text-green-500" />
                      )}
                      <span className="text-sm">{connector.name}</span>
                      {/* Internal/External badge */}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                        connector.network === "internet"
                          ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                          : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                      }`}>
                        {connector.network === "internet" ? t("external") : t("internal")}
                      </span>
                      {/* Backend status */}
                      {connector.network === "local" && connector.backends.length > 0 && (
                        <>
                          {connector.backends.some((b) => b.installed) ? (
                            <span className="text-[10px] text-green-600 flex items-center gap-0.5">
                              <Check className="w-2.5 h-2.5" />
                              {connector.backends.find((b) => b.installed)?.appName}
                            </span>
                          ) : isAdmin ? (
                            <span className="text-[10px] text-amber-600 flex items-center gap-0.5">
                              <Download className="w-2.5 h-2.5" />
                              {t("installAvailable")}
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
                ))}
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
