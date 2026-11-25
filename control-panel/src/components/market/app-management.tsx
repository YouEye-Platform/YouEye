'use client';

/**
 * Managing an installed app, for its page in Settings → Apps. These parts used to sit on the app's Market page; the
 * Market is now a store (browse, read, install, open) and everything that changes an installed app lives in Settings.
 *
 * - AppUpdateSource: which market the app takes its updates from, switching it (with Plan 10's consent for an app
 *   added by URL), and reading its manifest again from that source.
 * - AppDefaultCredentials: the sign-in an app was installed with, for apps that have one.
 * - AppUninstall: removing the app, keeping or deleting its data.
 */

import { useTranslations as useInterfaceTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Copy, Eye, EyeOff, KeyRound, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppSection, groupClass, rowClass } from '@/components/settings-shell/app-section';
import { UninstallDialog } from '@/components/market/uninstall-dialog';
import { UpdateBlockedNote, installBlockedLabel } from '@/components/market/update-blocked';
import { authenticatedFetch } from '@/lib/api-client';
import type { MarketApp, MarketAppInstalledSource, MarketAppVariant } from '@/lib/market/types';
import { connectionsLeftFrom, type ConnectionLeft } from '@/lib/market/uninstall-notice';

interface MarketAppState {
  app: MarketApp | null;
  variants: MarketAppVariant[];
  installed: MarketAppInstalledSource | null;
  loaded: boolean;
  reload: () => Promise<void>;
}

// One market lookup per app at a time: the Updates and Uninstall sections ask together, and the lookup reads every
// market, which can take a while.
const marketAppRequests = new Map<string, Promise<{ ok: boolean; data: Record<string, unknown> }>>();
function fetchMarketApp(appId: string) {
  let request = marketAppRequests.get(appId);
  if (!request) {
    request = fetch(`/api/market/app/${encodeURIComponent(appId)}`)
      .then(async (res) => ({ ok: res.ok, data: await res.json().catch(() => ({})) }))
      .finally(() => marketAppRequests.delete(appId));
    marketAppRequests.set(appId, request);
  }
  return request;
}

/** The app as its market lists it, the same markets' other copies, and where the installed copy updates from. */
function useMarketApp(appId: string): MarketAppState {
  const [app, setApp] = useState<MarketApp | null>(null);
  const [variants, setVariants] = useState<MarketAppVariant[]>([]);
  const [installed, setInstalled] = useState<MarketAppInstalledSource | null>(null);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    try {
      const { ok, data } = await fetchMarketApp(appId);
      if (ok) {
        setApp((data.app as MarketApp | undefined) ?? null);
        setVariants(Array.isArray(data.variants) ? data.variants as MarketAppVariant[] : []);
        setInstalled((data.installed as MarketAppInstalledSource | undefined) ?? null);
      }
    } catch {
      // The network failed: the sections show what they can without the listing.
    } finally {
      setLoaded(true);
    }
  }, [appId]);
  useEffect(() => { reload(); }, [reload]);
  return { app, variants, installed, loaded, reload };
}

