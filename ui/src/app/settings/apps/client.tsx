"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  LayoutGrid,
  ChevronRight,
  ArrowUpCircle,
  Server,
  Package,
  Loader2,
  RefreshCw,
  AlertCircle,
} from "lucide-react";

/* ── Types ── */

interface UnifiedApp {
  id: string;
  name: string;
  icon: string | null;
  subdomain: string | null;
  status: string;
  version: string | null;
  updateAvailable: boolean;
  updateInfo: string | null;
  category: string;
  type: string;
  description: string;
  url: string | null;
}

interface SystemApp {
  id: string;
  name: string;
  icon: string;
  status: string;
  version: string | null;
  updateAvailable: boolean;
  updateInfo: string | null;
  category: string;
  type: string;
  description: string;
}

interface UpdateEntry {
  id: string;
  name: string;
  version: string | null;
  updateInfo: string | null;
  category: string;
}

interface UnifiedResponse {
  apps: UnifiedApp[];
  systemApps: SystemApp[];
  updatesAvailable: UpdateEntry[];
  isAdmin: boolean;
}

/* ── Update Iframe Bridge ── */

function useUpdateBridge() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [updating, setUpdating] = useState<string | null>(null);
  const [updateResult, setUpdateResult] = useState<{
    id: string;
    status: "completed" | "failed";
    message?: string;
  } | null>(null);

  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      const data = e.data;
      if (!data?.type) return;

      if (data.type === "update-enqueued") {
        setUpdating(data.component);
      }
      if (data.type === "update-status") {
        const entries = data.entries ?? [];
        // Check if our currently updating component finished
        if (updating) {
          const entry = entries.find(
            (e: { component: string; status: string }) =>
              e.component === updating
          );
          if (entry && (entry.status === "completed" || entry.status === "failed")) {
            setUpdateResult({
              id: updating,
              status: entry.status,
              message: entry.error || entry.message,
            });
            setUpdating(null);
          }
        }
      }
      if (data.type === "error") {
        setUpdating(null);
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [updating]);

  const triggerUpdate = useCallback(
    (componentId: string) => {
      if (!iframeRef.current?.contentWindow) return;
      setUpdating(componentId);
      setUpdateResult(null);
      iframeRef.current.contentWindow.postMessage(
        { type: "start-update", component: componentId },
        "*"
      );
    },
    []
  );

  const clearResult = useCallback(() => setUpdateResult(null), []);

  return { iframeRef, updating, updateResult, triggerUpdate, clearResult };
}

