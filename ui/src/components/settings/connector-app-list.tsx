"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Plug,
  RefreshCw,
  ChevronRight,
  Wifi,
  WifiOff,
  Globe,
  Server,
} from "lucide-react";
import { useTranslations } from "next-intl";

interface AppSummary {
  id: string;
  name: string;
  icon: string | null;
  subdomain: string | null;
  enabled: boolean;
  status: string;
  isExternalApp: boolean;
  capabilities: string[];
  connectedCount: number;
  totalCapabilities: number;
}

export function ConnectorAppList() {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const t = useTranslations("connectorSettings");

  const fetchApps = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings/connectors");
      if (res.ok) {
        const data = await res.json();
        setApps(data.apps ?? []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  const nativeApps = apps.filter((a) => !a.isExternalApp);
  const externalApps = apps.filter((a) => a.isExternalApp);

  function statusText(app: AppSummary): string {
    if (app.isExternalApp) return t("externalApp");
    if (app.totalCapabilities === 0) return t("noConnectors");
    if (app.connectedCount === app.totalCapabilities) {
      return t("allConnected");
    }
    return t("connectedOf", {
      connected: app.connectedCount,
      total: app.totalCapabilities,
    });
  }

  function statusIcon(app: AppSummary) {
    if (app.isExternalApp) return <Globe className="w-4 h-4 text-muted-foreground" />;
    if (app.totalCapabilities === 0) return <Server className="w-4 h-4 text-muted-foreground" />;
    if (app.connectedCount === app.totalCapabilities) {
      return <Wifi className="w-4 h-4 text-green-500" />;
    }
    if (app.connectedCount > 0) {
      return <Wifi className="w-4 h-4 text-amber-500" />;
    }
    return <WifiOff className="w-4 h-4 text-muted-foreground" />;
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
          onClick={fetchApps}
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
      ) : apps.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground border rounded-lg">
          <Plug className="w-8 h-8 mx-auto mb-2 opacity-40" />
          {t("noApps")}
        </div>
      ) : (
        <>
          {nativeApps.length > 0 && (
            <div className="border rounded-lg divide-y">
              {nativeApps.map((app) => (
                <button
                  key={app.id}
                  onClick={() => router.push(`/settings/apps/${app.id}`)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-accent/50 transition-colors text-left"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
                      <span className="text-xs font-bold text-primary">
                        {app.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div>
                      <div className="text-sm font-medium">{app.name}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                        {statusIcon(app)}
                        {statusText(app)}
                      </div>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}

          {externalApps.length > 0 && (
            <>
              <h4 className="text-sm font-medium text-muted-foreground mt-4">
                {t("externalApps")}
              </h4>
              <div className="border rounded-lg divide-y">
                {externalApps.map((app) => (
                  <button
                    key={app.id}
                    onClick={() => router.push(`/settings/apps/${app.id}`)}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-accent/50 transition-colors text-left"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
                        <span className="text-xs font-bold text-primary">
                        {app.name.charAt(0).toUpperCase()}
                      </span>
                      </div>
                      <div>
                        <div className="text-sm font-medium">{app.name}</div>
                        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                          <Globe className="w-3.5 h-3.5" />
                          {t("externalApp")}
                        </div>
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
