/**
 * Apps List Settings — Unified Update Experience
 *
 * Shows all apps/services with versions and update status.
 * Items with available updates float to the top in an "Updates Available" section.
 * Inline progress bars per item (not a global banner).
 * Persistent status survives page refresh via server-side status tracking.
 * Reconnection overlay for CP/UI self-updates.
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  RefreshCw,
  Loader2,
  Server,
  Box,
  Cog,
  Monitor,
  Database,
  ShieldCheck,
  Globe,
  Shield as ShieldIcon,
  LayoutDashboard,
  BookOpen,
  Search,
  Package,
  ArrowUpCircle,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ArrowUp,
  AlertTriangle,
  Check,
  Pencil,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { BridgeUnavailable } from "@/components/settings/admin/bridge-unavailable";
import { UpdateOverlay } from "@/components/settings/admin/update-overlay";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { IconPicker, type IconPickerResult } from "@/components/icon-picker";
import type { UpdateStatusRecord } from "@/lib/admin/types";

const ICON_MAP: Record<string, React.ElementType> = {
  Server, Box, Cog, Monitor, Database, ShieldCheck,
  Globe, Shield: ShieldIcon, LayoutDashboard, BookOpen, Search, Package,
};

interface AppInfo {
  id: string;
  displayName: string;
  description: string;
  icon: string;
  category: string;
  type: string;
  integration?: "native" | "basic";
  containers: Array<{ name: string; status: string; ip?: string }>;
  version?: string;
  status: string;
  updateAvailable: boolean;
  updateInfo?: string;
}

const STATUS_CONFIG: Record<string, { color: string; icon: React.ElementType; label: string }> = {
  running: { color: "text-green-500", icon: CheckCircle2, label: "Running" },
  stopped: { color: "text-red-500", icon: XCircle, label: "Stopped" },
  partial: { color: "text-yellow-500", icon: AlertCircle, label: "Partial" },
  "not-installed": { color: "text-muted-foreground", icon: Package, label: "Not installed" },
  unknown: { color: "text-muted-foreground", icon: AlertCircle, label: "Unknown" },
};

const CATEGORY_LABELS: Record<string, string> = {
  system: "System",
  infrastructure: "Infrastructure",
  user: "Apps",
};

// Components where an update will restart the service, causing temporary unavailability
const SELF_DESTRUCTIVE = new Set(["control-panel", "youeye-ui"]);

export function AppsListSettings() {
  const t = useTranslations("settings.appsList");
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [persistentStatuses, setPersistentStatuses] = useState<Map<string, UpdateStatusRecord>>(new Map());
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [overlayComponent, setOverlayComponent] = useState<"control" | "ui" | null>(null);
  const [postUpdateToast, setPostUpdateToast] = useState<string | null>(null);
  const [editingApp, setEditingApp] = useState<AppInfo | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchApps = useCallback(async (refresh = false) => {
    try {
      setError(null);
      const url = refresh ? "/api/admin/apps?refresh=true" : "/api/admin/apps";
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json = await res.json();
      setApps(json.apps ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load apps");
    } finally {
      setLoading(false);
      setChecking(false);
    }
  }, []);

  const fetchStatuses = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/updates/status");
      if (!res.ok) return;
      const json = await res.json();
      const map = new Map<string, UpdateStatusRecord>();
      for (const s of json.statuses || []) {
        map.set(s.component, s);
      }
      setPersistentStatuses(map);
    } catch {
      // Best-effort
    }
  }, []);

  useEffect(() => {
    fetchApps();
    fetchStatuses();
  }, [fetchApps, fetchStatuses]);

  // Check for post-restart update flag (UI was just updated)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/update-flag");
        if (!res.ok) return;
        const json = await res.json();
        if (json.flag?.pending) {
          setPostUpdateToast("YouEye UI was updated successfully!");
          // Clear the flag
          await fetch("/api/admin/update-flag", { method: "DELETE" });
          // Auto-dismiss after 8 seconds
          setTimeout(() => setPostUpdateToast(null), 8000);
        }
      } catch {
        // Best-effort
      }
    })();
  }, []);

  // Poll for status updates when any update is in progress
  useEffect(() => {
    const hasActive = Array.from(persistentStatuses.values()).some(
      s => !["idle", "completed", "failed"].includes(s.status)
    );

    if (hasActive && !pollingRef.current) {
      pollingRef.current = setInterval(fetchStatuses, 2000);
    } else if (!hasActive && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
      // Refresh app list to get new versions
      fetchApps();
    }

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [persistentStatuses, fetchStatuses, fetchApps]);

  const handleCheck = () => {
    setChecking(true);
    fetchApps(true);
  };

  const handleUpdate = async (appId: string) => {
    // For self-destructive updates, show confirmation first
    if (SELF_DESTRUCTIVE.has(appId) && confirmId !== appId) {
      setConfirmId(appId);
      return;
    }
    setConfirmId(null);

    // Map app IDs to update component names for the bridge API
    const componentMap: Record<string, string> = {
      "control-panel": "control",
      "youeye-ui": "ui",
      spine: "spine",
    };
    const component = componentMap[appId] || appId;

    // For UI self-update, persist a flag so we can show toast after restart
    if (appId === "youeye-ui") {
      try {
        await fetch("/api/admin/update-flag", { method: "POST" });
      } catch {
        // Best-effort — update proceeds even if flag fails
      }
    }

    // Show overlay for self-destructive updates
    if (appId === "control-panel") {
      setOverlayComponent("control");
    } else if (appId === "youeye-ui") {
      setOverlayComponent("ui");
    }

    try {
      const res = await fetch(`/api/admin/updates/${component}`, { method: "POST" });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Update failed" }));

        // For SSE responses, read the stream
        if (res.body && res.headers.get("content-type")?.includes("text/event-stream")) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
          }
        } else {
          throw new Error(body.error ?? "Update failed");
        }
      }

      // Start polling for persistent status
      fetchStatuses();
      if (!pollingRef.current) {
        pollingRef.current = setInterval(fetchStatuses, 2000);
      }
    } catch (err) {
      console.error(`Update ${appId} failed:`, err);
    }
  };

  const renderInlineProgress = (appId: string) => {
    // Map app IDs to the component names used in the status system
    const componentMap: Record<string, string> = {
      "control-panel": "control",
      "youeye-ui": "ui",
      spine: "spine",
    };
    const component = componentMap[appId] || appId;
    const ps = persistentStatuses.get(component);
    if (!ps || ps.status === "idle") return null;

    const isActive = !["completed", "failed"].includes(ps.status);
    const isCompleted = ps.status === "completed";
    const isFailed = ps.status === "failed";

    return (
      <div className="mt-2 space-y-1.5 w-full">
        <div className="flex items-center gap-2 text-xs">
          {isActive && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
          {isCompleted && <Check className="h-3 w-3 text-green-600" />}
          {isFailed && <AlertCircle className="h-3 w-3 text-destructive" />}
          <span className={
            isActive ? "text-primary" :
            isCompleted ? "text-green-600" :
            "text-destructive"
          }>
            {ps.message}
          </span>
        </div>
        {isActive && (
          <Progress value={ps.progress} className="h-1.5" />
        )}
        {isCompleted && ps.version_after && (
          <span className="text-xs text-green-600 font-medium">
            Updated to v{ps.version_after}
          </span>
        )}
        {isFailed && ps.error && (
          <span className="text-xs text-destructive">{ps.error}</span>
        )}
      </div>
    );
  };

  const renderAppCard = (app: AppInfo) => {
    const IconComponent = ICON_MAP[app.icon] || Package;
    const statusCfg = STATUS_CONFIG[app.status] || STATUS_CONFIG.unknown;
    const StatusIcon = statusCfg.icon;

    const componentMap: Record<string, string> = {
      "control-panel": "control",
      "youeye-ui": "ui",
      spine: "spine",
    };
    const component = componentMap[app.id] || app.id;
    const ps = persistentStatuses.get(component);
    const isUpdating = ps && !["idle", "completed", "failed"].includes(ps.status);

    return (
      <Card key={app.id} className={`border ${app.updateAvailable ? "border-amber-300 dark:border-amber-700" : ""}`}>
        <CardContent className="py-3 px-4">
          <div className="flex items-center gap-4">
            {/* Icon */}
            <div className="h-10 w-10 rounded-lg bg-accent flex items-center justify-center shrink-0">
              <IconComponent className="h-5 w-5" />
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{app.displayName}</span>
                {app.version && (
                  <span className="text-xs text-muted-foreground">v{app.version}</span>
                )}
                <Badge variant="outline" className="text-xs">
                  {app.integration === "native" || app.type === "native" ? "native" : app.integration === "basic" ? "community" : app.type || "community"}
                </Badge>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                <span className={`flex items-center gap-1 ${statusCfg.color}`}>
                  <StatusIcon className="h-3 w-3" />
                  {statusCfg.label}
                </span>
                <span>{app.description}</span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 shrink-0">
              {/* Edit button (only for user-category apps) */}
              {app.category === "user" && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditingApp(app)}
                  className="h-8 w-8 p-0"
                  title="Edit name, icon, or subdomain"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              )}
              {app.updateAvailable && !isUpdating && (
                <span className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                  {app.updateInfo || "Update available"}
                </span>
              )}
              {app.updateAvailable && (
                <Button
                  size="sm"
                  variant={isUpdating ? "ghost" : "outline"}
                  onClick={() => handleUpdate(app.id)}
                  disabled={!!isUpdating}
                >
                  {isUpdating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    "Update"
                  )}
                </Button>
              )}
            </div>
          </div>

          {/* Confirmation for self-destructive updates */}
          {confirmId === app.id && (
            <div className="mt-3 p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                <div className="space-y-2">
                  <p className="text-xs text-amber-800 dark:text-amber-200">
                    This will restart {app.displayName}. The page may become temporarily unavailable.
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="destructive" onClick={() => handleUpdate(app.id)}>
                      Continue
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setConfirmId(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Inline progress */}
          {renderInlineProgress(app.id)}
        </CardContent>
      </Card>
    );
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">All installed apps and services.</p>
        </div>
        <div className="grid gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">All installed apps and services.</p>
        </div>
        <BridgeUnavailable message={error} onRetry={() => fetchApps()} />
      </div>
    );
  }

  // Split apps into those with updates and those without
  const appsWithUpdates = apps.filter(a => a.updateAvailable);
  const appsWithoutUpdates = apps.filter(a => !a.updateAvailable);

  // Group the non-update apps by category
  const grouped = appsWithoutUpdates.reduce<Record<string, AppInfo[]>>((acc, app) => {
    const cat = app.category || "user";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(app);
    return acc;
  }, {});

  const categoryOrder = ["user", "infrastructure", "system"];

  return (
    <div className="space-y-6">
      {/* Reconnection overlay */}
      {overlayComponent && (
        <UpdateOverlay
          component={overlayComponent}
          onReconnected={() => {
            fetchApps();
            fetchStatuses();
          }}
          onDismiss={() => setOverlayComponent(null)}
        />
      )}

      {/* Post-update toast */}
      {postUpdateToast && (
        <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-lg">
          <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
          <span className="text-sm text-green-800 dark:text-green-200 flex-1">{postUpdateToast}</span>
          <button
            onClick={() => setPostUpdateToast(null)}
            className="text-green-600 hover:text-green-800 text-sm font-medium"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            All installed apps and services with version info.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleCheck}
          disabled={checking}
        >
          {checking ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Check for Updates
        </Button>
      </div>

      {/* Updates Available Section */}
      {appsWithUpdates.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <ArrowUp className="h-4 w-4 text-amber-600" />
            <h3 className="text-sm font-semibold text-amber-600 uppercase tracking-wider">
              Updates Available ({appsWithUpdates.length})
            </h3>
          </div>
          <div className="grid gap-2">
            {appsWithUpdates.map(app => renderAppCard(app))}
          </div>
        </div>
      )}

      {/* Regular apps by category */}
      {categoryOrder.map((category) => {
        const categoryApps = grouped[category];
        if (!categoryApps || categoryApps.length === 0) return null;

        return (
          <div key={category}>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              {CATEGORY_LABELS[category] || category}
            </h3>
            <div className="grid gap-2">
              {categoryApps.map(app => renderAppCard(app))}
            </div>
          </div>
        );
      })}

      {/* Admin Edit Dialog */}
      <Dialog
        open={!!editingApp}
        onOpenChange={(open) => !open && setEditingApp(null)}
      >
        {editingApp && (
          <AdminEditAppDialog
            app={editingApp}
            onSaved={() => {
              setEditingApp(null);
              fetchApps();
            }}
            onClose={() => setEditingApp(null)}
          />
        )}
      </Dialog>
    </div>
  );
}

