/**
 * App Market — Main Page
 *
 * Full-page app market experience with search/filter
 * and category-grouped app cards.
 */

"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Search,
  RefreshCw,
  Loader2,
  Package,
  ArrowLeft,
  Sparkles,
  CheckCircle2,
} from "lucide-react";
import type { ComponentType } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useTranslations } from "next-intl";

/* ── Types ── */

interface MarketApp {
  id: string;
  name: string;
  description: string;
  icon: string;
  iconUrl?: string;
  category: string;
  type?: "native" | "marketplace";
  integration?: "native" | "basic";
  defaultSubdomain: string;
  supportsSSO: boolean;
  estimatedMemory: string;
  estimatedCPU: string;
  website: string;
  tags: string[];
  installed: boolean;
  installParams?: {
    name: string;
    label: string;
    required: boolean;
    description?: string;
  }[];
  installInfo: {
    appId: string;
    subdomain: string;
    domain: string;
    installedAt: string;
  } | null;
}

interface InstallProgressEvent {
  step: number;
  totalSteps: number;
  status: "running" | "success" | "error" | "skipped";
  message: string;
  detail?: string;
}

interface InstallProgressInfo {
  events: InstallProgressEvent[];
  done: boolean;
}

/* ── Constants ── */

const NATIVE_ICON_MAP: Record<string, string> = {
  wiki: "\u{1F4D6}",
  search: "\u{1F50D}",
  notes: "\u{1F4DD}",
  cinema: "\u{1F3AC}",
  weather: "\u{1F324}",
  translate: "\u{1F310}",
};

const CATEGORY_NAMES: Record<string, string> = {
  productivity: "Productivity",
  media: "Media",
  search: "Search",
  social: "Social",
  utilities: "Utilities",
};

const CATEGORY_ORDER = [
  "productivity",
  "search",
  "media",
  "social",
  "utilities",
];

/* ── Helpers ── */

/** Rewrite CP-relative proxy URLs to UI-local proxy */
function resolveImageUrl(url?: string): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("/api/market/image?")) {
    return url.replace("/api/market/image?", "/api/market-image?");
  }
  return url;
}

function AppIcon({
  icon,
  iconUrl,
  name,
  appId,
  size = "md",
}: {
  icon: string;
  iconUrl?: string;
  name: string;
  appId: string;
  size?: "sm" | "md" | "lg";
}) {
  const sizeClasses = {
    sm: "h-10 w-10 text-xl",
    md: "h-14 w-14 text-3xl",
    lg: "h-20 w-20 text-5xl",
  };
  const imgClasses = {
    sm: "h-6 w-6",
    md: "h-9 w-9",
    lg: "h-14 w-14",
  };

  const resolvedIconUrl = resolveImageUrl(iconUrl);

  const content = (() => {
    if (resolvedIconUrl && (resolvedIconUrl.startsWith("http") || resolvedIconUrl.startsWith("/api/"))) {
      return (
        <img
          src={resolvedIconUrl}
          alt={name}
          className={`${imgClasses[size]} object-contain`}
        />
      );
    }
    if (icon && icon.startsWith("http")) {
      return (
        <img
          src={icon}
          alt={name}
          className={`${imgClasses[size]} object-contain`}
        />
      );
    }
    if (NATIVE_ICON_MAP[appId]) {
      return <span>{NATIVE_ICON_MAP[appId]}</span>;
    }
    return (
      <span className="font-semibold text-muted-foreground">
        {name.charAt(0).toUpperCase()}
      </span>
    );
  })();

  return (
    <div
      className={`${sizeClasses[size]} rounded-2xl bg-accent/60 border border-border/50 flex items-center justify-center shrink-0`}
    >
      {content}
    </div>
  );
}

