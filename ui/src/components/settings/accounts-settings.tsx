/**
 * Accounts Settings — Connected accounts and API keys
 *
 * Shows:
 * 1. OAuth accounts (Google, Spotify, etc.) with connect/disconnect
 * 2. Manual API keys stored for connectors
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import {
  KeyRound,
  Shield,
  Check,
  AlertTriangle,
  ExternalLink,
  Trash2,
  RefreshCw,
  Eye,
  EyeOff,
  Plus,
  Key,
  Link2Off,
} from "lucide-react";
import { useTranslations } from "next-intl";

interface OAuthAccount {
  providerId: string;
  slug: string;
  name: string;
  type: string;
  connected: boolean;
  expired: boolean;
  scopes: string | null;
  expiresAt: string | null;
  daysUntilExpiry: number | null;
}

interface ApiKeyEntry {
  id: string;
  connectorId: string;
  key: string;
  boundHost: string | null;
  createdAt: string | null;
}

export function AccountsSettings() {
  const [oauthAccounts, setOauthAccounts] = useState<OAuthAccount[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const t = useTranslations("accountSettings");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings/accounts");
      if (res.ok) {
        const data = await res.json();
        setOauthAccounts(data.oauthAccounts ?? []);
        setApiKeys(data.apiKeys ?? []);
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

  const deleteApiKey = async (connectorId: string, key: string) => {
    const id = `${connectorId}:${key}`;
    setDeleting(id);
    try {
      const res = await fetch("/api/settings/connectors/credentials", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectorId, key }),
      });
      if (res.ok) {
        setApiKeys((prev) => prev.filter((k) => !(k.connectorId === connectorId && k.key === key)));
      }
    } catch {
      // silent
    } finally {
      setDeleting(null);
    }
  };

  const disconnectOAuth = async (providerId: string, slug: string) => {
    setDeleting(providerId);
    try {
      const res = await fetch(`/api/auth/providers/${slug}/disconnect`, {
        method: "POST",
      });
      if (res.ok) {
        fetchData();
      }
    } catch {
      // silent
    } finally {
      setDeleting(null);
    }
  };

  if (loading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">{t("loading")}</div>;
  }

  return (
    <div className="space-y-8">
      {/* Connected Accounts (OAuth) */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-medium flex items-center gap-2">
              <Shield className="w-4 h-4" />
              {t("connectedAccounts")}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("connectedAccountsDescription")}
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

        {oauthAccounts.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground border rounded-lg">
            <Shield className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p>{t("noProviders")}</p>
          </div>
        ) : (
          <div className="border rounded-lg divide-y">
            {oauthAccounts.map((account) => (
              <div
                key={account.providerId}
                className="flex items-center justify-between px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                    <span className="text-xs font-bold text-primary">
                      {account.name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <div className="text-sm font-medium">{account.name}</div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {account.connected && !account.expired && (
                        <>
                          <span className="flex items-center gap-1 text-green-600">
                            <Check className="w-3 h-3" />
                            {t("connected")}
                          </span>
                          {account.daysUntilExpiry !== null && (
                            <span>
                              {t("expiresIn", { days: account.daysUntilExpiry })}
                            </span>
                          )}
                        </>
                      )}
                      {account.connected && account.expired && (
                        <span className="flex items-center gap-1 text-amber-600">
                          <AlertTriangle className="w-3 h-3" />
                          {t("expired")}
                        </span>
                      )}
                      {!account.connected && (
                        <span className="text-muted-foreground">{t("notConnected")}</span>
                      )}
                      {account.scopes && (
                        <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded">
                          {account.scopes}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {account.connected ? (
                    <>
                      {account.expired && (
                        <a
                          href={`/api/auth/providers/${account.slug}?redirect_uri=/settings/accounts`}
                          className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
                        >
                          {t("reconnect")}
                        </a>
                      )}
                      <button
                        onClick={() => disconnectOAuth(account.providerId, account.slug)}
                        disabled={deleting === account.providerId}
                        className="px-3 py-1.5 text-xs text-destructive border border-destructive/30 rounded-md hover:bg-destructive/10 transition-colors"
                      >
                        {t("disconnect")}
                      </button>
                    </>
                  ) : (
                    <a
                      href={`/api/auth/providers/${account.slug}?redirect_uri=/settings/accounts`}
                      className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
                    >
                      {t("connect")}
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* API Keys */}
      <section className="space-y-4">
        <div>
          <h3 className="text-base font-medium flex items-center gap-2">
            <KeyRound className="w-4 h-4" />
            {t("apiKeys")}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("apiKeysDescription")}
          </p>
        </div>

        {apiKeys.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground border rounded-lg">
            <KeyRound className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p>{t("noApiKeys")}</p>
          </div>
        ) : (
          <div className="border rounded-lg divide-y">
            {apiKeys.map((entry) => {
              const deleteId = `${entry.connectorId}:${entry.key}`;
              return (
                <div
                  key={entry.id}
                  className="flex items-center justify-between px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                      <Key className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                    </div>
                    <div>
                      <div className="text-sm font-medium">
                        {formatConnectorId(entry.connectorId)}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{entry.key}</span>
                        {entry.boundHost && (
                          <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded">
                            {entry.boundHost}
                          </span>
                        )}
                        {entry.createdAt && (
                          <span>
                            {t("added")} {new Date(entry.createdAt).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => deleteApiKey(entry.connectorId, entry.key)}
                    disabled={deleting === deleteId}
                    className="p-2 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                    title={t("deleteApiKey")}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function formatConnectorId(id: string): string {
  return id
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