// ─── Admin Edit App Dialog ────────────────────────────────────

function AdminEditAppDialog({
  app,
  onSaved,
  onClose,
}: {
  app: AppInfo;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(app.displayName);
  const [subdomain, setSubdomain] = useState("");
  const [showSubdomain, setShowSubdomain] = useState(false);
  const [selectedIcon, setSelectedIcon] = useState<IconPickerResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {};

      if (name.trim() && name.trim() !== app.displayName) {
        body.name = name.trim();
      }

      if (selectedIcon) {
        body.icon = selectedIcon.value;
      }

      if (showSubdomain && subdomain.trim()) {
        body.subdomain = subdomain.trim().toLowerCase();
      }

      if (Object.keys(body).length === 0) {
        onClose();
        return;
      }

      const res = await fetch(`/api/admin/apps/${app.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Failed" }));
        setError(data.error || "Failed to save");
        return;
      }

      onSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Edit {app.displayName}</DialogTitle>
      </DialogHeader>

      <div className="space-y-4">
        {/* Name */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Display Name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={app.displayName}
          />
          <p className="text-[10px] text-muted-foreground">
            Changes the server-wide default name for all users.
          </p>
        </div>

        {/* Icon */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Icon</label>
          <IconPicker
            currentIcon={app.icon}
            onSelect={setSelectedIcon}
            compact
          />
        </div>

        {/* Subdomain (optional, expandable) */}
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowSubdomain(!showSubdomain)}
            className="text-sm text-primary hover:underline flex items-center gap-1"
          >
            <Globe className="h-3.5 w-3.5" />
            {showSubdomain ? "Hide subdomain change" : "Change subdomain..."}
          </button>

          {showSubdomain && (
            <div className="space-y-2 pl-5">
              <Input
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value)}
                placeholder="new-subdomain"
                pattern="[a-z0-9-]+"
                title="Lowercase letters, numbers, and hyphens only"
              />
              <div className="flex items-start gap-2 p-2 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-600 mt-0.5 shrink-0" />
                <p className="text-[10px] text-amber-800 dark:text-amber-200">
                  This will update Caddy routing, Authentik SSO redirects, and all
                  bookmark URLs. Existing links to the old subdomain will stop working.
                </p>
              </div>
            </div>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {/* Actions */}
        <div className="flex gap-2 pt-2 justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <Check className="h-4 w-4 mr-1" />
            )}
            Save
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}
