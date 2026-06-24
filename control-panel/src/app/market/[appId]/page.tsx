'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
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
  KeyRound,
  Eye,
  EyeOff,
  Copy,
  Plug,
  RefreshCw,
  Code2,
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
  plug: Plug,
};

// Colorful app-icon tile by category (mockup palette — intentionally light in both
// themes, like an OS home-screen icon).
const HERO_TILE: Record<string, { background: string; color: string }> = {
  productivity: { background: '#eff6ff', color: '#2563eb' },
  media: { background: '#fdf2f8', color: '#db2777' },
  search: { background: '#f5f3ff', color: '#7c3aed' },
  social: { background: '#ecfeff', color: '#0891b2' },
  utilities: { background: '#f0f9ff', color: '#0284c7' },
};
function heroTile(category?: string) {
  return HERO_TILE[category || ''] || { background: '#f4f4f5', color: '#52525b' };
}

export default function AppDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const appId = params.appId as string;
  const sourceId = searchParams.get('source') || undefined;

  const [app, setApp] = useState<MarketApp | null>(null);
  const [status, setStatus] = useState<AppStatusInfo | null>(null);
  const [targetStatus, setTargetStatus] = useState<AppStatusInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [domain, setDomain] = useState('');
  const [siteName, setSiteName] = useState('YouEye');

  // Install state
  const [showInstallDialog, setShowInstallDialog] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installEvents, setInstallEvents] = useState<InstallEvent[]>([]);
  const [installDone, setInstallDone] = useState(false);
  const [switchingSource, setSwitchingSource] = useState(false);
  const [sourceSwitchMessage, setSourceSwitchMessage] = useState<string | null>(null);
  const [syncingManifest, setSyncingManifest] = useState(false);
  const [manifestSyncMessage, setManifestSyncMessage] = useState<string | null>(null);
  const [applyingIntegration, setApplyingIntegration] = useState(false);
  const [removingIntegration, setRemovingIntegration] = useState(false);
  const [integrationMessage, setIntegrationMessage] = useState<string | null>(null);

  // Uninstall state
  const [showUninstallDialog, setShowUninstallDialog] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);

  // Credentials state
  const [credentials, setCredentials] = useState<{ label: string; username: string; password: string }[]>([]);
  const [credentialsLoaded, setCredentialsLoaded] = useState(false);
  const [visiblePasswords, setVisiblePasswords] = useState<Set<number>>(new Set());

  const fetchApp = useCallback(async () => {
    try {
      const suffix = sourceId ? `?source=${encodeURIComponent(sourceId)}` : '';
      const res = await fetch(`/api/market/app/${encodeURIComponent(appId)}${suffix}`);
      if (res.status === 404) {
        setError('App not found');
        return;
      }
      if (!res.ok) throw new Error('Failed to fetch app details');
      const data = await res.json();
      setApp(data.app);
      if (data.app?.itemKind === 'integration' && data.app.target?.appId) {
        const targetRes = await fetch(`/api/market/status?app=${encodeURIComponent(data.app.target.appId)}`);
        if (targetRes.ok) setTargetStatus(await targetRes.json());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load app details');
    }
  }, [appId, sourceId]);

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
        if (data.siteName) setSiteName(data.siteName);
      }
    } catch {
      // Will use fallback
    }
  }, []);

  const fetchCredentials = useCallback(async () => {
    try {
      const res = await authenticatedFetch(`/api/market/credentials?app=${encodeURIComponent(appId)}`);
      if (res.ok) {
        const data = await res.json();
        setCredentials(data.credentials ?? []);
      }
    } catch {
      // Credentials fetch failure is non-fatal
    } finally {
      setCredentialsLoaded(true);
    }
  }, [appId]);

  useEffect(() => {
    Promise.all([fetchApp(), fetchStatus(), fetchDomain()]).finally(() =>
      setLoading(false)
    );

    fetchCredentials();
    const interval = setInterval(fetchStatus, 10_000);
    return () => clearInterval(interval);
  }, [fetchApp, fetchStatus, fetchDomain, fetchCredentials]);

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

  const handleSwitchSource = async () => {
    if (!app?.sourceId) return;
    setSwitchingSource(true);
    setSourceSwitchMessage(null);
    try {
      const res = await authenticatedFetch(`/api/market/app/${encodeURIComponent(app.id)}/source`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: app.sourceId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to switch source');
      setSourceSwitchMessage(`Future updates will use ${data.sourceName || app.sourceName || app.sourceId}.`);
      await fetchStatus();
    } catch (err) {
      setSourceSwitchMessage(err instanceof Error ? err.message : 'Failed to switch source');
    } finally {
      setSwitchingSource(false);
    }
  };

  const handleSyncManifest = async () => {
    if (!app || app.itemKind === 'integration') return;
    setSyncingManifest(true);
    setManifestSyncMessage(null);
    try {
      const res = await authenticatedFetch(`/api/market/app/${encodeURIComponent(app.id)}/manifest-sync`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.status !== 'ok') throw new Error(data.error || 'Failed to sync manifest');
      const source = data.sourceId || status?.sourceName || status?.sourceId || app.sourceName || app.sourceId || 'selected Market source';
      const surfaceCopy = Number.isFinite(data.surfaces)
        ? `${data.surfaces} surface${data.surfaces === 1 ? '' : 's'}`
        : 'manifest surfaces';
      setManifestSyncMessage(`Synced ${app.name} from ${source}; ${surfaceCopy} are now available to UI.`);
      await Promise.all([fetchApp(), fetchStatus()]);
    } catch (err) {
      setManifestSyncMessage(err instanceof Error ? err.message : 'Failed to sync manifest');
    } finally {
      setSyncingManifest(false);
    }
  };

  const handleApplyIntegration = async () => {
    if (!app || app.itemKind !== 'integration') return;
    setApplyingIntegration(true);
    setIntegrationMessage(null);
    try {
      const res = await authenticatedFetch('/api/market/integrations/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrationId: app.id, sourceId: app.sourceId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to apply integration');
      setIntegrationMessage(`${app.name} applied to ${app.target?.appName || app.target?.appId}.`);
      if (app.target?.appId) {
        const targetRes = await fetch(`/api/market/status?app=${encodeURIComponent(app.target.appId)}`);
        if (targetRes.ok) setTargetStatus(await targetRes.json());
      }
    } catch (err) {
      setIntegrationMessage(err instanceof Error ? err.message : 'Failed to apply integration');
    } finally {
      setApplyingIntegration(false);
    }
  };

  const handleRemoveIntegration = async () => {
    if (!app || app.itemKind !== 'integration') return;
    setRemovingIntegration(true);
    setIntegrationMessage(null);
    const hasUninstall = !!app.integrations?.[0]?.hasUninstall;
    try {
      const res = await authenticatedFetch('/api/market/integrations/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integrationId: app.id,
          sourceId: app.sourceId,
          metadataOnly: !hasUninstall,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to remove integration');
      setIntegrationMessage(hasUninstall
        ? `${app.name} removed from ${app.target?.appName || app.target?.appId}.`
        : `${app.name} record removed. This Integration does not yet declare app teardown steps.`);
      if (app.target?.appId) {
        const targetRes = await fetch(`/api/market/status?app=${encodeURIComponent(app.target.appId)}`);
        if (targetRes.ok) setTargetStatus(await targetRes.json());
      }
    } catch (err) {
      setIntegrationMessage(err instanceof Error ? err.message : 'Failed to remove integration');
    } finally {
      setRemovingIntegration(false);
    }
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
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // ── Error / Not found state ────────────────────────────────

  if (error || !app) {
    return (
      <div className="space-y-6">
        <button
          onClick={() => router.push('/market')}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Market
        </button>
        <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center">
          <AlertCircle className="h-12 w-12 text-red-400 mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-foreground mb-1">App Not Found</h2>
          <p className="text-sm text-muted-foreground">
            {error || `The app "${appId}" could not be found in the catalog.`}
          </p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => router.push('/market')}
          >
            Return to Market
          </Button>
        </div>
      </div>
    );
  }

  // ── Derived state ──────────────────────────────────────────

  const appStatus = status?.status ?? 'not-installed';
  const isIntegration = app.itemKind === 'integration';
  const isInstalled = !isIntegration && appStatus !== 'not-installed';
  const targetIsInstalled = !!targetStatus?.status && targetStatus.status !== 'not-installed';
  const integrationInstalled = isIntegration
    && !!targetStatus?.installedIntegrations?.some((integration) => integration.id === app.id);
  const FallbackIcon = ICON_MAP[app.icon] ?? Package;
  const longDescription = app.detail?.longDescription || app.description;
  const screenshots = app.detail?.screenshots ?? [];

  // Plain-language access surface — who can reach this app.
  const accessLevel: 'public' | 'server-users' | 'internal' | null = (() => {
    if (isIntegration) return null;
    const entrances = app.entrances ?? [];
    if (entrances.length > 0 && entrances.every((e) => e.authLevel === 'internal' || e.authLevel === 'none')) {
      return 'internal';
    }
    const gated = status?.forwardAuthEnabled || app.supportsSSO || app.integrations?.some((i) => i.type === 'identity');
    return gated ? 'server-users' : 'public';
  })();
  const accessLabel = accessLevel === 'internal' ? 'Internal'
    : accessLevel === 'server-users' ? `Only ${siteName} users`
    : 'Public';
  const accessOneLiner = accessLevel === 'internal'
    ? 'Only reachable inside your server — not exposed to the internet.'
    : accessLevel === 'server-users'
      ? `Only people with a ${siteName} account can open this app.`
      : 'Anyone with the link can open this app.';
  const isDifferentSourceVariant = isInstalled && !!app.sourceId && !!status?.sourceId && app.sourceId !== status.sourceId;
  const capabilityLabels = [
    app.capabilities?.widgets ? 'Widgets' : null,
    app.capabilities?.notifications ? 'Notifications' : null,
    app.capabilities?.smtp ? 'Mail sending' : null,
    app.capabilities?.link_handlers?.length ? 'Link handlers' : null,
    app.surfaces?.length ? `${app.surfaces.length} app surface${app.surfaces.length === 1 ? '' : 's'}` : null,
    app.entrances?.length ? `${app.entrances.length} entrance${app.entrances.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean) as string[];

  const latestInstallEvent = installEvents[installEvents.length - 1];
  const installPercent = latestInstallEvent?.totalSteps
    ? Math.round((latestInstallEvent.step / latestInstallEvent.totalSteps) * 100)
    : 0;
  const installFailed = installDone && latestInstallEvent?.status === 'error';

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Back button */}
      <button
        onClick={() => router.push('/market')}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Market
      </button>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
      <div className="space-y-6">
      {/* Hero */}
      <div className="flex flex-wrap items-center gap-5">
        <div
          className="flex size-[88px] shrink-0 items-center justify-center rounded-[22px] border shadow-sm"
          style={heroTile(app.category)}
        >
          {app.iconUrl ? (
            <Image src={app.iconUrl} alt={app.name} width={48} height={48} className="h-12 w-12 object-contain" unoptimized />
          ) : (
            <FallbackIcon className="h-10 w-10" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[28px] font-bold tracking-tight text-foreground">{app.name}</h1>
            {/* Unified market: apps are not labelled native vs external. Only the
                distinct Integration item-kind keeps a badge. */}
            {isIntegration && (
              <Badge variant="secondary" className="gap-1"><Plug className="h-3 w-3" /> Integration</Badge>
            )}
          </div>
          <p className="mt-1 text-[15px] text-muted-foreground">{app.description}</p>
          {isInstalled && status?.url && (
            <a href={status.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-sm text-primary hover:underline">
              {status.url}<ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>

      {integrationMessage && (
        <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">{integrationMessage}</div>
      )}

      {/* Meta band */}
      <div className="grid grid-cols-2 gap-3 rounded-xl border bg-card p-[18px] sm:grid-cols-3 lg:grid-cols-6">
        <div className="grid gap-0.5"><span className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Version</span><span className="text-[13.5px] font-semibold">{app.version ? `v${app.version}` : '—'}</span></div>
        <div className="grid gap-0.5"><span className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Category</span><span className="text-[13.5px] font-semibold capitalize">{app.category || '—'}</span></div>
        <div className="grid gap-0.5"><span className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Source</span><span className="truncate text-[13.5px] font-semibold">{app.sourceName || app.sourceId || 'Market'}</span></div>
        <div className="grid gap-0.5"><span className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Developer</span><span className="truncate text-[13.5px] font-semibold">{app.developer || (app.integration === 'native' ? 'YouEye (official)' : (app.sourceName || '—'))}</span></div>
        <div className="grid gap-0.5"><span className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">License</span><span className="text-[13.5px] font-semibold">{app.license ? <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[12px] font-semibold">{app.license}</span> : '—'}</span></div>
        <div className="grid gap-0.5"><span className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Account login</span><span className="flex items-center gap-1.5 text-[13.5px] font-semibold">{!isIntegration && (app.supportsSSO || app.forwardAuth !== 'disabled') && <Shield className="h-3.5 w-3.5 text-green-600" />}{app.supportsSSO ? 'Built in' : status?.forwardAuthEnabled ? 'Protected' : app.forwardAuth === 'disabled' ? 'Unavailable' : 'Optional'}</span></div>
      </div>

      {/* Access surface — plain-language "who can reach this app" + a live full-URL chip */}
      {accessLevel && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
          <div className="flex items-center gap-3">
            <div className={`rounded-md p-2 ${accessLevel === 'public' ? 'bg-amber-50 text-amber-600' : accessLevel === 'internal' ? 'bg-slate-100 text-slate-600' : 'bg-blue-50 text-blue-600'}`}>
              {accessLevel === 'public' ? <Globe className="h-4 w-4" /> : accessLevel === 'internal' ? <EyeOff className="h-4 w-4" /> : <Shield className="h-4 w-4" />}
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">{accessLabel}</p>
              <p className="text-xs text-muted-foreground">{accessOneLiner}</p>
            </div>
          </div>
          {(() => {
            const url = isInstalled && status?.url ? status.url : (domain ? `https://${app.defaultSubdomain}.${domain}` : null);
            if (!url || accessLevel === 'internal') return null;
            return (
              <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground hover:bg-accent">
                {url.replace(/^https?:\/\//, '')}<ExternalLink className="h-3 w-3" />
              </a>
            );
          })()}
        </div>
      )}

      {/* Gallery — real screenshots, or designed placeholders (never broken images) */}
      <div className="grid gap-3.5 sm:grid-cols-2">
        {(screenshots.length > 0 ? screenshots.slice(0, 2) : [null, null]).map((shot, i) =>
          shot ? (
            <div key={i} className="relative overflow-hidden rounded-2xl border bg-muted/30" style={{ aspectRatio: '16 / 10' }}>
              <Image src={shot.url} alt={shot.caption || `Screenshot ${i + 1}`} fill className="object-cover" unoptimized />
              {shot.caption && <div className="absolute inset-x-0 bottom-0 bg-background/85 px-3.5 py-2 text-[12.5px] text-muted-foreground">{shot.caption}</div>}
            </div>
          ) : (
            <div key={i} className="flex items-center justify-center rounded-2xl border bg-muted/30 text-muted-foreground/40" style={{ aspectRatio: '16 / 10' }}>
              <Camera className="h-7 w-7" />
            </div>
          ),
        )}
      </div>
      {screenshots.length > 2 && (
        <div className="rounded-xl border bg-card p-[22px]">
          <h2 className="mb-3 text-[15px] font-semibold">More screenshots</h2>
          <ScreenshotGallery screenshots={screenshots} />
        </div>
      )}

      {/* About */}
      <div className="rounded-xl border bg-card p-[22px]">
        <h2 className="text-[15px] font-semibold">About this app</h2>
        <div className="mt-3 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
          {longDescription}
        </div>
      </div>

      {/* What's new — release notes for the current version */}
      {app.detail?.releaseNotes && (
        <div className="rounded-xl border bg-card p-[22px]">
          <h2 className="text-[15px] font-semibold">What&apos;s new{app.version ? ` in v${app.version}` : ''}</h2>
          <div className="mt-3 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
            {app.detail.releaseNotes}
          </div>
        </div>
      )}

      {/* Details section */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">
          What this app uses
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* SSO / Forward-Auth */}
          {isIntegration ? (
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-violet-50">
                <Plug className="h-4 w-4 text-violet-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Target App</p>
                <p className="text-sm font-medium text-foreground">
                  {app.target?.appName || app.target?.appId || 'Unknown'}
                  {app.target?.version ? ` ${app.target.version}` : ''}
                </p>
              </div>
            </div>
          ) : isInstalled ? (
            <ForwardAuthToggle
              appId={app.id}
              hasNativeSSO={app.supportsSSO}
              forwardAuthEnabled={status?.forwardAuthEnabled ?? false}
              onToggled={() => fetchStatus()}
            />
          ) : (
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-muted">
                <Shield className="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">SSO Support</p>
                <p className="text-sm font-medium text-foreground">
                  {app.supportsSSO ? (
                    <span className="text-green-600">Native OAuth2</span>
                  ) : app.forwardAuth !== 'disabled' ? (
                    <span className="text-green-600">Forward-auth (auto)</span>
                  ) : (
                    <span className="text-muted-foreground">Disabled</span>
                  )}
                </p>
              </div>
            </div>
          )}

          {isIntegration && app.integrations?.[0]?.permissions?.length ? (
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-muted">
                <Shield className="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Permissions</p>
                <p className="text-sm font-medium text-foreground">
                  {app.integrations[0].permissions.join(', ')}
                </p>
              </div>
            </div>
          ) : null}

          {capabilityLabels.length > 0 && !isIntegration && (
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-muted">
                <Package className="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">App features</p>
                <p className="text-sm font-medium text-foreground">
                  {capabilityLabels.join(', ')}
                </p>
              </div>
            </div>
          )}

          {/* Website */}
          {app.website && (
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-muted">
                <Globe className="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Website</p>
                <a
                  href={app.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium text-primary hover:underline flex items-center gap-1"
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

          {/* Source code */}
          {app.sourceCode && (
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-muted">
                <Code2 className="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Source code</p>
                <a href={app.sourceCode} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-primary hover:underline flex items-center gap-1">
                  {(() => { try { return new URL(app.sourceCode!).hostname; } catch { return app.sourceCode; } })()}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          )}

          {/* Documentation */}
          {app.docs && (
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-muted">
                <BookOpen className="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Documentation</p>
                <a href={app.docs} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-primary hover:underline flex items-center gap-1">
                  View docs<ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          )}

          {/* Support */}
          {app.support && (
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-muted">
                <MessageCircle className="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Support</p>
                <a href={app.support} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-primary hover:underline flex items-center gap-1">
                  Get help<ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          )}

          {/* Market Source */}
          {app.sourceName && (
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-muted">
                <Package className="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Market Source</p>
                <p className="text-sm font-medium text-foreground">
                  {isInstalled && status?.sourceName ? status.sourceName : app.sourceName}
                </p>
              </div>
            </div>
          )}
        </div>

        {isDifferentSourceVariant && (
          <div className="mt-5 rounded-lg border border-primary/30 bg-primary/10p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">
                  This variant is from {app.sourceName || app.sourceId}.
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Current install source is {status?.sourceName || status?.sourceId}. Switching changes the source used for future update checks and updates.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleSwitchSource}
                disabled={switchingSource}
                className="border-primary/30 bg-card text-muted-foreground hover:bg-primary/15"
              >
                {switchingSource ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
                Use this source
              </Button>
            </div>
          </div>
        )}

        {sourceSwitchMessage && (
          <div className="mt-3 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground">
            {sourceSwitchMessage}
          </div>
        )}

        {manifestSyncMessage && (
          <div className="mt-3 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground">
            {manifestSyncMessage}
          </div>
        )}

        {/* Tags */}
        {app.tags.length > 0 && (
          <div className="mt-5 pt-4 border-t border-border">
            <div className="flex items-center gap-2 mb-2">
              <Tag className="h-4 w-4 text-muted-foreground" />
              <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">
                Tags
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {app.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs px-2.5 py-1 rounded-full bg-muted text-muted-foreground"
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

      {/* Default Credentials (shown when app is installed and has credentials) */}
      {isInstalled && credentialsLoaded && credentials.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-6">
          <div className="flex items-center gap-2 mb-4">
            <KeyRound className="h-4 w-4 text-amber-600" />
            <h2 className="text-sm font-semibold text-amber-700 uppercase tracking-wide">
              Default Credentials
            </h2>
          </div>
          <div className="space-y-3">
            {credentials.map((cred, i) => (
              <div key={i} className="rounded-lg border border-amber-200 bg-card p-4">
                <p className="text-xs text-muted-foreground font-medium mb-2">{cred.label}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs text-muted-foreground">Username</p>
                    <div className="flex items-center gap-2">
                      <code className="text-sm font-mono text-foreground">{cred.username}</code>
                      <button
                        onClick={() => navigator.clipboard.writeText(cred.username)}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-muted-foreground"
                        title="Copy username"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Password</p>
                    <div className="flex items-center gap-2">
                      <code className="text-sm font-mono text-foreground">
                        {visiblePasswords.has(i) ? cred.password : '\u2022'.repeat(12)}
                      </code>
                      <button
                        onClick={() => {
                          setVisiblePasswords((prev) => {
                            const next = new Set(prev);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            return next;
                          });
                        }}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-muted-foreground"
                        title={visiblePasswords.has(i) ? 'Hide password' : 'Show password'}
                      >
                        {visiblePasswords.has(i) ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        onClick={() => navigator.clipboard.writeText(cred.password)}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-muted-foreground"
                        title="Copy password"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-amber-600/70 mt-3">
            Use these credentials to access the app&apos;s admin panel. You can promote SSO users to admin from within the app.
          </p>
        </div>
      )}

      </div>

      <aside className="lg:sticky lg:top-24">
        <div className="rounded-lg border border-border bg-card p-5 shadow-sm">
          <div className="space-y-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</p>
              <div className="mt-2 flex items-center gap-2">
                {isIntegration ? (
                  <Plug className="h-4 w-4 text-primary" />
                ) : isInstalled ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                ) : (
                  <Package className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="text-sm font-medium text-foreground">
                  {isIntegration
                    ? integrationInstalled ? 'Applied' : 'Available'
                    : isInstalled ? appStatus : 'Ready to install'}
                </span>
                {isInstalled && (
                  <HealthDot
                    healthStatus={status?.healthStatus}
                    healthCheckedAt={status?.healthCheckedAt}
                  />
                )}
              </div>
            </div>

            {installing && installEvents.length > 0 ? (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium text-foreground">
                      {installDone
                        ? installFailed ? 'Installation failed' : 'Ready'
                        : `Installing ${app.name}`}
                    </span>
                    <span className="text-muted-foreground">{installPercent}%</span>
                  </div>
                  <div className="mt-2 h-2 rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        installFailed ? 'bg-red-500' : installDone ? 'bg-green-500' : 'bg-primary'
                      }`}
                      style={{ width: `${installPercent}%` }}
                    />
                  </div>
                  {latestInstallEvent?.message && (
                    <p className="mt-2 text-sm text-muted-foreground">{latestInstallEvent.message}</p>
                  )}
                </div>
                <div className="space-y-2">
                  {installEvents.slice(-6).map((event, i) => (
                    <div key={`${event.step}-${i}-${event.message}`} className="flex items-start gap-2 text-sm">
                      <div className={`mt-0.5 ${
                        event.status === 'running' ? 'text-primary' :
                        event.status === 'success' ? 'text-green-500' :
                        event.status === 'error' ? 'text-red-500' : 'text-muted-foreground'
                      }`}>
                        {event.status === 'running' ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : event.status === 'error' ? (
                          <AlertCircle className="h-4 w-4" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-foreground">{event.message}</p>
                        {event.detail && <p className="truncate text-xs text-muted-foreground">{event.detail}</p>}
                      </div>
                    </div>
                  ))}
                </div>
                {installDone && (
                  <div className="grid gap-2">
                    {!installFailed && status?.url && (
                      <Button onClick={() => window.open(status.url, '_blank')}>
                        <ExternalLink className="h-4 w-4 mr-2" />
                        Open {app.name}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      onClick={() => {
                        setInstalling(false);
                        setInstallEvents([]);
                        setInstallDone(false);
                      }}
                    >
                      Dismiss
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <div className="grid gap-2">
                {isIntegration ? (
                  integrationInstalled ? (
                    <>
                      <Button disabled>
                        <CheckCircle2 className="h-4 w-4 mr-2" />
                        Applied
                      </Button>
                      <Button
                        variant="outline"
                        onClick={handleRemoveIntegration}
                        disabled={removingIntegration}
                        className="text-red-600 hover:bg-red-50 hover:text-red-700"
                      >
                        {removingIntegration ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
                        {app.integrations?.[0]?.hasUninstall ? `Remove ${app.name}` : 'Remove record'}
                      </Button>
                    </>
                  ) : (
                    <Button
                      onClick={handleApplyIntegration}
                      disabled={!targetIsInstalled || applyingIntegration}
                    >
                      {applyingIntegration ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                      {targetIsInstalled ? `Apply ${app.name}` : `Available after ${app.target?.appName || app.target?.appId || 'target app'} install`}
                    </Button>
                  )
                ) : !isInstalled ? (
                  <Button onClick={() => setShowInstallDialog(true)}>
                    Install {app.name}
                  </Button>
                ) : (
                  <>
                    {status?.url && (
                      <Button onClick={() => window.open(status.url, '_blank')}>
                        <ExternalLink className="h-4 w-4 mr-2" />
                        Open {app.name}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      onClick={handleSyncManifest}
                      disabled={syncingManifest}
                    >
                      {syncingManifest ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                      Sync manifest
                    </Button>
                    <Button
                      variant="outline"
                      className="text-red-600 hover:bg-red-50 hover:text-red-700"
                      onClick={() => setShowUninstallDialog(true)}
                      disabled={uninstalling}
                    >
                      {uninstalling ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
                      Uninstall
                    </Button>
                  </>
                )}
              </div>
            )}

            <div className="border-t border-border pt-4 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Source</span>
                <span className="text-right font-medium text-foreground">{app.sourceName || app.sourceId || 'Market'}</span>
              </div>
              {app.version && (
                <div className="mt-2 flex justify-between gap-3">
                  <span className="text-muted-foreground">Version</span>
                  <span className="font-medium text-foreground">v{app.version}</span>
                </div>
              )}
              {!isIntegration && (
                <div className="mt-2 flex justify-between gap-3">
                  <span className="text-muted-foreground">Account login</span>
                  <span className="text-right font-medium text-foreground">
                    {app.supportsSSO ? 'Built in' : status?.forwardAuthEnabled ? 'Protected' : app.forwardAuth === 'disabled' ? 'Unavailable' : 'Optional'}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </aside>
      </div>

      {/* Install dialog */}
      {showInstallDialog && app && (
        <InstallDialog
          app={app}
          domain={domain || ''}
          siteName={siteName}
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
            className="shrink-0 rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2"
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
              <p className="text-xs text-muted-foreground px-2 py-1.5 bg-muted truncate max-w-[280px]">
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
