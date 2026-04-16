/**
 * App Market — App Detail Page
 *
 * Full detail view for a single app with install/uninstall actions,
 * streaming install progress inline, and app metadata.
 */

"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Download,
  Trash2,
  ExternalLink,
  Loader2,
  Check,
  AlertCircle,
  X,
  Cpu,
  MemoryStick,
  Shield,
  Globe,
  Tag,
  CheckCircle2,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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
  detail?: {
    longDescription: string;
    screenshots: { url: string; caption?: string }[];
  };
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

interface InstallProgress {
  step: number;
  totalSteps: number;
  status: "running" | "success" | "error" | "skipped";
  message: string;
  detail?: string;
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

/* ── Icon component ── */

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
}: {
  icon: string;
  iconUrl?: string;
  name: string;
  appId: string;
}) {
  const resolved = resolveImageUrl(iconUrl);
  if (resolved && (resolved.startsWith("http") || resolved.startsWith("/api/"))) {
    return (
      <img src={resolved} alt={name} className="h-16 w-16 object-contain" />
    );
  }
  if (icon && icon.startsWith("http")) {
    return (
      <img src={icon} alt={name} className="h-16 w-16 object-contain" />
    );
  }
  if (NATIVE_ICON_MAP[appId]) {
    return <span className="text-6xl">{NATIVE_ICON_MAP[appId]}</span>;
  }
  return (
    <span className="text-4xl font-bold text-muted-foreground">
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/* ── Component ── */

export default function AppDetailPage() {
  const params = useParams();
  const router = useRouter();
  const appId = params.appId as string;
  const t = useTranslations("appMarket");
  const tc = useTranslations("common");

  const [app, setApp] = useState<MarketApp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [domain, setDomain] = useState("");

  // Install
  const [showInstallForm, setShowInstallForm] = useState(false);
  const [installForm, setInstallForm] = useState<{
    subdomain: string;
    params: Record<string, string>;
  }>({ subdomain: "", params: {} });
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState<InstallProgress[]>(
    []
  );
  const [installDone, setInstallDone] = useState(false);
  const progressRef = useRef<HTMLDivElement>(null);

  // Uninstall
  const [showUninstall, setShowUninstall] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);

  const fetchApp = useCallback(async () => {
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
      const found = (json.apps ?? []).find(
        (a: MarketApp) => a.id === appId
      );
      if (!found) throw new Error("App not found");
      setApp(found);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load app");
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    fetch("/api/admin/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.domain) setDomain(data.domain);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchApp();
  }, [fetchApp]);

  const openInstallForm = () => {
    if (!app) return;
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
    setShowInstallForm(true);
  };

  // Check on mount if there's already an active install for this app
  useEffect(() => {
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    async function checkExistingInstall() {
      try {
        const res = await fetch(`/api/admin/market?action=install-progress&app=${encodeURIComponent(appId)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.events && data.events.length > 0) {
            setInstallProgress(data.events);
            setShowInstallForm(true);
            if (data.done) {
              setInstallDone(true);
            } else {
              // Reconnect to an in-flight install via polling
              setInstalling(true);
              pollInterval = setInterval(async () => {
                try {
                  const r = await fetch(`/api/admin/market?action=install-progress&app=${encodeURIComponent(appId)}`);
                  if (r.ok) {
                    const d = await r.json();
                    setInstallProgress(d.events || []);
                    if (d.done) {
                      setInstallDone(true);
                      setInstalling(false);
                      if (pollInterval) clearInterval(pollInterval);
                      fetchApp();
                    }
                  }
                } catch { /* ignore */ }
              }, 1500);
            }
          }
        }
      } catch { /* ignore */ }
    }
    checkExistingInstall();
    return () => { if (pollInterval) clearInterval(pollInterval); };
  }, [appId, fetchApp]);

  const handleInstall = async () => {
    if (!app || !installForm.subdomain || !domain) return;
    setInstalling(true);
    setInstallProgress([]);
    setInstallDone(false);

    try {
      const installParams: Record<string, string> = {};
      for (const [key, value] of Object.entries(installForm.params)) {
        if (value) installParams[key] = value;
      }

      const res = await fetch("/api/admin/market?action=install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: app.id,
          subdomain: installForm.subdomain,
          domain: domain,
          enableSSO: app.supportsSSO,
          ...(Object.keys(installParams).length > 0
            ? { installParams }
            : {}),
        }),
      });

      if (!res.ok) {
        const body = await res
          .json()
          .catch(() => ({ error: "Install failed" }));
        throw new Error(body.error);
      }

      // Stream SSE events from the response body
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event: InstallProgress = JSON.parse(line.slice(6));
            setInstallProgress((prev) => {
              const existingIdx = prev.findIndex(
                (e) => e.step === event.step && e.status === "running"
              );
              if (existingIdx >= 0 && event.status !== "running") {
                const next = [...prev];
                next[existingIdx] = event;
                return next;
              }
              return [...prev, event];
            });
            setTimeout(() => {
              progressRef.current?.scrollTo({
                top: progressRef.current.scrollHeight,
                behavior: "smooth",
              });
            }, 50);
          } catch {
            // ignore malformed events
          }
        }
      }

      setInstallDone(true);
      setInstalling(false);
      fetchApp();
    } catch (err) {
      setInstallProgress((prev) => [
        ...prev,
        {
          step: 0,
          totalSteps: 0,
          status: "error" as const,
          message:
            err instanceof Error ? err.message : "Install failed",
        },
      ]);
      setInstallDone(true);
      setInstalling(false);
    }
  };

  const handleCancelInstall = async () => {
    if (!app) return;
    try {
      await fetch("/api/admin/market?action=cancel-install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: app.id }),
      });
    } catch {
      // best effort
    }
  };

  const handleUninstall = async () => {
    if (!app) return;
    setUninstalling(true);
    try {
      const res = await fetch("/api/admin/market?action=uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: app.id }),
      });
      if (!res.ok) {
        const body = await res
          .json()
          .catch(() => ({ error: "Failed" }));
        throw new Error(body.error || "Uninstall failed");
      }
      setShowUninstall(false);
      fetchApp();
    } catch (err) {
      // stay on dialog
    } finally {
      setUninstalling(false);
    }
  };

  const installParamsValid = useMemo(() => {
    if (!app?.installParams) return true;
    return app.installParams.every(
      (p) => !p.required || installForm.params[p.name]?.trim()
    );
  }, [app, installForm.params]);

  /* ── Loading ── */
  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-12">
        <div className="animate-pulse space-y-6">
          <div className="h-6 w-32 bg-accent/40 rounded" />
          <div className="flex gap-6">
            <div className="h-24 w-24 bg-accent/40 rounded-2xl" />
            <div className="flex-1 space-y-3">
              <div className="h-8 w-48 bg-accent/40 rounded" />
              <div className="h-4 w-64 bg-accent/40 rounded" />
              <div className="h-10 w-32 bg-accent/40 rounded" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ── Error ── */
  if (error || !app) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-12 text-center">
        <p className="text-destructive mb-4">{error || "App not found"}</p>
        <Button variant="outline" onClick={() => router.push("/app-store")}>
          <ArrowLeft className="h-4 w-4" />
          Back to App Market
        </Button>
      </div>
    );
  }

  /* ── Render ── */
  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* Back */}
      <Link
        href="/app-store"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-8"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to App Market
      </Link>

      {/* App Header */}
      <div className="flex items-start gap-6 mb-8">
        <div className="h-24 w-24 rounded-2xl bg-accent/60 border border-border/50 flex items-center justify-center shrink-0">
          <AppIcon
            icon={app.icon}
            iconUrl={app.iconUrl}
            name={app.name}
            appId={app.id}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold">{app.name}</h1>
            {app.installed && (
              <Badge className="bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20">
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Installed
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 mb-1">
            <Badge variant="outline" className="text-xs">
              {CATEGORY_NAMES[app.category] || app.category}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {(app.integration === "native" || app.type === "native") ? "Native Integration" : "Community App"}
            </span>
          </div>
          <p className="text-muted-foreground mt-2">{app.description}</p>

          {/* Action Buttons */}
          <div className="flex items-center gap-3 mt-4">
            {app.installed ? (
              <>
                {app.installInfo && (
                  <Button asChild>
                    <a
                      href={`https://${app.installInfo.subdomain}.${app.installInfo.domain}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="h-4 w-4" />
                      Open App
                    </a>
                  </Button>
                )}
                <Button
                  variant="destructive"
                  onClick={() => setShowUninstall(true)}
                >
                  <Trash2 className="h-4 w-4" />
                  {t("uninstall")}
                </Button>
              </>
            ) : (
              <Button size="lg" onClick={openInstallForm}>
                <Download className="h-4 w-4" />
                {t("install")}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Install Form (inline) */}
      {showInstallForm && !app.installed && (
        <Card className="mb-8 border-primary/20">
          <CardContent className="p-6">
            {installProgress.length === 0 ? (
              <>
                <h3 className="font-semibold mb-4">
                  {t("installTitle", { name: app.name })}
                </h3>

                <div className="grid gap-4">
                  {/* Subdomain */}
                  <div className="grid gap-2">
                    <label className="text-sm font-medium">
                      {t("subdomain")}
                    </label>
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder="app"
                        value={installForm.subdomain}
                        onChange={(e) =>
                          setInstallForm({
                            ...installForm,
                            subdomain: e.target.value,
                          })
                        }
                        className="max-w-xs"
                      />
                      <span className="text-sm text-muted-foreground shrink-0">
                        .{domain || "yourdomain.com"}
                      </span>
                    </div>
                  </div>

                  {/* Generic install params */}
                  {app.installParams?.map((param) => (
                    <div key={param.name} className="grid gap-2">
                      <label className="text-sm font-medium">
                        {param.label}
                        {param.required && (
                          <span className="text-destructive ml-1">*</span>
                        )}
                      </label>
                      <Input
                        placeholder={param.description || param.label}
                        value={installForm.params[param.name] || ""}
                        onChange={(e) =>
                          setInstallForm({
                            ...installForm,
                            params: {
                              ...installForm.params,
                              [param.name]: e.target.value,
                            },
                          })
                        }
                        className="max-w-md"
                      />
                      {param.description && (
                        <p className="text-xs text-muted-foreground">
                          {param.description}
                        </p>
                      )}
                    </div>
                  ))}

                  {/* Info */}
                  <div className="text-xs text-muted-foreground space-y-1">
                    <p>
                      {t("resources", {
                        memory: app.estimatedMemory ?? "",
                        cpu: app.estimatedCPU ?? "",
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

                {/* Actions */}
                <div className="flex items-center gap-3 mt-6">
                  <Button
                    onClick={handleInstall}
                    disabled={
                      !installForm.subdomain ||
                      !domain ||
                      !installParamsValid ||
                      installing
                    }
                  >
                    {installing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    {t("install")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setShowInstallForm(false)}
                    disabled={installing}
                  >
                    {tc("cancel")}
                  </Button>
                </div>
              </>
            ) : (
              <>
                {/* Progress */}
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold">
                    {installDone
                      ? installProgress.some((e) => e.status === "error")
                        ? `${app.name} installation failed`
                        : `${app.name} installed!`
                      : `Installing ${app.name}...`}
                  </h3>
                  {installing && !installDone && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={handleCancelInstall}
                    >
                      <Square className="h-3 w-3 mr-1" />
                      Stop
                    </Button>
                  )}
                </div>

                {/* Progress bar */}
                {installProgress.length > 0 && (() => {
                  const lastEvent = installProgress[installProgress.length - 1];
                  const pct = lastEvent.totalSteps > 0
                    ? Math.round((lastEvent.step / lastEvent.totalSteps) * 100)
                    : 0;
                  return (
                    <div className="mb-4">
                      <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                        <span>{lastEvent.message}</span>
                        <span>{pct}%</span>
                      </div>
                      <div className="h-2 bg-accent/40 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${
                            lastEvent.status === "error"
                              ? "bg-destructive"
                              : installDone && !installProgress.some((e) => e.status === "error")
                                ? "bg-green-500"
                                : "bg-primary"
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })()}

                <div
                  ref={progressRef}
                  className="max-h-72 overflow-y-auto space-y-2"
                >
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
                      {event.status === "running" && (
                        <Loader2 className="h-4 w-4 animate-spin shrink-0 mt-0.5" />
                      )}
                      {event.status === "success" && (
                        <Check className="h-4 w-4 shrink-0 mt-0.5" />
                      )}
                      {event.status === "error" && (
                        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                      )}
                      {event.status === "skipped" && (
                        <span className="h-4 w-4 shrink-0 mt-0.5 text-center">
                          &mdash;
                        </span>
                      )}
                      <div>
                        <span>
                          {event.totalSteps > 0 &&
                            `[${event.step}/${event.totalSteps}] `}
                          {event.message}
                        </span>
                        {event.detail && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {event.detail}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                {installDone && (
                  <div className="mt-4">
                    <Button
                      onClick={() => {
                        setShowInstallForm(false);
                        setInstallProgress([]);
                      }}
                    >
                      {tc("close")}
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Description */}
      {app.detail?.longDescription && (
        <Card className="mb-6">
          <CardContent className="p-5">
            <h3 className="font-semibold text-sm mb-3">About</h3>
            <p className="text-sm text-muted-foreground whitespace-pre-line">
              {app.detail.longDescription}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Screenshots */}
      {app.detail?.screenshots && app.detail.screenshots.length > 0 && (
        <div className="mb-6">
          <h3 className="font-semibold text-sm mb-3">Screenshots</h3>
          <div className="flex gap-4 overflow-x-auto pb-4">
            {app.detail.screenshots.map((s, i) => (
              <div key={i} className="shrink-0">
                <img
                  src={resolveImageUrl(s.url) || s.url}
                  alt={s.caption || `Screenshot ${i + 1}`}
                  className="rounded-lg border max-h-64 object-contain"
                />
                {s.caption && (
                  <p className="text-xs text-muted-foreground mt-1 text-center">
                    {s.caption}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Details Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        {/* Resources Card */}
        <Card>
          <CardContent className="p-5">
            <h3 className="font-semibold text-sm mb-3">System Requirements</h3>
            <div className="space-y-3">
              {app.estimatedMemory && (
                <div className="flex items-center gap-3 text-sm">
                  <MemoryStick className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Memory</span>
                  <span className="ml-auto font-medium">
                    {app.estimatedMemory}
                  </span>
                </div>
              )}
              {app.estimatedCPU && (
                <div className="flex items-center gap-3 text-sm">
                  <Cpu className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">CPU</span>
                  <span className="ml-auto font-medium">
                    {app.estimatedCPU}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-3 text-sm">
                <Shield className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">SSO</span>
                <span className="ml-auto font-medium">
                  {app.supportsSSO ? "Supported" : "Not available"}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Info Card */}
        <Card>
          <CardContent className="p-5">
            <h3 className="font-semibold text-sm mb-3">Information</h3>
            <div className="space-y-3">
              <div className="flex items-center gap-3 text-sm">
                <Tag className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Category</span>
                <span className="ml-auto font-medium">
                  {CATEGORY_NAMES[app.category] || app.category}
                </span>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <span className="h-4 w-4 text-muted-foreground text-center text-xs font-bold">
                  ID
                </span>
                <span className="text-muted-foreground">App ID</span>
                <span className="ml-auto font-medium font-mono text-xs">
                  {app.id}
                </span>
              </div>
              {app.website && (
                <div className="flex items-center gap-3 text-sm">
                  <Globe className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Website</span>
                  <a
                    href={app.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto text-primary hover:underline text-xs truncate max-w-48"
                  >
                    {app.website.replace(/^https?:\/\//, "")}
                  </a>
                </div>
              )}
              {app.installInfo && (
                <div className="flex items-center gap-3 text-sm">
                  <ExternalLink className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">URL</span>
                  <a
                    href={`https://${app.installInfo.subdomain}.${app.installInfo.domain}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto text-primary hover:underline text-xs"
                  >
                    {app.installInfo.subdomain}.{app.installInfo.domain}
                  </a>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tags */}
      {app.tags && app.tags.length > 0 && (
        <div className="mb-8">
          <h3 className="font-semibold text-sm mb-3">Tags</h3>
          <div className="flex flex-wrap gap-2">
            {app.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Uninstall Confirmation */}
      <AlertDialog
        open={showUninstall}
        onOpenChange={(open) => {
          if (!open) setShowUninstall(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("uninstallConfirm", { name: app.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("uninstallDescription", { name: app.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleUninstall}
              disabled={uninstalling}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {uninstalling && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {t("uninstall")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
