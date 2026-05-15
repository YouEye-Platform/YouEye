"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  LayoutGrid,
  ChevronRight,
  Loader2,
  AlertCircle,
} from "lucide-react";
import * as LucideIcons from "lucide-react";
import type { ComponentType } from "react";
import { AdminEmbed } from "@/components/settings/admin-embed";

/* ── Types ── */

interface DrawerApp {
  id: string;
  name: string;
  icon: string | null;
  custom_icon_url: string | null;
  status: string | null;
  version: string | null;
  subdomain: string | null;
  url: string;
}

/* ── Dynamic Lucide Icon Lookup ── */

function kebabToPascal(s: string): string {
  return s.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

function getLucideIcon(name: string): ComponentType<{ className?: string }> | undefined {
  const pascal = kebabToPascal(name);
  const icon = (LucideIcons as Record<string, unknown>)[pascal];
  if (typeof icon === "function" || (typeof icon === "object" && icon !== null && "$$typeof" in (icon as Record<string, unknown>))) {
    return icon as ComponentType<{ className?: string }>;
  }
  return undefined;
}

/* ── Status Maps ── */

const STATUS_DOT_COLORS: Record<string, string> = {
  running: "bg-green-500",
  healthy: "bg-green-500",
  stopped: "bg-red-500",
  partial: "bg-yellow-500",
  unhealthy: "bg-yellow-500",
  unknown: "bg-gray-400",
};

const STATUS_TEXT_COLORS: Record<string, string> = {
  running: "text-green-500",
  healthy: "text-green-500",
  stopped: "text-red-500",
  partial: "text-yellow-500",
  unhealthy: "text-yellow-500",
  unknown: "text-muted-foreground",
};

const STATUS_LABELS: Record<string, string> = {
  running: "Running",
  healthy: "Running",
  stopped: "Stopped",
  partial: "Partial",
  unhealthy: "Unhealthy",
  unknown: "Unknown",
};

/* ── Subcomponents ── */

function AppIcon({ name, icon, customIconUrl }: { name: string; icon: string | null; customIconUrl?: string | null }) {
  // Resolve display icon: customIconUrl overrides icon
  const displayIcon = customIconUrl ?? icon;
  if (displayIcon && displayIcon.startsWith("emoji:")) {
    return (
      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0">
        <span className="text-lg leading-none">{displayIcon.slice(6)}</span>
      </div>
    );
  }
  if (displayIcon && (displayIcon.startsWith("http") || displayIcon.startsWith("/") || displayIcon.startsWith("data:"))) {
    return (
      <div className="w-9 h-9 rounded-lg overflow-hidden shrink-0 flex items-center justify-center">
        <img src={displayIcon} alt={name} className="w-9 h-9 rounded-lg object-cover" />
      </div>
    );
  }
  if (displayIcon) {
    const IconComponent = getLucideIcon(displayIcon);
    if (IconComponent) {
      return (
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0">
          <IconComponent className="w-4.5 h-4.5 text-muted-foreground" />
        </div>
      );
    }
  }
  return (
    <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0">
      <span className="text-sm font-bold text-muted-foreground">{name.charAt(0).toUpperCase()}</span>
    </div>
  );
}

/* ── Main Component ── */

export function AppsListClient({
  isAdmin,
  updatesEmbedUrl,
  systemEmbedUrl,
}: {
  isAdmin: boolean;
  updatesEmbedUrl: string | null;
  systemEmbedUrl: string | null;
}) {
  const router = useRouter();
  const t = useTranslations("appsSettings");
  const updatesContainerRef = useRef<HTMLDivElement>(null);
  const [updateCount, setUpdateCount] = useState(0);
  const [checking, setChecking] = useState(false);

  // Listen for postMessage from the Control Panel apps embed
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type === "youeye-app-navigate" && e.data.appId) {
        router.push(`/settings/apps/${e.data.appId}`);
      }
      if (e.data?.type === "youeye-embed-update-count" && typeof e.data.count === "number") {
        setUpdateCount(e.data.count);
      }
      if (e.data?.type === "youeye-embed-check-complete") {
        setChecking(false);
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [router]);

  function handleCheckUpdates() {
    setChecking(true);
    const iframe = updatesContainerRef.current?.querySelector("iframe");
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({ type: "youeye-embed-check-updates" }, "*");
    }
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <LayoutGrid className="h-5 w-5" />
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">{t("description")}</p>
      </div>

      {/* Updates section — header rendered here, cards in embed */}
      {isAdmin && updatesEmbedUrl && (
        <div>
          <div className="flex items-center justify-between mb-4">
            {updateCount > 0 ? (
              <div>
                <h3 className="text-base font-semibold">{t("updatesAvailable")}</h3>
                <p className="text-[13px] text-muted-foreground mt-0.5">
                  {updateCount} {updateCount === 1 ? t("updateSingular") : t("updatePlural")}
                </p>
              </div>
            ) : (
              <div />
            )}
            <button
              onClick={handleCheckUpdates}
              disabled={checking}
              className="px-3 py-1.5 rounded-md border text-[13px] bg-background hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {checking ? t("checking") : t("checkForUpdates")}
            </button>
          </div>
          <div ref={updatesContainerRef}>
            <AdminEmbed signedUrl={updatesEmbedUrl} title="Updates" minHeight={0} />
          </div>
        </div>
      )}

      {/* Installed Apps section */}
      <div>
        <h3 className="text-base font-semibold">{t("installedApps")}</h3>
        <p className="text-[13px] text-muted-foreground mt-0.5">{t("installedAppsDescription")}</p>
      </div>
      <UserAppList />

      {/* System Components section — header rendered here, cards in embed */}
      {isAdmin && systemEmbedUrl && (
        <div>
          <div className="mb-4">
            <h3 className="text-base font-semibold">{t("systemComponents")}</h3>
            <p className="text-[13px] text-muted-foreground mt-0.5">{t("systemComponentsDescription")}</p>
          </div>
          <AdminEmbed signedUrl={systemEmbedUrl} title="System Components" minHeight={200} />
        </div>
      )}
    </div>
  );
}

