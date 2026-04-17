"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Plug,
  Globe,
  Server,
  Check,
  Key,
  AlertTriangle,
  User,
} from "lucide-react";
import { useTranslations } from "next-intl";

interface AvailableConnector {
  id: string;
  name: string;
  icon: string;
  network: string;
  authMethod: string;
  configFields: Array<{ name: string; label: string; type: string; required: boolean }>;
  credentialsConfigured: boolean;
}

interface Props {
  appId: string;
  appName: string;
  capability: string;
  redirectUri: string | null;
  userName: string;
  userImage: string | null;
}

export function ConnectorSetup({
  appId,
  appName,
  capability,
  redirectUri,
  userName,
  userImage,
}: Props) {
  const [connectors, setConnectors] = useState<AvailableConnector[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [hasInternet, setHasInternet] = useState(false);
  const router = useRouter();
  const t = useTranslations("connectorSettings");

  const fetchConnectors = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/settings/connectors/${appId}`);
      if (res.ok) {
        const data = await res.json();
        const cap = data.capabilities?.find(
          (c: { capability: string }) => c.capability === capability
        );
        if (cap) {
          setConnectors(cap.availableConnectors);
        }
        const manifest = data.app?.manifest as Record<string, unknown> | null;
        setHasInternet(
          (manifest?.network as string) === "internet"
        );
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [appId, capability]);

  useEffect(() => {
    fetchConnectors();
  }, [fetchConnectors]);

  const handleConnect = async () => {
    if (!selected) return;
    setConnecting(true);

    try {
      const res = await fetch(`/api/settings/connectors/${appId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "connect",
          capability,
          connectorId: selected,
          persistent: remember,
        }),
      });

      if (res.ok) {
        if (redirectUri) {
          const sep = redirectUri.includes("?") ? "&" : "?";
          window.location.href = `${redirectUri}${sep}connected=${encodeURIComponent(capability)}`;
        } else {
          router.push(`/settings/connectors/${appId}`);
        }
      }
    } catch {
      setConnecting(false);
    }
  };

  const formatCapability = (s: string) =>
    s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* User identity indicator */}
        <div className="flex items-center gap-2 mb-6 text-sm text-muted-foreground">
          {userImage ? (
            <img
              src={userImage}
              alt=""
              className="w-6 h-6 rounded-full"
            />
          ) : (
            <User className="w-5 h-5" />
          )}
          <span>{userName}</span>
        </div>

        <div className="border rounded-xl p-6 bg-card shadow-sm">
          <div className="mb-6">
            <h1 className="text-lg font-semibold">{t("setupTitle")}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {t("setupDescription", {
                appName,
                capability: formatCapability(capability),
              })}
            </p>
          </div>

          {hasInternet && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 mb-4">
              <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {t("internetWarning")}
              </p>
            </div>
          )}

          {loading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {t("loading")}
            </div>
          ) : connectors.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <Plug className="w-8 h-8 mx-auto mb-2 opacity-40" />
              {t("noConnectors")}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-medium">{t("chooseSource")}</p>

              {connectors.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelected(c.id)}
                  className={`w-full flex items-center justify-between py-3 px-4 rounded-lg border transition-colors text-left ${
                    selected === c.id
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-accent/50"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                        selected === c.id
                          ? "border-primary"
                          : "border-muted-foreground/40"
                      }`}
                    >
                      {selected === c.id && (
                        <div className="w-2 h-2 rounded-full bg-primary" />
                      )}
                    </div>
                    <span className="text-sm font-medium">{c.name}</span>
                    <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 bg-muted rounded-full flex items-center gap-1">
                      {c.network === "internet" ? (
                        <Globe className="w-2.5 h-2.5" />
                      ) : (
                        <Server className="w-2.5 h-2.5" />
                      )}
                      {c.network === "internet" ? t("internet") : t("local")}
                    </span>
                  </div>
                  {c.credentialsConfigured ? (
                    <span className="text-xs text-green-600 flex items-center gap-1">
                      <Check className="w-3 h-3" />
                      {t("ready")}
                    </span>
                  ) : (
                    <span className="text-xs text-amber-600 flex items-center gap-1">
                      <Key className="w-3 h-3" />
                      {t("apiKeyRequired")}
                    </span>
                  )}
                </button>
              ))}

              <label className="flex items-center gap-2 mt-4 text-sm text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="rounded border-muted-foreground/40"
                />
                {t("rememberChoice")}
              </label>

              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => {
                    if (redirectUri) {
                      window.location.href = redirectUri;
                    } else {
                      router.back();
                    }
                  }}
                  className="flex-1 py-2.5 text-sm border rounded-lg hover:bg-accent/50 transition-colors"
                >
                  {t("cancel")}
                </button>
                <button
                  onClick={handleConnect}
                  disabled={!selected || connecting}
                  className="flex-1 py-2.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                  {connecting ? t("redirecting") : t("connect")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
