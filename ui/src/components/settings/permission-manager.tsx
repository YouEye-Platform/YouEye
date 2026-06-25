/**
 * Permission Manager Component
 *
 * Shows per-app permissions with grant/revoke controls.
 * Displayed in the Apps settings page.
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import { Shield, ShieldCheck, ShieldX, Trash2, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { useTranslations } from "next-intl";

interface Permission {
  id: string;
  appId: string;
  permission: string;
  granted: boolean;
  grantType: string | null;
  grantedAt: string | null;
}

interface GroupedPermissions {
  [appId: string]: Permission[];
}

/** Maps permission key to a translation key */
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

export function PermissionManager() {
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [expandedApps, setExpandedApps] = useState<Set<string>>(new Set());
  const t = useTranslations('permissions');

  /** Looks up the human-readable permission label via i18n */
  function getPermissionLabel(perm: string): string {
    const key = PERMISSION_KEY_MAP[perm];
    if (key) return t(key as keyof typeof PERMISSION_KEY_MAP);
    return perm;
  }

  const fetchPermissions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/permissions/list");
      if (res.ok) {
        const data = await res.json();
        setPermissions(data.permissions ?? []);
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPermissions();
  }, [fetchPermissions]);

  const revoke = async (appId: string, permission: string) => {
    const key = `${appId}:${permission}`;
    setRevoking(key);
    try {
      const res = await fetch(`/api/v1/permissions/app/${encodeURIComponent(appId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permission }),
      });
      if (res.ok) {
        setPermissions((prev) =>
          prev.filter((p) => !(p.appId === appId && p.permission === permission))
        );
      }
    } catch {
      // Silently fail
    } finally {
      setRevoking(null);
    }
  };

  const revokeAll = async (appId: string) => {
    setRevoking(appId);
    try {
      const res = await fetch(`/api/v1/permissions/app/${encodeURIComponent(appId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        setPermissions((prev) => prev.filter((p) => p.appId !== appId));
      }
    } catch {
      // Silently fail
    } finally {
      setRevoking(null);
    }
  };

  const toggleApp = (appId: string) => {
    setExpandedApps((prev) => {
      const next = new Set(prev);
      if (next.has(appId)) next.delete(appId);
      else next.add(appId);
      return next;
    });
  };

  const grouped: GroupedPermissions = {};
  for (const p of permissions) {
    if (!grouped[p.appId]) grouped[p.appId] = [];
    grouped[p.appId].push(p);
  }

  const appIds = Object.keys(grouped).sort();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-medium flex items-center gap-2">
            <Shield className="w-4 h-4" />
            {t('title')}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('description')}
          </p>
        </div>
        <button
          onClick={fetchPermissions}
          disabled={loading}
          className="p-2 rounded-md hover:bg-accent transition-colors text-muted-foreground"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          {t('loadingPermissions')}
        </div>
      ) : appIds.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground border rounded-lg">
          <ShieldCheck className="w-8 h-8 mx-auto mb-2 opacity-40" />
          {t('noPermissions')}
        </div>
      ) : (
        <div className="border rounded-lg divide-y">
          {appIds.map((appId) => {
            const perms = grouped[appId];
            const expanded = expandedApps.has(appId);
            const grantedCount = perms.filter((p) => p.granted).length;

            return (
              <div key={appId}>
                <button
                  onClick={() => toggleApp(appId)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-accent/50 transition-colors text-left"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                      {appId.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="text-sm font-medium">{appId}</div>
                      <div className="text-xs text-muted-foreground">
                        {grantedCount !== 1
                          ? t('permissionsGrantedPlural', { count: grantedCount })
                          : t('permissionsGranted', { count: grantedCount })}
                      </div>
                    </div>
                  </div>
                  {expanded ? (
                    <ChevronUp className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-muted-foreground" />
                  )}
                </button>

                {expanded && (
                  <div className="px-4 pb-3 space-y-2">
                    {perms.map((p) => (
                      <div
                        key={`${p.appId}:${p.permission}`}
                        className="flex items-center justify-between py-1.5 px-3 rounded-md bg-accent/30"
                      >
                        <div className="flex items-center gap-2">
                          {p.granted ? (
                            <ShieldCheck className="w-3.5 h-3.5 text-green-500" />
                          ) : (
                            <ShieldX className="w-3.5 h-3.5 text-red-500" />
                          )}
                          <span className="text-sm">{getPermissionLabel(p.permission)}</span>
                          <GrantTypeBadge type={p.grantType} />
                        </div>
                        <button
                          onClick={() => revoke(p.appId, p.permission)}
                          disabled={revoking === `${p.appId}:${p.permission}`}
                          className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                          title={t('revokePermission')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}

                    <button
                      onClick={() => revokeAll(appId)}
                      disabled={revoking === appId}
                      className="w-full mt-1 py-1.5 text-xs text-destructive hover:bg-destructive/10 rounded-md transition-colors"
                    >
                      {t('revokeAll')}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
