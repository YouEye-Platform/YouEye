"use client";

/**
 * App Market Component — Category-Grouped Catalog + Install Flow
 *
 * Displays catalog from bridge API grouped by type (native/external)
 * and category. Install flow with generic install params, SSE streaming
 * progress, and background install support.
 * Uninstall with confirmation dialog.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Package,
  Trash2,
  RefreshCw,
  Check,
  AlertCircle,
  Loader2,
  X,
  Download,
  ExternalLink,
  CheckCircle2,
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { BridgeUnavailable } from "@/components/settings/admin/bridge-unavailable";
import { useTranslations } from "next-intl";

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
  installParams?: { name: string; label: string; required: boolean; description?: string }[];
  installInfo: {
    appId: string;
    subdomain: string;
    domain: string;
    installedAt: string;
  } | null;
}

interface InstallProgress {
  step: number;
  totalSteps: number;
  status: "running" | "success" | "error" | "skipped";
  message: string;
  detail?: string;
}

/** Emoji icons for native apps */
const NATIVE_ICON_MAP: Record<string, string> = {
  wiki: "📖",
  search: "🔍",
  notes: "📝",
  cinema: "🎬",
  weather: "🌤",
  translate: "🌐",
};

/** Map of Lucide icon names to components for marketplace apps */
const LUCIDE_ICON_MAP: Record<string, ComponentType<{ className?: string }>> = {
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

/** Category display names */
const CATEGORY_NAMES: Record<string, string> = {
  productivity: "Productivity",
  media: "Media",
  search: "Search",
  social: "Social",
  utilities: "Utilities",
};

/** Preferred category ordering */
const CATEGORY_ORDER = ["productivity", "search", "media", "social", "utilities"];

/** Renders the correct icon for a marketplace app card */
function MarketAppIcon({
  icon,
  iconUrl,
  name,
  appId,
}: {
  icon: string;
  iconUrl?: string;
  name: string;
  appId: string;
}) {
  // Proxied image URL from CP (rewrite to UI-side proxy)
  if (iconUrl && iconUrl.startsWith("/api/market/image?")) {
    const proxiedUrl = iconUrl.replace("/api/market/image?", "/api/market-image?");
    return <img src={proxiedUrl} alt={name} className="h-8 w-8 object-contain" />;
  }
  // External URL icon (http/https)
  if (iconUrl && iconUrl.startsWith("http")) {
    return <img src={iconUrl} alt={name} className="h-8 w-8 object-contain" />;
  }
  if (icon && icon.startsWith("http")) {
    return <img src={icon} alt={name} className="h-8 w-8 object-contain" />;
  }
  // Native emoji icon
  if (NATIVE_ICON_MAP[appId]) {
    return <span className="text-2xl">{NATIVE_ICON_MAP[appId]}</span>;
  }
  // Lucide icon
  if (icon && LUCIDE_ICON_MAP[icon]) {
    const IconComponent = LUCIDE_ICON_MAP[icon];
    return <IconComponent className="h-6 w-6" />;
  }
  // Fallback: first letter
  return <span className="text-lg font-medium">{name.charAt(0).toUpperCase()}</span>;
}

/** Groups apps by category, sorted in preferred order */
function groupByCategory(apps: MarketApp[]): [string, MarketApp[]][] {
  const groups: Record<string, MarketApp[]> = {};
  for (const app of apps) {
    const cat = app.category || "utilities";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(app);
  }
  // Sort by preferred order, then alphabetically for unknown categories
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

export function AppMarket() {
  const [apps, setApps] = useState<MarketApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const t = useTranslations("appMarket");
  const tc = useTranslations("common");

  // Install dialog
  const [installTarget, setInstallTarget] = useState<MarketApp | null>(null);
  const [installForm, setInstallForm] = useState<{ subdomain: string; params: Record<string, string> }>({
    subdomain: "",
    params: {},
  });
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState<InstallProgress[]>([]);
  const [installDone, setInstallDone] = useState(false);
  const progressRef = useRef<HTMLDivElement>(null);

  // Uninstall
  const [uninstallTarget, setUninstallTarget] = useState<MarketApp | null>(null);
  const [uninstalling, setUninstalling] = useState(false);

  // Domain (fetched from config)
  const [domain, setDomain] = useState("");

  const showFeedback = (type: "success" | "error", message: string) => {
    setFeedback({ type, message });
    setTimeout(() => setFeedback(null), 5000);
  };

  const fetchCatalog = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/admin/market?action=catalog");
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
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

  // Fetch domain on mount
  useEffect(() => {
    fetch("/api/admin/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.domain) setDomain(data.domain);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  // Split apps into native and external, grouped by category
  const { nativeGroups, externalGroups, nativeCount, externalCount } = useMemo(() => {
    const native = apps.filter((a) => a.integration === "native" || a.type === "native");
    const external = apps.filter((a) => a.integration === "basic" || a.type === "marketplace" || (!a.integration && !a.type));
    return {
      nativeGroups: groupByCategory(native),
      externalGroups: groupByCategory(external),
      nativeCount: native.length,
      externalCount: external.length,
    };
  }, [apps]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchCatalog();
  };

  const openInstallDialog = (app: MarketApp) => {
    setInstallTarget(app);
    // Build initial params from installParams definitions
    const initialParams: Record<string, string> = {};
    if (app.installParams) {
      for (const p of app.installParams) {
        initialParams[p.name] = "";
      }
    }
    setInstallForm({ subdomain: app.defaultSubdomain, params: initialParams });
    setInstallProgress([]);
    setInstallDone(false);
    setInstalling(false);
  };

  const handleInstall = async () => {
    if (!installTarget || !installForm.subdomain || !domain) return;
    setInstalling(true);
    setInstallProgress([]);
    setInstallDone(false);

    try {
      // Build install params from form
      const installParams: Record<string, string> = {};
      for (const [key, value] of Object.entries(installForm.params)) {
        if (value) installParams[key] = value;
      }

      const res = await fetch("/api/admin/market?action=install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: installTarget.id,
          subdomain: installForm.subdomain,
          domain: domain,
          enableSSO: installTarget.supportsSSO,
          ...(Object.keys(installParams).length > 0 ? { installParams } : {}),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Install failed" }));
        throw new Error(body.error);
      }

      if (!res.body) throw new Error("No response body");

      // Stream SSE
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const event: InstallProgress = JSON.parse(line.slice(6));
              setInstallProgress((prev) => [...prev, event]);
              // Auto-scroll
              setTimeout(() => {
                progressRef.current?.scrollTo({ top: progressRef.current.scrollHeight, behavior: "smooth" });
              }, 50);
            } catch {}
          }
        }
      }

      setInstallDone(true);
      fetchCatalog();
    } catch (err) {
      setInstallProgress((prev) => [
        ...prev,
        {
          step: 0,
          totalSteps: 0,
          status: "error" as const,
          message: err instanceof Error ? err.message : "Install failed",
        },
      ]);
      setInstallDone(true);
    } finally {
      setInstalling(false);
    }
  };

  const handleUninstall = async () => {
    if (!uninstallTarget) return;
    setUninstalling(true);
    try {
      const res = await fetch("/api/admin/market?action=uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: uninstallTarget.id }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(body.error || "Uninstall failed");
      }
      showFeedback("success", t("uninstalled", { name: uninstallTarget.name }));
      setUninstallTarget(null);
      fetchCatalog();
    } catch (err) {
      showFeedback("error", err instanceof Error ? err.message : "Uninstall failed");
    } finally {
      setUninstalling(false);
    }
  };

  /** Check if all required install params are filled */
  const installParamsValid = useMemo(() => {
    if (!installTarget?.installParams) return true;
    return installTarget.installParams.every((p) => !p.required || installForm.params[p.name]?.trim());
  }, [installTarget, installForm.params]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">{t("description")}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-40 bg-accent/30 rounded-lg animate-pulse" />
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
          <p className="text-sm text-muted-foreground mt-1">{t("description")}</p>
        </div>
        <BridgeUnavailable message={error} onRetry={handleRefresh} />
      </div>
    );
  }

  /** Render an app card */
  const renderAppCard = (app: MarketApp) => (
    <Card key={app.id} className="border hover:border-primary/30 transition">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          {/* Icon */}
          <div className="h-12 w-12 rounded-lg bg-accent flex items-center justify-center text-2xl shrink-0">
            <MarketAppIcon icon={app.icon} iconUrl={app.iconUrl} name={app.name} appId={app.id} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm">{app.name}</span>
              <Badge variant="outline" className="text-xs">
                {CATEGORY_NAMES[app.category] || app.category}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{app.description}</p>
            <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
              {app.estimatedMemory && (
                <span>
                  {app.estimatedMemory} {t("ram")}
                </span>
              )}
              {app.supportsSSO && (
                <Badge variant="secondary" className="text-xs">
                  SSO
                </Badge>
              )}
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 mt-3">
          {app.installed ? (
            <>
              <Badge className="bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20">
                <CheckCircle2 className="h-3 w-3" />
                {t("installed")}
              </Badge>
              {app.installInfo && (
                <a
                  href={`https://${app.installInfo.subdomain}.${app.installInfo.domain}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                >
                  <ExternalLink className="h-3 w-3" />
                  {t("open")}
                </a>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto text-destructive hover:text-destructive"
                onClick={() => setUninstallTarget(app)}
              >
                <Trash2 className="h-4 w-4" />
                {t("uninstall")}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => openInstallDialog(app)}>
              <Download className="h-4 w-4" />
              {t("install")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );

  /** Render a type section (Native Apps or External Apps) with category groups */
  const renderSection = (title: string, count: number, groups: [string, MarketApp[]][]) => {
    if (groups.length === 0) return null;
    return (
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">
          {title} ({count})
        </h3>
        {groups.map(([category, categoryApps]) => (
          <div key={category} className="space-y-2">
            <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              {CATEGORY_NAMES[category] || category}
            </h4>
            <div className="grid grid-cols-2 gap-3">{categoryApps.map(renderAppCard)}</div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Feedback */}
      {feedback && (
        <div
          className={`flex items-center gap-2 p-3 rounded-lg text-sm ${
            feedback.type === "success"
              ? "bg-green-500/10 text-green-600 dark:text-green-400"
              : "bg-destructive/10 text-destructive"
          }`}
        >
          {feedback.message}
          <button onClick={() => setFeedback(null)} className="ml-auto">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">{t("description")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t("refresh")}
        </Button>
      </div>

      {/* App catalog — grouped by type then category */}
      {apps.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">{t("noApps")}</p>
        </div>
      ) : (
        <div className="space-y-8">
          {renderSection("Native Apps", nativeCount, nativeGroups)}
          {renderSection("Community Apps", externalCount, externalGroups)}
        </div>
      )}

      {/* Install dialog */}
      <Dialog
        open={!!installTarget}
        onOpenChange={(open) => {
          if (!open && !installing) {
            setInstallTarget(null);
            setInstallProgress([]);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("installTitle", { name: installTarget?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("installDescription", { name: installTarget?.name ?? "" })}</DialogDescription>
          </DialogHeader>

          {installProgress.length === 0 ? (
            <>
              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <label className="text-sm font-medium">{t("subdomain")}</label>
                  <div className="flex items-center gap-2">
                    <Input
                      placeholder="app"
                      value={installForm.subdomain}
                      onChange={(e) => setInstallForm({ ...installForm, subdomain: e.target.value })}
                    />
                    <span className="text-sm text-muted-foreground shrink-0">
                      .{domain || "yourdomain.com"}
                    </span>
                  </div>
                </div>

                {/* Generic install params */}
                {installTarget?.installParams?.map((param) => (
                  <div key={param.name} className="grid gap-2">
                    <label className="text-sm font-medium">
                      {param.label}
                      {param.required && <span className="text-destructive ml-1">*</span>}
                    </label>
                    <Input
                      placeholder={param.description || param.label}
                      value={installForm.params[param.name] || ""}
                      onChange={(e) =>
                        setInstallForm({
                          ...installForm,
                          params: { ...installForm.params, [param.name]: e.target.value },
                        })
                      }
                    />
                    {param.description && (
                      <p className="text-xs text-muted-foreground">{param.description}</p>
                    )}
                  </div>
                ))}

                <div className="text-xs text-muted-foreground space-y-1">
                  <p>
                    {t("resources", {
                      memory: installTarget?.estimatedMemory ?? "",
                      cpu: installTarget?.estimatedCPU ?? "",
                    })}
                  </p>
                  <p>
                    {t("url", {
                      subdomain: installForm.subdomain,
                      domain: domain || "yourdomain.com",
                    })}
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setInstallTarget(null)}>
                  {tc("cancel")}
                </Button>
                <Button
                  onClick={handleInstall}
                  disabled={!installForm.subdomain || !domain || !installParamsValid}
                >
                  <Download className="h-4 w-4" />
                  {t("install")}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              {/* Progress panel */}
              <div ref={progressRef} className="max-h-64 overflow-y-auto space-y-2 py-4">
                {installProgress.map((event, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-2 text-sm ${
                      event.status === "error"
                        ? "text-destructive"
                        : event.status === "success"
                          ? "text-green-600 dark:text-green-400"
                          : event.status === "skipped"
                            ? "text-muted-foreground"
                            : ""
                    }`}
                  >
                    {event.status === "running" && <Loader2 className="h-4 w-4 animate-spin shrink-0 mt-0.5" />}
                    {event.status === "success" && <Check className="h-4 w-4 shrink-0 mt-0.5" />}
                    {event.status === "error" && <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />}
                    {event.status === "skipped" && (
                      <span className="h-4 w-4 shrink-0 mt-0.5 text-center">&mdash;</span>
                    )}
                    <div>
                      <span>
                        {event.totalSteps > 0 && `[${event.step}/${event.totalSteps}] `}
                        {event.message}
                      </span>
                      {event.detail && <p className="text-xs text-muted-foreground mt-0.5">{event.detail}</p>}
                    </div>
                  </div>
                ))}
              </div>
              {installDone && (
                <DialogFooter>
                  <Button
                    onClick={() => {
                      setInstallTarget(null);
                      setInstallProgress([]);
                    }}
                  >
                    {tc("close")}
                  </Button>
                </DialogFooter>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Uninstall confirmation */}
      <AlertDialog
        open={!!uninstallTarget}
        onOpenChange={(open) => {
          if (!open) setUninstallTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("uninstallConfirm", { name: uninstallTarget?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("uninstallDescription", { name: uninstallTarget?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleUninstall}
              disabled={uninstalling}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {uninstalling && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("uninstall")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
