"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  LayoutGrid,
  ChevronRight,
  Package,
  Loader2,
  AlertCircle,
  Search,
  BookOpen,
  StickyNote,
  Film,
  CloudSun,
  Languages,
  Camera,
  MessageCircle,
} from "lucide-react";
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

/* ── Lucide Icon Map ── */

const ICON_MAP: Record<string, ComponentType<{ className?: string }>> = {
  search: Search,
  "book-open": BookOpen,
  "sticky-note": StickyNote,
  film: Film,
  "cloud-sun": CloudSun,
  languages: Languages,
  camera: Camera,
  "message-circle": MessageCircle,
  package: Package,
};

function toKebabCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/* ── Subcomponents ── */

function StatusDot({ status }: { status: string | null }) {
  const s = status ?? "unknown";
  const colors: Record<string, string> = {
    running: "bg-green-500",
    healthy: "bg-green-500",
    stopped: "bg-red-500",
    partial: "bg-yellow-500",
    unhealthy: "bg-yellow-500",
    unknown: "bg-gray-400",
  };
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${colors[s] ?? colors.unknown}`} />;
}

function AppIcon({ name, icon, customIconUrl }: { name: string; icon: string | null; customIconUrl?: string | null }) {
  if (customIconUrl) {
    return (
      <div className="w-9 h-9 rounded-lg overflow-hidden shrink-0 flex items-center justify-center">
        <img src={customIconUrl} alt={name} className="w-9 h-9 rounded-lg object-cover" />
      </div>
    );
  }
  if (icon && icon.startsWith("emoji:")) {
    return (
      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0">
        <span className="text-lg leading-none">{icon.slice(6)}</span>
      </div>
    );
  }
  if (icon && (icon.startsWith("http") || icon.startsWith("/"))) {
    return (
      <div className="w-9 h-9 rounded-lg overflow-hidden shrink-0 flex items-center justify-center">
        <img src={icon} alt={name} className="w-9 h-9 rounded-lg object-cover" />
      </div>
    );
  }
  if (icon) {
    const key = toKebabCase(icon);
    const IconComponent = ICON_MAP[key];
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

  // Listen for postMessage from CP apps embed (admin app navigation)
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type === "youeye-app-navigate" && e.data.appId) {
        router.push(`/settings/apps/${e.data.appId}`);
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [router]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <LayoutGrid className="h-5 w-5" />
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">{t("description")}</p>
      </div>

      {/* Admin: Updates available banner (self-collapses when no updates) */}
      {isAdmin && updatesEmbedUrl && (
        <AdminEmbed signedUrl={updatesEmbedUrl} title="Updates Available" minHeight={0} />
      )}

      {/* App list (everyone) — personalized icons + names */}
      <UserAppList />

      {/* Admin: System components (infrastructure, system services) */}
      {isAdmin && systemEmbedUrl && (
        <AdminEmbed signedUrl={systemEmbedUrl} title="System Components" minHeight={200} />
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
    <div className="border rounded-xl divide-y">
      {apps.map((app) => (
        <button
          key={app.id}
          onClick={() => router.push(`/settings/apps/${app.id}`)}
          className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent/40 transition-colors text-left"
        >
          <AppIcon name={app.name} icon={app.icon} customIconUrl={app.custom_icon_url} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">{app.name}</span>
              <StatusDot status={app.status} />
            </div>
            {app.version && (
              <span className="text-xs text-muted-foreground font-mono">{app.version}</span>
            )}
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground/50 shrink-0" />
        </button>
      ))}
    </div>
  );
}
