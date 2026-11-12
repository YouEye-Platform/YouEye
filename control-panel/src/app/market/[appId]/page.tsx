'use client';





import { useTranslations as useInterfaceTranslations } from "next-intl";
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
import { InstallDialog } from '@/components/market/install-dialog';
import { UninstallDialog } from '@/components/market/uninstall-dialog';
import { HealthDot } from '@/components/market/health-dot';
import { AppAccessSettings } from '@/components/market/app-access-settings';
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
  const translateInterface = useInterfaceTranslations("interface");
const preparingInstallEvent: InstallEvent = {
  step: 0,
  totalSteps: 0,
  status: 'running',
  message: translateInterface("mb7b55c7307a4"),
};


  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const appId = params.appId as string;
  const sourceId = searchParams.get('source') || undefined;

  const [app, setApp] = useState<MarketApp | null>(null);
  const [status, setStatus] = useState<AppStatusInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [domain, setDomain] = useState('');
  const [siteName, setSiteName] = useState('YouEye');

  // Install state
  const [showInstallDialog, setShowInstallDialog] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installEvents, setInstallEvents] = useState<InstallEvent[]>([]);
  const [installDone, setInstallDone] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installOperationAppId, setInstallOperationAppId] = useState<string | null>(null);
  const [pollingAppId, setPollingAppId] = useState<string | null>(null);
  const [switchingSource, setSwitchingSource] = useState(false);
  const [sourceSwitchMessage, setSourceSwitchMessage] = useState<string | null>(null);
  const [syncingManifest, setSyncingManifest] = useState(false);
  const [manifestSyncMessage, setManifestSyncMessage] = useState<string | null>(null);

  // Uninstall state
  const [showUninstallDialog, setShowUninstallDialog] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [removingDirectEntry, setRemovingDirectEntry] = useState(false);

  // Credentials state
  const [credentials, setCredentials] = useState<{ label: string; username: string; password: string }[]>([]);
  const [credentialsLoaded, setCredentialsLoaded] = useState(false);
  const [visiblePasswords, setVisiblePasswords] = useState<Set<number>>(new Set());

  const fetchApp = useCallback(async () => {
    try {
      const suffix = sourceId ? `?source=${encodeURIComponent(sourceId)}` : '';
      const res = await fetch(`/api/market/app/${encodeURIComponent(appId)}${suffix}`);
      if (res.status === 404) {
        setError(translateInterface("mab1663c1b5b2"));
        return;
      }
      if (!res.ok) throw new Error(translateInterface("m4a9b9269be54"));
      const data = await res.json();
      setApp(data.app);
    } catch (err) {
      setError(translateInterface("m49a2883cb71a"));
    }
  }, [appId, sourceId, translateInterface]);

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

  useEffect(() => {
    // Next can preserve this client component while changing a dynamic route.
    // Never let one app's terminal operation state appear on another app.
    setInstalling(false);
    setInstallEvents([]);
    setInstallDone(false);
    setInstallError(null);
    setInstallOperationAppId(null);
    setPollingAppId(null);
  }, [appId]);

  useEffect(() => {
    if (!pollingAppId || pollingAppId !== appId) return;
    let active = true;
    const expectedAppId = pollingAppId;
    const poll = async () => {
      try {
        const res = await fetch(`/api/market/install-status?app=${encodeURIComponent(expectedAppId)}`);
        if (res.ok) {
          const data = await res.json();
          if (!active || data.appId !== expectedAppId || expectedAppId !== appId) return;
          setInstallOperationAppId(expectedAppId);
          if (data.events?.length) setInstallEvents(data.events);
          setInstallError(data.error || null);
          if (data.done) {
            setInstallDone(true);
            clearInterval(interval);
            setPollingAppId(null);
            setTimeout(fetchStatus, 1000);
          }
        }
      } catch { /* ignore */ }
    };
    const interval = setInterval(poll, 1500);
    void poll();
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [appId, pollingAppId, fetchStatus]);

  // Check on mount if there's already an active install for this app
  useEffect(() => {
    let active = true;
    async function checkExistingInstall() {
      try {
        const res = await fetch(`/api/market/install-status?app=${encodeURIComponent(appId)}`);
        if (res.ok) {
          const data = await res.json();
          if (!active || data.appId !== appId) return;
          if (!data.done && (!data.events || data.events.length === 0)) {
            setInstalling(true);
            setInstallOperationAppId(appId);
            setInstallEvents([preparingInstallEvent]);
            setInstallError(null);
            setPollingAppId(appId);
            return;
          }
          if (data.events && data.events.length > 0) {
            // Successful terminal history is useful across refreshes while the
            // app exists. Once it has been uninstalled, however, replaying an
            // old "installed successfully" card hides the real install action.
            // Keep failed history visible, and retain the durable record for
            // diagnostics, but suppress stale success presentation.
            if (data.done && !data.error) {
              const statusRes = await fetch(`/api/market/status?app=${encodeURIComponent(appId)}`);
              if (statusRes.ok) {
                const currentStatus = await statusRes.json();
                if (!active || currentStatus.status === 'not-installed') return;
              }
            }
            setInstalling(true);
            setInstallOperationAppId(appId);
            setInstallEvents(data.events);
            setInstallError(data.error || null);
            if (data.done) {
              setInstallDone(true);
            } else {
              setPollingAppId(appId);
            }
          }
        }
      } catch { /* ignore */ }
    }
    void checkExistingInstall();
    return () => { active = false; };
  }, [appId]);

  // ── Install handler ────────────────────────────────────────

  const handleInstall = async (config: InstallConfig) => {
    setShowInstallDialog(false);
    setInstalling(true);
    setInstallOperationAppId(config.appId);
    setInstallEvents([preparingInstallEvent]);
    setInstallDone(false);
    setInstallError(null);

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
        message: translateInterface("m545028cf06c9"),
        detail: String(err),
      }]);
      setInstallError(err instanceof Error ? err.message : String(err));
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
      if (!res.ok) throw new Error(data.error || translateInterface("m5aa40c1a8a54"));
      setSourceSwitchMessage(translateInterface("me1c329162f46", {source: String(data.sourceName || app.sourceName || app.sourceId)}));
      await fetchStatus();
    } catch (err) {
      setSourceSwitchMessage(err instanceof Error ? err.message : translateInterface("m5aa40c1a8a54"));
    } finally {
      setSwitchingSource(false);
    }
  };

  const handleSyncManifest = async () => {
    if (!app) return;
    setSyncingManifest(true);
    setManifestSyncMessage(null);
    try {
      const res = await authenticatedFetch(`/api/market/app/${encodeURIComponent(app.id)}/manifest-sync`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.status !== 'ok') throw new Error(data.error || translateInterface("m1264a555555b"));
      const source = data.sourceId || status?.sourceName || status?.sourceId || app.sourceName || app.sourceId || translateInterface("m97fc597a6e34");
      const surfaceCopy = Number.isFinite(data.surfaces)
        ? translateInterface("mcef48023dc9a", {count: Number(data.surfaces)})
        : translateInterface("m2e1444edc0e2");
      setManifestSyncMessage(translateInterface("m915c8bdb5720", {app: app.name, source, surfaces: surfaceCopy}));
      await Promise.all([fetchApp(), fetchStatus()]);
    } catch (err) {
      setManifestSyncMessage(err instanceof Error ? err.message : translateInterface("m1264a555555b"));
    } finally {
      setSyncingManifest(false);
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

  const handleRemoveDirectEntry = async () => {
    if (!app?.sourceId?.startsWith('direct:')) return;
    setRemovingDirectEntry(true);
    try {
      const res = await authenticatedFetch(`/api/market/direct/${encodeURIComponent(app.sourceId)}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || translateInterface("m1a8ce79186c6"));
      router.push('/market');
    } catch (err) {
      setSourceSwitchMessage(err instanceof Error ? err.message : translateInterface("m1a8ce79186c6"));
    } finally {
      setRemovingDirectEntry(false);
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
          {translateInterface("m7e0461b96831")}</button>
        <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center">
          <AlertCircle className="h-12 w-12 text-red-400 mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-foreground mb-1">{translateInterface("mfc142cacf2d2")}</h2>
          <p className="text-sm text-muted-foreground">
            {error || translateInterface("mf5c4b7d985ec", { value0: String(appId) })}
          </p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => router.push('/market')}
          >
            {translateInterface("mf3198e9d9e96")}</Button>
        </div>
      </div>
    );
  }

  // ── Derived state ──────────────────────────────────────────

  const appStatus = status?.status ?? 'not-installed';
  const isInstalled = appStatus !== 'not-installed';
  const isDirectEntry = !!app.sourceId?.startsWith('direct:');
  const FallbackIcon = ICON_MAP[app.icon] ?? Package;
  const longDescription = app.detail?.longDescription || app.description;
  const screenshots = app.detail?.screenshots ?? [];

  // Plain-language access surface — who can reach this app.
  const gated = status?.forwardAuthEnabled || app.supportsSSO || app.integrations?.some((i) => i.type === 'identity');
  const accessLevel: 'public' | 'server-users' = gated ? 'server-users' : 'public';
  const accessLabel = accessLevel === 'server-users' ? translateInterface("mc664ff9c2740", {site: siteName}) : 'Public';
  const accessOneLiner = accessLevel === 'server-users'
    ? translateInterface("m2a2e0c73779e", {site: siteName})
    : translateInterface("m35b0d6f9bfd7");
  const isDifferentSourceVariant = isInstalled && !!app.sourceId && !!status?.sourceId && app.sourceId !== status.sourceId;
  const capabilityLabels = [
    app.capabilities?.widgets ? 'Widgets' : null,
    app.capabilities?.notifications ? 'Notifications' : null,
    app.capabilities?.smtp ? translateInterface("m5208955c81b6") : null,
    app.capabilities?.link_handlers?.length ? translateInterface("m0abf73ccd714") : null,
    app.surfaces?.length ? translateInterface("m8861a842bbcd", {count: app.surfaces.length}) : null,
  ].filter(Boolean) as string[];

  const latestInstallEvent = installEvents[installEvents.length - 1];
  const installPercent = latestInstallEvent?.totalSteps
    ? Math.round((latestInstallEvent.step / latestInstallEvent.totalSteps) * 100)
    : 0;
  const installFailed = installOperationAppId === appId
    && installDone
    && (!!installError || latestInstallEvent?.status === 'error');

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Back button */}
      <button
        onClick={() => router.push('/market')}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        {translateInterface("m7e0461b96831")}</button>

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
          </div>
          <p className="mt-1 text-[15px] text-muted-foreground">{app.description}</p>
          {isInstalled && status?.url && (
            <a href={status.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-sm text-primary hover:underline">
              {status.url}<ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>

      {/* Meta band */}
      <div className="grid grid-cols-2 gap-3 rounded-xl border bg-card p-[18px] sm:grid-cols-3 lg:grid-cols-6">
        <div className="grid gap-0.5"><span className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">{translateInterface("mdd167905de0d")}</span><span className="text-[13.5px] font-semibold">{app.version ? `v${app.version}` : '—'}</span></div>
        <div className="grid gap-0.5"><span className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">{translateInterface("m292c06f0045a")}</span><span className="text-[13.5px] font-semibold capitalize">{app.category || '—'}</span></div>
        <div className="grid gap-0.5"><span className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">{translateInterface("m0e570ca6fabe")}</span><span className="truncate text-[13.5px] font-semibold">{app.sourceName || app.sourceId || translateInterface("m5238d9bd03d5")}</span></div>
        <div className="grid gap-0.5"><span className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">{translateInterface("m3fb7b39416f1")}</span><span className="truncate text-[13.5px] font-semibold">{app.developer || app.sourceName || '—'}</span></div>
        <div className="grid gap-0.5"><span className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">{translateInterface("mc011d6097bfb")}</span><span className="text-[13.5px] font-semibold">{app.license ? <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[12px] font-semibold">{app.license}</span> : '—'}</span></div>
        <div className="grid gap-0.5"><span className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">{translateInterface("m50dfc76409a6")}</span><span className="flex items-center gap-1.5 text-[13.5px] font-semibold">{(app.supportsSSO || app.forwardAuth !== 'disabled') && <Shield className="h-3.5 w-3.5 text-green-600" />}{app.supportsSSO ? translateInterface("m78a6a8fe9be5") : status?.forwardAuthEnabled ? translateInterface("mb0ed26337336") : app.forwardAuth === 'disabled' ? translateInterface("mca1844969742") : translateInterface("m59be71333c96")}</span></div>
      </div>

      {isDirectEntry && (
        <div className="flex items-start gap-3 rounded-xl border bg-muted/40 p-4">
          <Globe className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-semibold text-foreground">{translateInterface("m8687edd1b0f6")}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {translateInterface("m9ef0e4135980")}</p>
          </div>
        </div>
      )}

      {/* Access surface — plain-language "who can reach this app" + a live full-URL chip */}
      {(
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
          <div className="flex items-center gap-3">
            <div className={`rounded-md p-2 ${accessLevel === 'public' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-500' : 'bg-primary/10 text-primary'}`}>
              {accessLevel === 'public' ? <Globe className="h-4 w-4" /> : <Shield className="h-4 w-4" />}
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">{accessLabel}</p>
              <p className="text-xs text-muted-foreground">{accessOneLiner}</p>
            </div>
          </div>
          {(() => {
            const url = isInstalled && status?.url ? status.url : (domain ? `https://${app.defaultSubdomain}.${domain}` : null);
            if (!url) return null;
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
            <FeaturedScreenshot key={shot.url} screenshot={shot} index={i} />
          ) : (
            <div key={i} className="flex items-center justify-center rounded-2xl border bg-muted/30 text-muted-foreground/40" style={{ aspectRatio: '16 / 10' }}>
              <Camera className="h-7 w-7" />
            </div>
          ),
        )}
      </div>
      {screenshots.length > 2 && (
        <div className="rounded-xl border bg-card p-[22px]">
          <h2 className="mb-3 text-[15px] font-semibold">{translateInterface("m60abd385d123")}</h2>
          <ScreenshotGallery screenshots={screenshots} />
        </div>
      )}

      {/* About */}
      <div className="rounded-xl border bg-card p-[22px]">
        <h2 className="text-[15px] font-semibold">{translateInterface("m147cb2830419")}</h2>
        <div className="mt-3 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
          {longDescription}
        </div>
      </div>

      {/* What's new — release notes for the current version */}
      {app.detail?.releaseNotes && (
        <div className="rounded-xl border bg-card p-[22px]">
          <h2 className="text-[15px] font-semibold">{translateInterface("m135e912e8905")}{app.version ? ' ' + translateInterface("me429bc12e900", {version: app.version}) : ''}</h2>
          <div className="mt-3 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
            {app.detail.releaseNotes}
          </div>
        </div>
      )}

      {/* Details section */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">
          {translateInterface("m89a9f577c96e")}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* SSO / Forward-Auth */}
          {isInstalled ? (
            <AppAccessSettings appId={app.id} />
          ) : (
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-muted">
                <Shield className="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{translateInterface("m7c3130232881")}</p>
                <p className="text-sm font-medium text-foreground">
                  {app.supportsSSO ? (
                    <span className="text-green-600">{translateInterface("m3b8ed34667d8")}</span>
                  ) : app.forwardAuth !== 'disabled' ? (
                    <span className="text-green-600">{translateInterface("ma6f7ed7701fa")}</span>
                  ) : (
                    <span className="text-muted-foreground">{translateInterface("m75081b593d15")}</span>
                  )}
                </p>
              </div>
            </div>
          )}

          {capabilityLabels.length > 0 && (
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-muted">
                <Package className="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{translateInterface("ma14a04ae3d9d")}</p>
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
                <p className="text-xs text-muted-foreground">{translateInterface("mb5a229ac8bec")}</p>
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
                <p className="text-xs text-muted-foreground">{translateInterface("mbf046c7395cb")}</p>
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
                <p className="text-xs text-muted-foreground">{translateInterface("mc205924de0fe")}</p>
                <a href={app.docs} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-primary hover:underline flex items-center gap-1">
                  {translateInterface("m61479fda2da0")}<ExternalLink className="h-3 w-3" />
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
                <p className="text-xs text-muted-foreground">{translateInterface("mbe91940b79f4")}</p>
                <a href={app.support} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-primary hover:underline flex items-center gap-1">
                  {translateInterface("mfd64e81bf74d")}<ExternalLink className="h-3 w-3" />
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
                <p className="text-xs text-muted-foreground">{translateInterface("m7c881e90d93a")}</p>
                <p className="text-sm font-medium text-foreground">
                  {isInstalled && status?.sourceName ? status.sourceName : app.sourceName}
                </p>
              </div>
            </div>
          )}
        </div>

        {isDifferentSourceVariant && (
          <div className="mt-5 rounded-lg border border-primary/30 bg-primary/10 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {translateInterface("mdcab824ab1f8", {source: app.sourceName || app.sourceId || ""})}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {translateInterface("m14d6f9f6432e", {source: status?.sourceName || status?.sourceId || ""})}
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
                {translateInterface("m9d19bd2659fc")}</Button>
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
                {translateInterface("m1331275bc537")}</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {app.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => router.push(`/market?tag=${encodeURIComponent(tag)}`)}
                  title={translateInterface("m08e9841e0650", { value0: String(tag) })}
                  className="text-xs px-2.5 py-1 rounded-full bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        )}

      </div>

      {/* Default Credentials (shown when app is installed and has credentials) */}
      {isInstalled && credentialsLoaded && credentials.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-6">
          <div className="flex items-center gap-2 mb-4">
            <KeyRound className="h-4 w-4 text-amber-600" />
            <h2 className="text-sm font-semibold text-amber-700 uppercase tracking-wide">
              {translateInterface("m4b18a259d742")}</h2>
          </div>
          <div className="space-y-3">
            {credentials.map((cred, i) => (
              <div key={i} className="rounded-lg border border-amber-200 bg-card p-4">
                <p className="text-xs text-muted-foreground font-medium mb-2">{cred.label}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs text-muted-foreground">{translateInterface("me3b89e9d33f8")}</p>
                    <div className="flex items-center gap-2">
                      <code className="text-sm font-mono text-foreground">{cred.username}</code>
                      <button
                        onClick={() => navigator.clipboard.writeText(cred.username)}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-muted-foreground"
                        title={translateInterface("m7ba3cdab9a58")}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{translateInterface("me7cf3ef4f17c")}</p>
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
                        title={visiblePasswords.has(i) ? translateInterface("ma60a56c584b3") : translateInterface("m6aeaa6a53d09")}
                      >
                        {visiblePasswords.has(i) ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        onClick={() => navigator.clipboard.writeText(cred.password)}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-muted-foreground"
                        title={translateInterface("me8cd8b5d57c9")}
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
            {translateInterface("mfbb85e515554")}</p>
        </div>
      )}

      </div>

      <aside className="lg:sticky lg:top-24">
        <div className="rounded-lg border border-border bg-card p-5 shadow-sm">
          <div className="space-y-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{translateInterface("m920e413c7d41")}</p>
              <div className="mt-2 flex items-center gap-2">
                {isInstalled ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                ) : (
                  <Package className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="text-sm font-medium text-foreground">
                  {isInstalled
                    ? appStatus
                    : installing && installOperationAppId === appId && !installDone
                      ? translateInterface("m8749b1693f74")
                      : translateInterface("mbda18b9e55aa")}
                </span>
                {isInstalled && (
                  <HealthDot
                    healthStatus={status?.healthStatus}
                    healthCheckedAt={status?.healthCheckedAt}
                  />
                )}
              </div>
            </div>

            {installing && installOperationAppId === appId && installEvents.length > 0 ? (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium text-foreground">
                      {installDone
                        ? installFailed ? translateInterface("md472ecf6a07e") : translateInterface("m5fa7aac5375c")
                        : translateInterface("m336d8f982177", { value0: String(app.name) })}
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
                        {translateInterface("med077f3d8125")}{" "}{app.name}
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
                      {translateInterface("m48845bff334a")}</Button>
                  </div>
                )}
              </div>
            ) : (
              <div className="grid gap-2">
                {!isInstalled ? (
                  <>
                    <Button onClick={() => setShowInstallDialog(true)}>
                      {translateInterface("m569ca49f4aaf")}{" "}{app.name}
                    </Button>
                    {isDirectEntry && (
                      <Button
                        variant="outline"
                        onClick={handleRemoveDirectEntry}
                        disabled={removingDirectEntry}
                      >
                        {removingDirectEntry ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                        {translateInterface("mf466b942b616")}</Button>
                    )}
                  </>
                ) : (
                  <>
                    {status?.url && (
                      <Button onClick={() => window.open(status.url, '_blank')}>
                        <ExternalLink className="h-4 w-4 mr-2" />
                        {translateInterface("med077f3d8125")}{" "}{app.name}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      onClick={handleSyncManifest}
                      disabled={syncingManifest}
                    >
                      {syncingManifest ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                      {translateInterface("m1119b6d92587")}</Button>
                    <Button
                      variant="outline"
                      className="text-red-600 hover:bg-red-50 hover:text-red-700"
                      onClick={() => setShowUninstallDialog(true)}
                      disabled={uninstalling}
                    >
                      {uninstalling ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
                      {translateInterface("mfe199528850a")}</Button>
                  </>
                )}
              </div>
            )}

            <div className="border-t border-border pt-4 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">{translateInterface("m0e570ca6fabe")}</span>
                <span className="text-right font-medium text-foreground">{app.sourceName || app.sourceId || translateInterface("m5238d9bd03d5")}</span>
              </div>
              {app.version && (
                <div className="mt-2 flex justify-between gap-3">
                  <span className="text-muted-foreground">{translateInterface("mdd167905de0d")}</span>
                  <span className="font-medium text-foreground">v{app.version}</span>
                </div>
              )}
              <div className="mt-2 flex justify-between gap-3">
                <span className="text-muted-foreground">{translateInterface("m50dfc76409a6")}</span>
                <span className="text-right font-medium text-foreground">
                  {app.supportsSSO ? translateInterface("m78a6a8fe9be5") : status?.forwardAuthEnabled ? translateInterface("mb0ed26337336") : app.forwardAuth === 'disabled' ? translateInterface("mca1844969742") : translateInterface("m59be71333c96")}
                </span>
              </div>
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

function FeaturedScreenshot({
  screenshot,
  index,
}: {
  screenshot: { url: string; caption?: string };
  index: number;
}) {
  const translateInterface = useInterfaceTranslations("interface");

  const [unavailable, setUnavailable] = useState(false);
  const label = screenshot.caption || translateInterface("m7e71e3bb6213", { value0: String(index + 1) });

  return (
    <div className="relative overflow-hidden rounded-2xl border bg-muted/30" style={{ aspectRatio: '16 / 10' }}>
      {unavailable ? (
        <div
          role="img"
          aria-label={translateInterface("m50ce40e10ef8", { value0: String(label) })}
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground/60"
        >
          <Camera className="h-7 w-7" />
          <span className="text-xs">{translateInterface("mb9bfa8c88c0d")}</span>
        </div>
      ) : (
        <Image
          src={screenshot.url}
          alt={label}
          fill
          className="object-cover"
          unoptimized
          onError={() => setUnavailable(true)}
        />
      )}
      {screenshot.caption && (
        <div className="absolute inset-x-0 bottom-0 bg-background/85 px-3.5 py-2 text-[12.5px] text-muted-foreground">
          {screenshot.caption}
        </div>
      )}
    </div>
  );
}

function ScreenshotGallery({ screenshots }: ScreenshotGalleryProps) {
  const translateInterface = useInterfaceTranslations("interface");

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [unavailable, setUnavailable] = useState<Set<number>>(new Set());

  const markUnavailable = (index: number) => {
    setUnavailable((current) => new Set(current).add(index));
    setSelectedIndex((current) => current === index ? null : current);
  };

  return (
    <>
      {/* Horizontal scroll strip */}
      <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-thin">
        {screenshots.map((shot, i) => (
          <button
            key={i}
            onClick={() => setSelectedIndex(i)}
            disabled={unavailable.has(i)}
            className="shrink-0 rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2"
          >
            {unavailable.has(i) ? (
              <div
                role="img"
                aria-label={translateInterface("m50ce40e10ef8", { value0: String(shot.caption || translateInterface("m02f26e93f8eb", {number: i + 1})) })}
                className="flex h-[180px] w-[280px] flex-col items-center justify-center gap-2 bg-muted/30 text-muted-foreground/60"
              >
                <Camera className="h-7 w-7" />
                <span className="text-xs">{translateInterface("mb9bfa8c88c0d")}</span>
              </div>
            ) : (
              <Image
                src={shot.url}
                alt={shot.caption || translateInterface("m7e71e3bb6213", { value0: String(i + 1) })}
                width={280}
                height={180}
                className="h-[180px] w-auto object-cover"
                unoptimized
                onError={() => markUnavailable(i)}
              />
            )}
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
                translateInterface("m7e71e3bb6213", { value0: String(selectedIndex + 1) })
              }
              width={1200}
              height={800}
              className="rounded-lg max-h-[85vh] w-auto object-contain"
              unoptimized
              onError={() => markUnavailable(selectedIndex)}
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