function groupByCategory(apps: MarketApp[]): [string, MarketApp[]][] {
  const groups: Record<string, MarketApp[]> = {};
  for (const app of apps) {
    const cat = app.category || "utilities";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(app);
  }
  const entries = Object.entries(groups);
  entries.sort(([a], [b]) => {
    const ai = CATEGORY_ORDER.indexOf(a);
    const bi = CATEGORY_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
  return entries;
}

/* ── Component ── */

export default function AppStorePage() {
  const router = useRouter();
  const t = useTranslations("appMarket");
  const [apps, setApps] = useState<MarketApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [installProgresses, setInstallProgresses] = useState<Record<string, InstallProgressInfo>>({});

  const fetchCatalog = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/admin/market?action=catalog");
      if (!res.ok) {
        const body = await res
          .json()
          .catch(() => ({ error: "Unknown error" }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json = await res.json();
      setApps(json.apps ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load catalog");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  // Poll install progress for active installs
  useEffect(() => {
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch("/api/admin/market?action=install-progress");
        if (res.ok) {
          const data = await res.json();
          const progresses: Record<string, InstallProgressInfo> = {};
          for (const install of data.installs || []) {
            progresses[install.appId] = { events: install.events, done: install.done };
          }
          setInstallProgresses(progresses);
          // Refresh catalog if any install just finished
          const anyDone = (data.installs || []).some((i: { done: boolean }) => i.done);
          if (anyDone) {
            fetchCatalog();
          }
        }
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(pollInterval);
  }, [fetchCatalog]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchCatalog();
  };

  // Filter apps by search query
  const filteredApps = useMemo(() => {
    if (!searchQuery.trim()) return apps;
    const q = searchQuery.toLowerCase();
    return apps.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q) ||
        a.tags?.some((tag) => tag.toLowerCase().includes(q))
    );
  }, [apps, searchQuery]);

  // Split into native / external
  const { nativeGroups, externalGroups } = useMemo(() => {
    const native = filteredApps.filter((a) => a.integration === "native" || a.type === "native");
    const external = filteredApps.filter((a) => a.integration === "basic" || a.type === "marketplace" || (!a.integration && !a.type));
    return {
      nativeGroups: groupByCategory(native),
      externalGroups: groupByCategory(external),
    };
  }, [filteredApps]);

  /* ── Render ── */

  return (
    <div className="min-h-[calc(100vh-3.5rem)]">
      {/* Hero / Header */}
      <div className="border-b bg-gradient-to-b from-accent/30 to-background">
        <div className="max-w-6xl mx-auto px-6 pt-8 pb-6">
          {/* Top nav row */}
          <div className="flex items-center justify-between mb-6">
            <Link
              href="/"
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Dashboard
            </Link>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              {refreshing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {t("refresh")}
            </Button>
          </div>

          {/* Title + Search */}
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
                <Sparkles className="h-8 w-8 text-primary" />
                App Market
              </h1>
              <p className="text-muted-foreground mt-1">
                {t("description")}
              </p>
            </div>
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search apps..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Loading */}
        {loading && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="h-48 bg-accent/30 rounded-xl animate-pulse"
              />
            ))}
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="text-center py-16">
            <div className="inline-flex items-center gap-2 text-destructive bg-destructive/10 px-4 py-2 rounded-lg">
              {error}
            </div>
            <div className="mt-4">
              <Button variant="outline" onClick={handleRefresh}>
                <RefreshCw className="h-4 w-4" />
                Try again
              </Button>
            </div>
          </div>
        )}

        {/* Content */}
        {!loading && !error && (
          <div className="space-y-10">
            {/* Empty state */}
            {filteredApps.length === 0 && (
              <div className="text-center py-16 text-muted-foreground">
                <Package className="h-12 w-12 mx-auto mb-3 opacity-40" />
                {searchQuery ? (
                  <p>No apps matching &quot;{searchQuery}&quot;</p>
                ) : (
                  <p>{t("noApps")}</p>
                )}
              </div>
            )}

            {/* Native Apps */}
            {nativeGroups.length > 0 && (
              <section>
                <h2 className="text-xl font-semibold mb-5 flex items-center gap-2">
                  <span className="text-2xl">{"\u{1F3E0}"}</span>
                  Native Apps
                </h2>
                {nativeGroups.map(([category, categoryApps]) => (
                  <div key={category} className="mb-6">
                    <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
                      {CATEGORY_NAMES[category] || category}
                    </h3>
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                      {categoryApps.map((app) => (
                        <AppCard
                          key={app.id}
                          app={app}
                          onClick={() =>
                            router.push(`/app-store/${app.id}`)
                          }
                          installProgress={installProgresses[app.id]}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            )}

            {/* External Apps */}
            {externalGroups.length > 0 && (
              <section>
                <h2 className="text-xl font-semibold mb-5 flex items-center gap-2">
                  <span className="text-2xl">{"\u{1F4E6}"}</span>
                  Community Apps
                </h2>
                {externalGroups.map(([category, categoryApps]) => (
                  <div key={category} className="mb-6">
                    <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
                      {CATEGORY_NAMES[category] || category}
                    </h3>
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                      {categoryApps.map((app) => (
                        <AppCard
                          key={app.id}
                          app={app}
                          onClick={() =>
                            router.push(`/app-store/${app.id}`)
                          }
                          installProgress={installProgresses[app.id]}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── App Card ── */

function AppCard({ app, onClick, installProgress }: { app: MarketApp; onClick: () => void; installProgress?: InstallProgressInfo }) {
  const isInstalling = installProgress && !installProgress.done && installProgress.events.length > 0;
  const lastEvent = installProgress?.events[installProgress.events.length - 1];

  const handleStopInstall = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await fetch("/api/admin/market?action=cancel-install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: app.id }),
      });
    } catch { /* best effort */ }
  };

  return (
    <button
      onClick={onClick}
      className="group text-left rounded-xl border bg-card p-4 hover:border-primary/30 hover:shadow-md transition-all duration-200"
    >
      <div className="flex items-start gap-3">
        <AppIcon
          icon={app.icon}
          iconUrl={app.iconUrl}
          name={app.name}
          appId={app.id}
          size="md"
        />
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-sm group-hover:text-primary transition-colors truncate">
            {app.name}
          </h3>
          <span className="text-xs text-muted-foreground">
            {CATEGORY_NAMES[app.category] || app.category}
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mt-2 line-clamp-2">
        {app.description}
      </p>
      {isInstalling && lastEvent ? (
        <div className="mt-3 pt-2 border-t border-border/50">
          <div className="h-1.5 bg-accent/40 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-500"
              style={{
                width: `${lastEvent.totalSteps > 0 ? Math.round((lastEvent.step / lastEvent.totalSteps) * 100) : 10}%`,
              }}
            />
          </div>
          <div className="flex items-center justify-between mt-1">
            <p className="text-xs text-muted-foreground truncate flex-1 mr-2">
              {lastEvent.message}
            </p>
            <span
              role="button"
              tabIndex={0}
              onClick={handleStopInstall}
              onKeyDown={(e) => { if (e.key === 'Enter') handleStopInstall(e as unknown as React.MouseEvent); }}
              className="text-xs text-destructive hover:text-destructive/80 font-medium shrink-0 cursor-pointer"
            >
              Stop
            </span>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between mt-3">
          {app.installed ? (
            <Badge className="bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20 text-xs">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              Installed
            </Badge>
          ) : (
            <Badge
              variant="secondary"
              className="text-xs font-semibold px-3"
            >
              GET
            </Badge>
          )}
          {app.supportsSSO && (
            <Badge variant="outline" className="text-xs">
              SSO
            </Badge>
          )}
        </div>
      )}
    </button>
  );
}
