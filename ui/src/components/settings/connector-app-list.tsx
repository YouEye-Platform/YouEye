"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Plug,
  PlugZap,
  RefreshCw,
  ChevronRight,
  Globe,
  Server,
  Zap,
  Download,
} from "lucide-react";
import { useTranslations } from "next-intl";

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
  source: string;
  network: string;
  authMethod: string;
  credentialsConfigured: boolean;
  backends: Backend[];
}

interface ActiveConnector {
  connectorId: string;
  name: string;
  source: string;
  autoWired: boolean;
  credentialsConfigured: boolean;
}

interface CapabilityGroup {
  capability: string;
  consumingApps: { id: string; name: string }[];
  activeConnector: ActiveConnector | null;
  availableConnectors: AvailableConnector[];
}

export function ConnectorAppList() {
  const [capabilities, setCapabilities] = useState<CapabilityGroup[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const t = useTranslations("connectorSettings");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings/connectors");
      if (res.ok) {
        const data = await res.json();
        setCapabilities(data.capabilities ?? []);
        setIsAdmin(data.isAdmin ?? false);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const formatCapability = (s: string) =>
    s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  function sourceLabel(source: string): string {
    if (source === "internal") return t("internal");
    if (source === "both") return t("internalExternal");
    return t("external");
  }

  function SourceIcon({ source }: { source: string }) {
    if (source === "external") return <Globe className="w-3.5 h-3.5 text-blue-500" />;
    return <Server className="w-3.5 h-3.5 text-green-500" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-medium flex items-center gap-2">
            <Plug className="w-4 h-4" />
            {t("title")}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("description")}
          </p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="p-2 rounded-md hover:bg-accent transition-colors text-muted-foreground"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          {t("loading")}
        </div>
      ) : capabilities.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground border rounded-lg">
          <Plug className="w-8 h-8 mx-auto mb-2 opacity-40" />
          {t("noApps")}
        </div>
      ) : (
        <div className="space-y-3">
          {capabilities.map((cap) => (
            <button
              key={cap.capability}
              onClick={() =>
                router.push(`/settings/connectors/capability/${encodeURIComponent(cap.capability)}`)
              }
              className="w-full border rounded-lg p-4 hover:bg-accent/50 transition-colors text-left"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                    {cap.activeConnector ? (
                      <PlugZap className="w-4 h-4 text-primary" />
                    ) : (
                      <Plug className="w-4 h-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium">
                      {formatCapability(cap.capability)}
                    </div>
                    {cap.activeConnector ? (
                      <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
                        <SourceIcon source={cap.activeConnector.source} />
                        <span>{cap.activeConnector.name}</span>
                        {cap.activeConnector.autoWired && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                            <Zap className="w-2.5 h-2.5" />
                            {t("autoConnected")}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {t("notConnected")}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {/* Show connector count summary */}
                  <div className="text-[10px] text-muted-foreground hidden sm:flex items-center gap-1">
                    {cap.availableConnectors.filter((c) => c.source !== "external").length > 0 && (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-muted">
                        <Server className="w-2.5 h-2.5" />
                        {cap.availableConnectors.filter((c) => c.source !== "external").length}
                      </span>
                    )}
                    {cap.availableConnectors.filter((c) => c.source === "external").length > 0 && (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-muted">
                        <Globe className="w-2.5 h-2.5" />
                        {cap.availableConnectors.filter((c) => c.source === "external").length}
                      </span>
                    )}
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </div>
              </div>

              {/* Consuming apps */}
              {cap.consumingApps.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {cap.consumingApps.map((app) => (
                    <span
                      key={app.id}
                      className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground"
                    >
                      {app.name}
                    </span>
                  ))}
                </div>
              )}

              {/* Admin: show uninstalled backends hint */}
              {isAdmin && cap.availableConnectors.some(
                (c) => c.source !== "external" && c.backends.some((b) => !b.installed)
              ) && (
                <div className="mt-2 flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                  <Download className="w-3 h-3" />
                  {t("backendsAvailable")}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