/* ── Regular User App List (local DB only) ── */

function UserAppList() {
  const [apps, setApps] = useState<DrawerApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/v1/apps/drawer");
      if (res.ok) {
        const data = await res.json();
        setApps(data.apps ?? []);
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

  if (loading) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading apps...
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        <AlertCircle className="w-6 h-6 mx-auto mb-2 opacity-50" />
        <p>{error}</p>
        <button onClick={load} className="mt-2 text-primary hover:underline text-xs">Retry</button>
      </div>
    );
  }

  if (apps.length === 0) {
    return (
      <div className="border rounded-xl p-8 text-center text-sm text-muted-foreground">
        No apps installed yet.
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {apps.map((app) => {
        const s = app.status ?? "unknown";
        return (
          <button
            key={app.id}
            onClick={() => router.push(`/settings/apps/${app.id}`)}
            className="w-full flex items-center gap-3 border rounded-lg px-3.5 py-2.5 hover:bg-accent/40 transition-colors text-left"
          >
            <AppIcon name={app.name} icon={app.icon} customIconUrl={app.custom_icon_url} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[13px] font-medium truncate">{app.name}</span>
                {app.version && (
                  <span className="text-xs text-muted-foreground font-mono">v{app.version}</span>
                )}
              </div>
              <div className="flex items-center gap-1 mt-0.5">
                <span className={`w-[5px] h-[5px] rounded-full shrink-0 ${STATUS_DOT_COLORS[s] ?? STATUS_DOT_COLORS.unknown}`} />
                <span className={`text-xs ${STATUS_TEXT_COLORS[s] ?? STATUS_TEXT_COLORS.unknown}`}>
                  {STATUS_LABELS[s] ?? s}
                </span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground/50 shrink-0" />
          </button>
        );
      })}
    </div>
  );
}
