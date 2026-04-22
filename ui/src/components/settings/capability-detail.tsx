"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ArrowLeft,
  Plug,
  PlugZap,
  RefreshCw,
  Globe,
  Server,
  Check,
  Key,
  Eye,
  EyeOff,
  Zap,
  Download,
  AlertTriangle,
  Radio,
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

interface ConnectorInfo {
  id: string;
  name: string;
  icon: string;
  source: string;
  network: string;
  authMethod: string;
  authProvider?: string;
  authProviderName?: string;
  authProviderConnected?: boolean;
  configFields: ConfigField[];
  credentialsConfigured: boolean;
  backends: Backend[];
  isActive: boolean;
}

function CredentialEntry({
  connectorId,
  field,
  onSaved,
}: {
  connectorId: string;
  field: ConfigField;
  onSaved: () => void;
}) {
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
          {show ? (
            <EyeOff className="w-3.5 h-3.5" />
          ) : (
            <Eye className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
      <button
        onClick={save}
        disabled={saving || !value.trim()}
        className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1"
      >
        {saved ? (
          <Check className="w-3.5 h-3.5" />
        ) : (
          <Key className="w-3.5 h-3.5" />
        )}
        {saved ? t("saved") : t("save")}
      </button>
    </div>
  );
}

export function CapabilityDetail({
  capability,
}: {
  capability: string;
}) {
  const [internal, setInternal] = useState<ConnectorInfo[]>([]);
  const [external, setExternal] = useState<ConnectorInfo[]>([]);
  const [activeConnectorId, setActiveConnectorId] = useState<string | null>(null);
  const [autoWired, setAutoWired] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);
  const router = useRouter();
  const t = useTranslations("connectorSettings");

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/settings/connectors/capability/${encodeURIComponent(capability)}`
      );
      if (res.ok) {
        const data = await res.json();
        setInternal(data.internal ?? []);
        setExternal(data.external ?? []);
        setActiveConnectorId(data.activeConnectorId ?? null);
        setAutoWired(data.autoWired ?? false);
        setIsAdmin(data.isAdmin ?? false);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [capability]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const selectConnector = async (connectorId: string) => {
    setConnecting(connectorId);
    try {
      await fetch(
        `/api/settings/connectors/capability/${encodeURIComponent(capability)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "connect", connectorId }),
        }
      );
      await fetchDetail();
    } catch {
      // silent
    } finally {
      setConnecting(null);
    }
  };

  const disconnect = async () => {
    try {
      await fetch(
        `/api/settings/connectors/capability/${encodeURIComponent(capability)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "disconnect" }),
        }
      );
      await fetchDetail();
    } catch {
      // silent
    }
  };

  const formatCapability = (s: string) =>
    s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  if (loading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        {t("loading")}
      </div>
    );
  }

  const allConnectors = [...internal, ...external];

  return (
    <div className="space-y-6">
      <button
        onClick={() => router.push("/settings/connectors")}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        {t("backToList")}
      </button>

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">
            {formatCapability(capability)}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t("capabilityDescription")}
          </p>
        </div>
        <button
          onClick={fetchDetail}
          className="p-2 rounded-md hover:bg-accent transition-colors text-muted-foreground"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Active connector summary */}
      {activeConnectorId && (
        <div className="border rounded-lg p-4 bg-accent/20">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <PlugZap className="w-4 h-4 text-green-500" />
              <span className="text-sm font-medium">{t("activeSource")}</span>
            </div>
            {!autoWired && (
              <button
                onClick={disconnect}
                className="text-xs text-destructive hover:underline"
              >
                {t("disconnect")}
              </button>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            {(() => {
              const active = allConnectors.find(
                (c) => c.id === activeConnectorId
              );
              if (!active) return null;
              return (
                <>
                  {active.source === "external" ? (
                    <Globe className="w-3.5 h-3.5 text-blue-500" />
                  ) : (
                    <Server className="w-3.5 h-3.5 text-green-500" />
                  )}
                  <span className="text-sm">{active.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                    {active.source === "external"
                      ? t("external")
                      : active.source === "both"
                        ? t("internalExternal")
                        : t("internal")}
                  </span>
                  {autoWired && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                      <Zap className="w-2.5 h-2.5" />
                      {t("autoConnected")}
                    </span>
                  )}
                  {!active.credentialsConfigured && (
                    <span className="text-xs text-amber-600 flex items-center gap-0.5">
                      <AlertTriangle className="w-3 h-3" />
                      {t("needsApiKey")}
                    </span>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Internal connectors section */}
      {internal.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
            <Server className="w-3.5 h-3.5" />
            {t("internalSources")}
          </h3>
          <p className="text-xs text-muted-foreground mb-3">
            {t("internalDescription")}
          </p>
          <div className="space-y-2">
            {internal.map((connector) => (
              <ConnectorCard
                key={connector.id}
                connector={connector}
                isActive={connector.id === activeConnectorId}
                autoWired={autoWired && connector.id === activeConnectorId}
                connecting={connecting === connector.id}
                isAdmin={isAdmin}
                onSelect={() => selectConnector(connector.id)}
                onRefresh={fetchDetail}
              />
            ))}
          </div>
        </div>
      )}

      {/* External connectors section */}
      {external.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
            <Globe className="w-3.5 h-3.5" />
            {t("externalSources")}
          </h3>
          <p className="text-xs text-muted-foreground mb-3">
            {t("externalDescription")}
          </p>
          <div className="space-y-2">
            {external.map((connector) => (
              <ConnectorCard
                key={connector.id}
                connector={connector}
                isActive={connector.id === activeConnectorId}
                autoWired={autoWired && connector.id === activeConnectorId}
                connecting={connecting === connector.id}
                isAdmin={isAdmin}
                onSelect={() => selectConnector(connector.id)}
                onRefresh={fetchDetail}
              />
            ))}
          </div>
        </div>
      )}

      {allConnectors.length === 0 && (
        <div className="py-6 text-center text-sm text-muted-foreground border rounded-lg">
          <Plug className="w-8 h-8 mx-auto mb-2 opacity-40" />
          {t("noConnectors")}
        </div>
      )}
    </div>
  );
}

function ConnectorCard({
  connector,
  isActive,
  autoWired,
  connecting,
  isAdmin,
  onSelect,
  onRefresh,
}: {
  connector: ConnectorInfo;
  isActive: boolean;
  autoWired: boolean;
  connecting: boolean;
  isAdmin: boolean;
  onSelect: () => void;
  onRefresh: () => void;
}) {
  const t = useTranslations("connectorSettings");
  const installedBackends = connector.backends.filter((b) => b.installed);
  const uninstalledBackends = connector.backends.filter((b) => !b.installed);

  return (
    <div
      className={`border rounded-lg p-4 transition-colors ${
        isActive
          ? "border-primary/50 bg-primary/5"
          : "hover:bg-accent/30"
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Radio selector */}
          <button
            onClick={onSelect}
            disabled={connecting}
            className="shrink-0"
          >
            <div
              className={`w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${
                isActive
                  ? "border-primary"
                  : "border-muted-foreground/40 hover:border-muted-foreground"
              }`}
            >
              {isActive && (
                <div className="w-2 h-2 rounded-full bg-primary" />
              )}
            </div>
          </button>

          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{connector.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground flex items-center gap-0.5">
                {connector.network === "internet" ? (
                  <Globe className="w-2.5 h-2.5" />
                ) : (
                  <Server className="w-2.5 h-2.5" />
                )}
                {connector.network === "internet"
                  ? t("internet")
                  : t("local")}
              </span>
              {autoWired && (
                <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                  <Zap className="w-2.5 h-2.5" />
                  {t("autoConnected")}
                </span>
              )}
            </div>

            {/* Installed backends for internal connectors */}
            {installedBackends.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {installedBackends.map((b) => (
                  <span
                    key={b.appId}
                    className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 flex items-center gap-0.5"
                  >
                    <Check className="w-2.5 h-2.5" />
                    {b.appName}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Credential status */}
        <div className="shrink-0">
          {connector.credentialsConfigured ? (
            <span className="text-xs text-green-600 flex items-center gap-1">
              <Check className="w-3.5 h-3.5" />
              {t("ready")}
            </span>
          ) : connector.authMethod !== "none" ? (
            <span className="text-xs text-amber-600 flex items-center gap-1">
              <Key className="w-3.5 h-3.5" />
              {t("apiKeyRequired")}
            </span>
          ) : null}
        </div>
      </div>

      {/* Admin: install missing backends */}
      {isAdmin && uninstalledBackends.length > 0 && (
        <div className="mt-3 border-t pt-3">
          <p className="text-xs text-muted-foreground mb-2">
            {t("installableBackends")}
          </p>
          <div className="flex flex-wrap gap-2">
            {uninstalledBackends.map((b) => (
              <span
                key={b.appId}
                className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md border border-dashed text-muted-foreground"
              >
                <Download className="w-3 h-3" />
                {b.appName}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Credential entry for active connector that needs keys */}
      {isActive && !connector.credentialsConfigured && connector.authMethod !== "none" && (
        <div className="mt-3 border-t pt-3">
          {/* OAuth sign-in */}
          {connector.authProvider && !connector.authProviderConnected && (
            <div className="mb-2">
              <a
                href={`/api/auth/providers/${connector.authProvider}?redirect_uri=${
                  typeof window !== "undefined"
                    ? encodeURIComponent(window.location.pathname)
                    : ""
                }`}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
              >
                <Key className="w-4 h-4" />
                {t("signInWith")}{" "}
                {connector.authProviderName || connector.authProvider}
              </a>
            </div>
          )}
          {connector.authProvider && connector.authProviderConnected && (
            <div className="mb-2 flex items-center gap-1.5 text-sm text-green-600">
              <Check className="w-4 h-4" />
              {connector.authProviderName || connector.authProvider}{" "}
              {t("connected")}
            </div>
          )}

          {/* Manual credential fields */}
          {connector.configFields
            .filter((f) => f.required && f.type === "secret" && !f.managed)
            .map((field) => (
              <CredentialEntry
                key={field.name}
                connectorId={connector.id}
                field={field}
                onSaved={onRefresh}
              />
            ))}
        </div>
      )}
    </div>
  );
}