/** `updateInfo`: what the waiting update is, when there is one (the update itself is started from Settings → Apps). */
export function AppUpdateSource({ appId, updateInfo }: { appId: string; updateInfo?: string | null }) {
  const translateInterface = useInterfaceTranslations('interface');
  const t = useInterfaceTranslations('settingsApps');
  const { app, variants, installed, loaded, reload } = useMarketApp(appId);
  const [choosing, setChoosing] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [consent, setConsent] = useState<Record<string, boolean>>({});
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!loaded) return null;
  if (!app || !installed) return null;

  const shown: MarketAppVariant | null = app.sourceId ? {
    sourceId: app.sourceId, sourceName: app.sourceName || app.sourceId, version: app.version ?? null,
    ...(app.sourceNotAccepted ? { sourceNotAccepted: true as const } : {}),
    ...(app.installBlocked ? { installBlocked: true as const } : {}),
    ...(app.needsYouEye ? { needsYouEye: app.needsYouEye } : {}),
  } : null;
  const targets = [...(shown ? [shown] : []), ...variants].filter((variant) => variant.sourceId !== installed.sourceId);
  const blockedReason = (variant: MarketAppVariant) => variant.installBlocked
    ? installBlockedLabel(translateInterface, { installBlocked: { code: 'requires-newer-youeye', message: '' }, needsYouEye: variant.needsYouEye })
    : variant.sourceNotAccepted ? translateInterface('m8ba391628be0') : null;

  // Change where the installed app takes its updates from: only on the owner's choice, with Plan 10's consent.
  const switchTo = async (target: MarketAppVariant) => {
    setSwitching(target.sourceId);
    setMessage(null);
    try {
      const agreed = consent[target.sourceId] === true;
      const res = await authenticatedFetch(`/api/market/app/${encodeURIComponent(appId)}/source`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target.sourceId.startsWith('direct:')
          ? { sourceId: target.sourceId, acceptUnverifiedPublisher: agreed, allowSetup: agreed }
          : { sourceId: target.sourceId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || translateInterface('m5aa40c1a8a54'));
      setMessage(translateInterface('me1c329162f46', { source: String(data.sourceName || target.sourceName || target.sourceId) }));
      setChoosing(false);
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : translateInterface('m5aa40c1a8a54'));
    } finally {
      setSwitching(null);
    }
  };

  const syncManifest = async () => {
    setSyncing(true);
    setMessage(null);
    try {
      const res = await authenticatedFetch(`/api/market/app/${encodeURIComponent(appId)}/manifest-sync`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.status !== 'ok') throw new Error(data.error || translateInterface('m1264a555555b'));
      const source = data.sourceId || installed.sourceName || app.sourceName || app.sourceId || translateInterface('m97fc597a6e34');
      const surfaces = Number.isFinite(data.surfaces)
        ? translateInterface('mcef48023dc9a', { count: Number(data.surfaces) })
        : translateInterface('m2e1444edc0e2');
      setMessage(translateInterface('m915c8bdb5720', { app: app.name, source, surfaces }));
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : translateInterface('m1264a555555b'));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <AppSection id="updates" title={t('updates.title')}>
      <div className={groupClass}>
        {updateInfo != null && (
          <div className={rowClass}>
            <p className="min-w-0 text-sm font-medium text-foreground [overflow-wrap:anywhere]">{updateInfo || translateInterface('mff8b555d818f')}</p>
            <Button variant="outline" size="sm" asChild>
              <Link href="/settings/apps">{t('updates.seeUpdates')}</Link>
            </Button>
          </div>
        )}
        <div className={rowClass}>
          <div className="min-w-0">
            <p className="text-[13px] text-muted-foreground">{translateInterface('m2c0729afc9a9')}</p>
            <p className="text-sm font-medium text-foreground [overflow-wrap:anywhere]">{installed.sourceName || '—'}</p>
            {installed.sourceAddress && (
              <p className="truncate font-mono text-[12px] text-muted-foreground" title={installed.sourceAddress}>{installed.sourceAddress}</p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={syncManifest} disabled={syncing}>
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {translateInterface('m1119b6d92587')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setChoosing((open) => !open)} aria-expanded={choosing}>
              {t('updates.changeSource')}
            </Button>
          </div>
        </div>
        {installed.updateBlocked && (
          <div className="px-4 py-3.5"><UpdateBlockedNote blocked={installed.updateBlocked} appId={appId} /></div>
        )}
        {choosing && (
          <>
            <p className="px-4 py-3.5 text-[13px] leading-relaxed text-muted-foreground">
              {translateInterface('m4a8878ba958d')}
              {targets.length === 0 && (
                <span className="mt-1 block text-foreground">
                  {translateInterface('m5eda0c99287d')}{' '}
                  <Link href="/market/sources" className="font-medium text-primary hover:underline">{translateInterface('mbc5015d35cc2')}</Link>
                </span>
              )}
            </p>
            {targets.map((variant) => {
              const blocked = blockedReason(variant);
              const direct = variant.sourceId.startsWith('direct:');
              return (
                <div key={variant.sourceId} className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-3.5">
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="truncate text-sm font-medium text-foreground">{variant.sourceName}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {variant.version ? `v${variant.version}` : ''}
                      {blocked ? `${variant.version ? ' · ' : ''}${blocked}` : ''}
                    </p>
                  </div>
                  {direct && !blocked && (
                    <label className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 text-[13px] text-foreground">
                      <input
                        type="checkbox"
                        className="size-4 shrink-0"
                        checked={consent[variant.sourceId] === true}
                        onChange={(event) => setConsent((current) => ({ ...current, [variant.sourceId]: event.target.checked }))}
                      />
                      {translateInterface('m5ae862f2c24b')}
                    </label>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => switchTo(variant)}
                    disabled={switching !== null || !!blocked || (direct && consent[variant.sourceId] !== true)}
                    title={blocked ?? undefined}
                  >
                    {switching === variant.sourceId ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {translateInterface('m9d19bd2659fc')}
                  </Button>
                </div>
              );
            })}
          </>
        )}
        {message && <p role="status" className="px-4 py-3.5 text-sm text-foreground">{message}</p>}
      </div>
    </AppSection>
  );
}

export function AppDefaultCredentials({ appId }: { appId: string }) {
  const translateInterface = useInterfaceTranslations('interface');
  const t = useInterfaceTranslations('settingsApps');
  const [credentials, setCredentials] = useState<{ label: string; username: string; password: string }[]>([]);
  const [visible, setVisible] = useState<Set<number>>(new Set());

  useEffect(() => {
    authenticatedFetch(`/api/market/credentials?app=${encodeURIComponent(appId)}`)
      .then(async (res) => { if (res.ok) setCredentials((await res.json()).credentials ?? []); })
      .catch(() => { /* non-fatal: nothing is shown */ });
  }, [appId]);

  if (credentials.length === 0) return null;
  const copyButton = (value: string, title: string) => (
    <button
      type="button"
      onClick={() => navigator.clipboard.writeText(value)}
      className="grid size-8 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-11"
      title={title}
      aria-label={title}
    >
      <Copy className="h-3.5 w-3.5" />
    </button>
  );
  return (
    <AppSection id="default-sign-in" title={t('defaultSignIn.title')} description={translateInterface('mfbb85e515554')}>
      <div className={groupClass}>
        {credentials.map((cred, i) => (
          <div key={i} className="min-w-0 px-4 py-3.5">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><KeyRound className="h-3.5 w-3.5" />{cred.label}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{translateInterface('me3b89e9d33f8')}</p>
                <div className="flex items-center gap-1">
                  <code className="min-w-0 truncate font-mono text-sm text-foreground">{cred.username}</code>
                  {copyButton(cred.username, translateInterface('m7ba3cdab9a58'))}
                </div>
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{translateInterface('me7cf3ef4f17c')}</p>
                <div className="flex items-center gap-1">
                  <code className="min-w-0 truncate font-mono text-sm text-foreground">{visible.has(i) ? cred.password : '•'.repeat(12)}</code>
                  <button
                    type="button"
                    onClick={() => setVisible((prev) => { const next = new Set(prev); if (next.has(i)) next.delete(i); else next.add(i); return next; })}
                    className="grid size-8 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-11"
                    title={visible.has(i) ? translateInterface('ma60a56c584b3') : translateInterface('m6aeaa6a53d09')}
                    aria-label={visible.has(i) ? translateInterface('ma60a56c584b3') : translateInterface('m6aeaa6a53d09')}
                  >
                    {visible.has(i) ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                  {copyButton(cred.password, translateInterface('me8cd8b5d57c9'))}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </AppSection>
  );
}

/** `appName`: the installed app's own name, so an app its market no longer lists can still be removed. */
export function AppUninstall({ appId, appName }: { appId: string; appName: string }) {
  const translateInterface = useInterfaceTranslations('interface');
  const t = useInterfaceTranslations('settingsApps');
  const router = useRouter();
  const { app: listed } = useMarketApp(appId);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the app is uninstalled but a connected app may still list it (YE-199): shown before leaving the page.
  const [connectionsLeft, setConnectionsLeft] = useState<ConnectionLeft[] | null>(null);

  // Shown at once, without waiting for the market listing. The dialog needs the id, the name and whether the app
  // signs in with YouEye ID; until the listing is there (or when its market is gone or no longer has it) the
  // installed app's own name stands in, and the sign-in line is left out.
  const app = listed ?? ({ id: appId, name: appName, supportsSSO: false } as MarketApp);

  const uninstall = async (id: string, keepData: boolean) => {
    setOpen(false);
    setPending(true);
    setError(null);
    try {
      const res = await authenticatedFetch('/api/market/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: id, keepData }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // The route says why in `errors` (busy, cleanup not finished, …).
        const reasons = Array.isArray(data.errors) ? data.errors.filter((e: unknown) => typeof e === 'string' && e) : [];
        throw new Error(reasons.join('; ') || data.error || `HTTP ${res.status}`);
      }
      const left = connectionsLeftFrom(await res.json().catch(() => null));
      if (left.length > 0) {
        setConnectionsLeft(left);
        setPending(false);
        return;
      }
      router.push('/settings/apps');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  };

  if (connectionsLeft) {
    return (
      <AppSection id="uninstall" title={translateInterface('mfe199528850a')}>
        <div className={groupClass}>
          <div className={rowClass} role="status">
            <div className="min-w-0 space-y-1 text-sm">
              <p className="font-medium">{t('uninstall.done', { app: app.name })}</p>
              {connectionsLeft.map((left) => (
                <p key={left.appId ?? ''} className="text-muted-foreground">
                  {left.appId
                    ? t('uninstall.leftIn', { app: app.name, other: left.name ?? left.appId })
                    : t('uninstall.leftSomewhere', { app: app.name })}
                </p>
              ))}
            </div>
            <Button variant="outline" size="sm" className="shrink-0" asChild>
              <Link href="/settings/apps">{t('uninstall.backToApps')}</Link>
            </Button>
          </div>
        </div>
      </AppSection>
    );
  }

  return (
    <AppSection id="uninstall" title={translateInterface('mfe199528850a')}>
      <div className={groupClass}>
        <div className={rowClass}>
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">{t('uninstall.hint', { app: app.name })}</p>
            {error && <p role="alert" className="mt-1 text-[13px] text-destructive">{error}</p>}
          </div>
          <Button variant="outline" className="shrink-0 text-destructive hover:text-destructive" onClick={() => setOpen(true)} disabled={pending}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            {t('uninstall.action')}
          </Button>
        </div>
      </div>
      {open && <UninstallDialog app={app} onUninstall={uninstall} onClose={() => setOpen(false)} />}
    </AppSection>
  );
}