/* ── Subcomponents ── */

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    running: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    healthy: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    stopped: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    partial: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
    unhealthy: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
    unknown: "bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400",
  };
  const color = colors[status] ?? colors.unknown;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${color}`}>
      {status}
    </span>
  );
}

function AppIcon({ name, icon }: { name: string; icon: string | null }) {
  const letter = name.charAt(0).toUpperCase();
  // Could be extended to render Lucide icons or emojis
  return (
    <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
      <span className="text-xs font-bold text-primary">{letter}</span>
    </div>
  );
}

function AppRow({
  id,
  name,
  icon,
  status,
  version,
  updateAvailable,
  updateInfo,
  subdomain,
  onClick,
  onUpdate,
  updating,
  isAdmin,
}: {
  id: string;
  name: string;
  icon: string | null;
  status: string;
  version: string | null;
  updateAvailable: boolean;
  updateInfo: string | null;
  subdomain?: string | null;
  onClick: () => void;
  onUpdate?: (id: string) => void;
  updating: string | null;
  isAdmin: boolean;
}) {
  return (
    <div className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent/50 transition-colors">
      <button
        onClick={onClick}
        className="flex-1 flex items-center gap-3 text-left min-w-0"
      >
        <AppIcon name={name} icon={icon} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{name}</span>
            <StatusBadge status={status} />
            {updateAvailable && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                update
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {version && <span>{version}</span>}
            {version && subdomain && <span>·</span>}
            {subdomain && <span className="font-mono">{subdomain}</span>}
            {updateInfo && (
              <>
                <span>·</span>
                <span className="text-blue-600 dark:text-blue-400">{updateInfo}</span>
              </>
            )}
          </div>
        </div>
        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
      </button>
      {updateAvailable && isAdmin && onUpdate && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onUpdate(id);
          }}
          disabled={updating === id}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0 flex items-center gap-1.5"
        >
          {updating === id ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <ArrowUpCircle className="w-3 h-3" />
          )}
          Update
        </button>
      )}
    </div>
  );
}

function SectionHeader({
  icon,
  title,
  count,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
}) {
  return (
    <div className="flex items-center gap-2 px-1 pb-2">
      {icon}
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
        {title}
      </h3>
      <span className="text-xs text-muted-foreground">({count})</span>
    </div>
  );
}

/* ── Main Component ── */

export function AppsListClient({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<UnifiedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const t = useTranslations("appsSettings");
  const { iframeRef, updating, updateResult, triggerUpdate, clearResult } =
    useUpdateBridge();

  const embedUrl = isAdmin
    ? `${window.location.origin.replace("://", "://control.")}/embed/update-progress`
    : null;

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/v1/apps/unified");
      if (res.ok) {
        setData(await res.json());
      } else {
        setError("Failed to load apps");
      }
    } catch {
      setError("Failed to load apps");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Reload after update completes
  useEffect(() => {
    if (updateResult?.status === "completed") {
      const timer = setTimeout(load, 2000);
      return () => clearTimeout(timer);
    }
  }, [updateResult, load]);

  if (loading) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading apps...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        <AlertCircle className="w-6 h-6 mx-auto mb-2 opacity-50" />
        <p>{error ?? "Failed to load apps"}</p>
        <button onClick={load} className="mt-2 text-primary hover:underline text-xs">
          Retry
        </button>
      </div>
    );
  }

  const nativeApps = data.apps.filter((a) => a.category === "user");
  const systemComponents = data.systemApps.filter(
    (a) => a.category === "system" || a.category === "infrastructure"
  );
  const hasUpdates = data.updatesAvailable.length > 0;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <LayoutGrid className="h-5 w-5" />
            {t("title")}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t("description")}
          </p>
        </div>
        <button
          onClick={load}
          className="p-2 rounded-md hover:bg-accent transition-colors text-muted-foreground"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Update result banner */}
      {updateResult && (
        <div
          className={`flex items-center justify-between px-4 py-3 rounded-lg text-sm ${
            updateResult.status === "completed"
              ? "bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300"
              : "bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-300"
          }`}
        >
          <span>
            {updateResult.status === "completed"
              ? `${updateResult.id} updated successfully`
              : `Update failed: ${updateResult.message ?? "unknown error"}`}
          </span>
          <button onClick={clearResult} className="text-xs hover:underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Updates Available */}
      {hasUpdates && isAdmin && (
        <section>
          <SectionHeader
            icon={<ArrowUpCircle className="w-4 h-4 text-blue-500" />}
            title="Updates Available"
            count={data.updatesAvailable.length}
          />
          <div className="border rounded-lg divide-y bg-blue-50/30 dark:bg-blue-950/10 border-blue-200 dark:border-blue-800/40">
            {data.updatesAvailable.map((u) => {
              const app = data.apps.find((a) => a.id === u.id);
              const sys = data.systemApps.find((a) => a.id === u.id);
              const item = app ?? sys;
              if (!item) return null;
              return (
                <AppRow
                  key={u.id}
                  id={u.id}
                  name={u.name}
                  icon={"icon" in item ? item.icon : null}
                  status={item.status}
                  version={u.version}
                  updateAvailable
                  updateInfo={u.updateInfo}
                  onClick={() => {
                    if (app) router.push(`/settings/apps/${app.id}`);
                  }}
                  onUpdate={triggerUpdate}
                  updating={updating}
                  isAdmin={isAdmin}
                />
              );
            })}
          </div>
        </section>
      )}

      {/* Installed Apps */}
      <section>
        <SectionHeader
          icon={<Package className="w-4 h-4 text-primary" />}
          title="Installed Apps"
          count={nativeApps.length}
        />
        {nativeApps.length === 0 ? (
          <div className="border rounded-lg p-8 text-center text-sm text-muted-foreground">
            No apps installed yet.
          </div>
        ) : (
          <div className="border rounded-lg divide-y">
            {nativeApps.map((app) => (
              <AppRow
                key={app.id}
                id={app.id}
                name={app.name}
                icon={app.icon}
                status={app.status}
                version={app.version}
                updateAvailable={app.updateAvailable}
                updateInfo={app.updateInfo}
                subdomain={app.subdomain}
                onClick={() => router.push(`/settings/apps/${app.id}`)}
                onUpdate={isAdmin ? triggerUpdate : undefined}
                updating={updating}
                isAdmin={isAdmin}
              />
            ))}
          </div>
        )}
      </section>

      {/* System Components (admin only) */}
      {isAdmin && systemComponents.length > 0 && (
        <section>
          <SectionHeader
            icon={<Server className="w-4 h-4 text-muted-foreground" />}
            title="System Components"
            count={systemComponents.length}
          />
          <div className="border rounded-lg divide-y">
            {systemComponents.map((app) => (
              <AppRow
                key={app.id}
                id={app.id}
                name={app.name}
                icon={app.icon}
                status={app.status}
                version={app.version}
                updateAvailable={app.updateAvailable}
                updateInfo={app.updateInfo}
                onClick={() => {}}
                onUpdate={triggerUpdate}
                updating={updating}
                isAdmin={isAdmin}
              />
            ))}
          </div>
        </section>
      )}

      {/* Hidden iframe for update-progress postMessage bridge (admin only) */}
      {embedUrl && (
        <iframe
          ref={iframeRef}
          src={embedUrl}
          style={{ display: "none" }}
          title="Update Progress Bridge"
        />
      )}
    </div>
  );
}
