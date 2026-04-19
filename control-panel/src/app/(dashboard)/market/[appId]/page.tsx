'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Image from 'next/image';
import {
  ArrowLeft,
  Loader2,
  AlertCircle,
  ExternalLink,
  Trash2,
  Shield,
  Package,
  Search,
  MessageCircle,
  BookOpen,
  StickyNote,
  Camera,
  BellRing,
  Globe,
  Tag,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { InstallDialog } from '@/components/market/install-dialog';
import { UninstallDialog } from '@/components/market/uninstall-dialog';
import { HealthDot } from '@/components/market/health-dot';
import { ForwardAuthToggle } from '@/components/market/forward-auth-toggle';
import { EntrancesDisplay } from '@/components/market/entrances-display';
import { authenticatedFetch } from '@/lib/api-client';
import type { MarketApp, AppStatusInfo, InstallConfig, InstallEvent } from '@/lib/market/types';

const ICON_MAP: Record<string, typeof Search> = {
  search: Search,
  'message-circle': MessageCircle,
  'book-open': BookOpen,
  'sticky-note': StickyNote,
  camera: Camera,
  package: Package,
  'bell-ring': BellRing,
};

export default function AppDetailPage() {
  const params = useParams();
  const router = useRouter();
  const appId = params.appId as string;

  const [app, setApp] = useState<MarketApp | null>(null);
  const [status, setStatus] = useState<AppStatusInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [domain, setDomain] = useState('');

  // Install state
  const [showInstallDialog, setShowInstallDialog] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installEvents, setInstallEvents] = useState<InstallEvent[]>([]);
  const [installDone, setInstallDone] = useState(false);

  // Uninstall state
  const [showUninstallDialog, setShowUninstallDialog] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);

  const fetchApp = useCallback(async () => {
    try {
      const res = await fetch(`/api/market/app/${encodeURIComponent(appId)}`);
      if (res.status === 404) {
        setError('App not found');
        return;
      }
      if (!res.ok) throw new Error('Failed to fetch app details');
      const data = await res.json();
      setApp(data.app);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load app details');
    }
  }, [appId]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/market/status?app=${encodeURIComponent(appId)}`);
      if (!res.ok) return;
      const data = await res.json();
      setStatus(data);
    } catch {
      // Status fetch failure is non-fatal
    }
  }, [appId]);

  const fetchDomain = useCallback(async () => {
    try {
      const res = await fetch('/api/domain');
      if (res.ok) {
        const data = await res.json();
        if (data.domain) setDomain(data.domain);
      }
    } catch {
      // Will use fallback
    }
  }, []);

  useEffect(() => {
    Promise.all([fetchApp(), fetchStatus(), fetchDomain()]).finally(() =>
      setLoading(false)
    );

    const interval = setInterval(fetchStatus, 10_000);
    return () => clearInterval(interval);
  }, [fetchApp, fetchStatus, fetchDomain]);

  // ── Polling for install progress ─────────────────────────────

  const [pollingAppId, setPollingAppId] = useState<string | null>(null);

  useEffect(() => {
    if (!pollingAppId) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/market/install-status?app=${encodeURIComponent(pollingAppId)}`);
        if (res.ok) {
          const data = await res.json();
          setInstallEvents(data.events || []);
          if (data.done) {
            setInstallDone(true);
            clearInterval(interval);
            setPollingAppId(null);
            setTimeout(fetchStatus, 1000);
          }
        }
      } catch { /* ignore */ }
    }, 1500);
    return () => clearInterval(interval);
  }, [pollingAppId, fetchStatus]);

  // Check on mount if there's already an active install for this app
  useEffect(() => {
    async function checkExistingInstall() {
      try {
        const res = await fetch(`/api/market/install-status?app=${encodeURIComponent(appId)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.events && data.events.length > 0) {
            setInstalling(true);
            setInstallEvents(data.events);
            if (data.done) {
              setInstallDone(true);
            } else {
              setPollingAppId(appId);
            }
          }
        }
      } catch { /* ignore */ }
    }
    checkExistingInstall();
  }, [appId]);

  // ── Install handler ────────────────────────────────────────

  const handleInstall = async (config: InstallConfig) => {
    setShowInstallDialog(false);
    setInstalling(true);
    setInstallEvents([]);
    setInstallDone(false);

    // Fire and forget — the server handles everything in the background
    try {
      const res = await authenticatedFetch('/api/market/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      // Don't read the SSE stream — just let the connection drop.
      // The server continues the install regardless.
      // Close the response body immediately to free resources.
      try { res.body?.cancel(); } catch { /* ignore */ }
    } catch (err) {
      setInstallEvents([{
        step: 0,
        totalSteps: 0,
        status: 'error',
        message: 'Failed to start install',
        detail: String(err),
      }]);
      setInstallDone(true);
      return;
    }

    // Start polling for status
    setPollingAppId(config.appId);
  };

  // ── Uninstall handler ──────────────────────────────────────

  const handleUninstall = async (appIdToUninstall: string, keepData: boolean) => {
    setShowUninstallDialog(false);
    setUninstalling(true);
    try {
      await authenticatedFetch('/api/market/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: appIdToUninstall, keepData }),
      });
      await fetchStatus();
    } catch (err) {
      alert(`Uninstall failed: ${err}`);
    } finally {
      setUninstalling(false);
    }
  };

  // ── Loading state ──────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  // ── Error / Not found state ────────────────────────────────

  if (error || !app) {
    return (
      <div className="space-y-6">
        <button
          onClick={() => router.push('/market')}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to App Market
        </button>
        <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center">
          <AlertCircle className="h-12 w-12 text-red-400 mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-gray-900 mb-1">App Not Found</h2>
          <p className="text-sm text-gray-500">
            {error || `The app "${appId}" could not be found in the catalog.`}
          </p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => router.push('/market')}
          >
            Return to App Market
          </Button>
        </div>
      </div>
    );
  }

  // ── Derived state ──────────────────────────────────────────

  const appStatus = status?.status ?? 'not-installed';
  const isInstalled = appStatus !== 'not-installed';
  const FallbackIcon = ICON_MAP[app.icon] ?? Package;
  const longDescription = app.detail?.longDescription || app.description;
  const screenshots = app.detail?.screenshots ?? [];

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Back button */}
      <button
        onClick={() => router.push('/market')}
        className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to App Market
      </button>

      {/* Header card */}
      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <div className="flex items-start gap-5">
          {/* App icon */}
          <div className="p-4 rounded-xl bg-blue-50 flex items-center justify-center shrink-0">
            {app.iconUrl ? (
              <Image
                src={app.iconUrl}
                alt={app.name}
                width={48}
                height={48}
                className="h-12 w-12 object-contain"
                unoptimized
              />
            ) : (
              <FallbackIcon className="h-12 w-12 text-blue-600" />
            )}
          </div>

          {/* App info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold text-gray-900">{app.name}</h1>
              {app.version && (
                <Badge variant="outline" className="text-xs">
                  v{app.version}
                </Badge>
              )}
              {app.type === 'native' ? (
                <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 border border-indigo-100">
                  <Shield className="h-3 w-3" />
                  Native
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-gray-50 text-gray-500 border border-gray-200">
                  <Globe className="h-3 w-3" />
                  External
                </span>
              )}
            </div>
            <p className="text-sm text-gray-400 capitalize mt-1">
              Category: {app.category}
            </p>

            {/* Status indicator when installed */}
            {isInstalled && (
              <div className="mt-2 flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <span className="text-sm text-green-600 font-medium capitalize">
                  {appStatus}
                </span>
                <HealthDot
                  healthStatus={status?.healthStatus}
                  healthCheckedAt={status?.healthCheckedAt}
                />
                {status?.url && (
                  <a
                    href={status.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-600 hover:underline flex items-center gap-1 ml-2"
                  >
                    {status.url}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="mt-5 flex items-center gap-3">
          {!isInstalled ? (
            <Button
              size="lg"
              onClick={() => setShowInstallDialog(true)}
              className="px-8"
            >
              Install {app.name}
            </Button>
          ) : (
            <>
              {status?.url && (
                <Button
                  size="lg"
                  onClick={() => window.open(status.url, '_blank')}
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Open {app.name}
                </Button>
              )}
              <Button
                size="lg"
                variant="outline"
                className="text-red-600 hover:bg-red-50 hover:text-red-700"
                onClick={() => setShowUninstallDialog(true)}
                disabled={uninstalling}
              >
                {uninstalling ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 mr-2" />
                )}
                Uninstall
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Description section */}
      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
          Description
        </h2>
        <div className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
          {longDescription}
        </div>
      </div>

      {/* Screenshots gallery */}
      {screenshots.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Screenshots
          </h2>
          <ScreenshotGallery screenshots={screenshots} />
        </div>
      )}

      {/* Details section */}
      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">
          Details
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* SSO / Forward-Auth */}
          {isInstalled ? (
            <ForwardAuthToggle
              appId={app.id}
              hasNativeSSO={app.supportsSSO}
              forwardAuthEnabled={status?.forwardAuthEnabled ?? false}
              onToggled={() => fetchStatus()}
            />
          ) : (
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-gray-50">
                <Shield className="h-4 w-4 text-gray-500" />
              </div>
              <div>
                <p className="text-xs text-gray-400">SSO Support</p>
                <p className="text-sm font-medium text-gray-700">
                  {app.supportsSSO ? (
                    <span className="text-green-600">Native OAuth2</span>
                  ) : app.forwardAuth !== 'disabled' ? (
                    <span className="text-green-600">Forward-auth (auto)</span>
                  ) : (
                    <span className="text-gray-400">Disabled</span>
                  )}
                </p>
              </div>
            </div>
          )}

          {/* Website */}
          {app.website && (
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-gray-50">
                <Globe className="h-4 w-4 text-gray-500" />
              </div>
              <div>
                <p className="text-xs text-gray-400">Website</p>
                <a
                  href={app.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium text-blue-600 hover:underline flex items-center gap-1"
                >
                  {(() => {
                    try {
                      return new URL(app.website).hostname;
                    } catch {
                      return app.website;
                    }
                  })()}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          )}
        </div>

        {/* Tags */}
        {app.tags.length > 0 && (
          <div className="mt-5 pt-4 border-t border-gray-100">
            <div className="flex items-center gap-2 mb-2">
              <Tag className="h-4 w-4 text-gray-400" />
              <p className="text-xs text-gray-400 uppercase tracking-wide font-medium">
                Tags
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {app.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs px-2.5 py-1 rounded-full bg-gray-100 text-gray-600"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Entrances / Access Points */}
        {app.entrances && app.entrances.length > 0 && (
          <EntrancesDisplay
            entrances={app.entrances}
            subdomain={status?.subdomain}
            domain={status?.domain}
          />
        )}
      </div>

      {/* Install dialog */}
      {showInstallDialog && app && (
        <InstallDialog
          app={app}
          domain={domain || 'youeye.local'}
          onInstall={handleInstall}
          onClose={() => setShowInstallDialog(false)}
        />
      )}

      {/* Uninstall dialog */}
      {showUninstallDialog && app && (
        <UninstallDialog
          app={app}
          onUninstall={handleUninstall}
          onClose={() => setShowUninstallDialog(false)}
        />
      )}

      {/* Install progress (inline, not a modal) */}
      {installing && installEvents.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
              {installDone
                ? installEvents[installEvents.length - 1]?.status === 'error'
                  ? `Installation Failed`
                  : `Installation Complete`
                : `Installing ${app.name}...`}
            </h2>
            {installDone && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setInstalling(false);
                  setInstallEvents([]);
                  setInstallDone(false);
                }}
              >
                Dismiss
              </Button>
            )}
          </div>

          {/* Progress bar */}
          {installEvents.length > 0 && installEvents[installEvents.length - 1].totalSteps > 0 && (
            <div className="mb-4">
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-500 rounded-full ${
                    installDone && installEvents[installEvents.length - 1]?.status === 'error'
                      ? 'bg-red-500'
                      : installDone
                        ? 'bg-green-500'
                        : 'bg-blue-500'
                  }`}
                  style={{
                    width: `${Math.round(
                      (installEvents[installEvents.length - 1].step /
                        installEvents[installEvents.length - 1].totalSteps) *
                        100
                    )}%`,
                  }}
                />
              </div>
              <p className="text-xs text-gray-400 mt-1 text-right">
                {installEvents[installEvents.length - 1].step} / {installEvents[installEvents.length - 1].totalSteps}
              </p>
            </div>
          )}

          {/* Event list */}
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {installEvents.map((event, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className={`mt-0.5 shrink-0 ${
                  event.status === 'running' ? 'text-blue-500' :
                  event.status === 'success' ? 'text-green-500' :
                  event.status === 'error' ? 'text-red-500' : 'text-gray-400'
                }`}>
                  {event.status === 'running' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : event.status === 'success' ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : event.status === 'error' ? (
                    <AlertCircle className="h-4 w-4" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm text-gray-700">{event.message}</p>
                  {event.detail && (
                    <p className="text-xs text-gray-400 mt-0.5 truncate">{event.detail}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Screenshot Gallery Component ───────────────────────────────

interface ScreenshotGalleryProps {
  screenshots: { url: string; caption?: string }[];
}

function ScreenshotGallery({ screenshots }: ScreenshotGalleryProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  return (
    <>
      {/* Horizontal scroll strip */}
      <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-thin">
        {screenshots.map((shot, i) => (
          <button
            key={i}
            onClick={() => setSelectedIndex(i)}
            className="shrink-0 rounded-lg overflow-hidden border border-gray-200 hover:border-blue-400 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2"
          >
            <Image
              src={shot.url}
              alt={shot.caption || `Screenshot ${i + 1}`}
              width={280}
              height={180}
              className="h-[180px] w-auto object-cover"
              unoptimized
            />
            {shot.caption && (
              <p className="text-xs text-gray-500 px-2 py-1.5 bg-gray-50 truncate max-w-[280px]">
                {shot.caption}
              </p>
            )}
          </button>
        ))}
      </div>

      {/* Lightbox */}
      {selectedIndex !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setSelectedIndex(null)}
        >
          <div
            className="relative max-w-[90vw] max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Navigation arrows */}
            {selectedIndex > 0 && (
              <button
                onClick={() => setSelectedIndex(selectedIndex - 1)}
                className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 z-10"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}
            {selectedIndex < screenshots.length - 1 && (
              <button
                onClick={() => setSelectedIndex(selectedIndex + 1)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 z-10"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            )}

            {/* Image */}
            <Image
              src={screenshots[selectedIndex].url}
              alt={
                screenshots[selectedIndex].caption ||
                `Screenshot ${selectedIndex + 1}`
              }
              width={1200}
              height={800}
              className="rounded-lg max-h-[85vh] w-auto object-contain"
              unoptimized
            />

            {/* Caption */}
            {screenshots[selectedIndex].caption && (
              <p className="text-center text-sm text-white/80 mt-3">
                {screenshots[selectedIndex].caption}
              </p>
            )}

            {/* Counter */}
            <p className="text-center text-xs text-white/50 mt-1">
              {selectedIndex + 1} / {screenshots.length}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
