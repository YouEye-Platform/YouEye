'use client';

import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useState, useEffect, useCallback, useMemo, type CSSProperties } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  AlertCircle,
  AtSign,
  BellRing,
  BookOpen,
  Bot,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Code2,
  ExternalLink,
  Globe,
  KeyRound,
  LayoutGrid,
  Link2,
  Loader2,
  Mail,
  MessageCircle,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InstallDialog } from '@/components/market/install-dialog';
import { InstallBlockedNotice } from '@/components/market/update-blocked';
import { AppTile, MarketIcon, MarketPicture, categoryLookup } from '@/components/market/market-parts';
import { authenticatedFetch } from '@/lib/api-client';
import type { MarketApp, AppStatusInfo, InstallConfig, InstallEvent, MarketAppVariant, MarketCategory } from '@/lib/market/types';

/**
 * An app in the Market, as it is published (the same on every server): what it is, what it adds to this server,
 * and Install. Once installed, the page only opens it or its page in Settings → Apps, where its access, updates,
 * data and health are.
 *
 * Order: header with the one action → facts (each once) → screenshots → about → what it adds → what's new → links
 * → other sources and tags → more apps like it.
 */
export default function AppDetailPage() {
  const translateInterface = useInterfaceTranslations("interface");
  const market = useInterfaceTranslations("marketStore");
  const preparingInstallEvent: InstallEvent = { step: 0, totalSteps: 0, status: 'running', message: translateInterface("mb7b55c7307a4") };

  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const appId = params.appId as string;
  const sourceId = searchParams.get('source') || undefined;

  const [app, setApp] = useState<MarketApp | null>(null);
  // Other markets (and apps added by address) with the same app id.
  const [variants, setVariants] = useState<MarketAppVariant[]>([]);
  const [status, setStatus] = useState<AppStatusInfo | null>(null);
  const [catalog, setCatalog] = useState<{ apps: MarketApp[]; categories: MarketCategory[] }>({ apps: [], categories: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [domain, setDomain] = useState('');
  const [siteName, setSiteName] = useState('YouEye');
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shown, setShown] = useState<number | null>(null);

  // Install state
  const [showInstallDialog, setShowInstallDialog] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installEvents, setInstallEvents] = useState<InstallEvent[]>([]);
  const [installDone, setInstallDone] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installOperationAppId, setInstallOperationAppId] = useState<string | null>(null);
  const [pollingAppId, setPollingAppId] = useState<string | null>(null);
  const [removeMessage, setRemoveMessage] = useState<string | null>(null);
  const [removingDirectEntry, setRemovingDirectEntry] = useState(false);

  const fetchApp = useCallback(async () => {
    try {
      const suffix = sourceId ? `?source=${encodeURIComponent(sourceId)}` : '';
      const res = await fetch(`/api/market/app/${encodeURIComponent(appId)}${suffix}`);
      if (res.status === 404) {
        setError(translateInterface("mab1663c1b5b2"));
        return;
      }
      const data = await res.json().catch(() => ({}));
      // The API's reason (an app whose manifest does not load says why).
      if (!res.ok) {
        setError(typeof data.error === 'string' && data.error ? data.error : translateInterface("m49a2883cb71a"));
        return;
      }
      setApp(data.app);
      setVariants(Array.isArray(data.variants) ? data.variants : []);
    } catch {
      setError(translateInterface("m49a2883cb71a"));
    }
  }, [appId, sourceId, translateInterface]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/market/status?app=${encodeURIComponent(appId)}`);
      if (res.ok) setStatus(await res.json());
    } catch {
      // Not fatal: the page shows the app as not installed.
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
      // The address is left out.
    }
  }, []);

  // The catalog, for the category's name and more apps like this one (the box keeps it; this does not wait on the
  // network).
  const fetchCatalog = useCallback(async () => {
    try {
      const res = await fetch('/api/market/catalog');
      if (!res.ok) return;
      const data = await res.json();
      setCatalog({ apps: Array.isArray(data.apps) ? data.apps : [], categories: Array.isArray(data.categories) ? data.categories : [] });
    } catch {
      // No related apps.
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setAboutOpen(false);
    Promise.all([fetchApp(), fetchStatus(), fetchDomain()]).finally(() => setLoading(false));
    void fetchCatalog();
    const interval = setInterval(fetchStatus, 10_000);
    return () => clearInterval(interval);
  }, [fetchApp, fetchStatus, fetchDomain, fetchCatalog]);

  // ── Install progress ─────────────────────────────

  useEffect(() => {
    // Next can keep this component while the app in the address changes: never show one app's install on another.
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
      } catch { /* the next poll */ }
    };
    const interval = setInterval(poll, 1500);
    void poll();
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [appId, pollingAppId, fetchStatus]);

  // An install already running (or one that failed) for this app shows when the page opens.
  useEffect(() => {
    let active = true;
    async function checkExistingInstall() {
      try {
        const res = await fetch(`/api/market/install-status?app=${encodeURIComponent(appId)}`);
        if (!res.ok) return;
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
          // A finished, successful install is not replayed: the app's state says it is installed (or, once it was
          // uninstalled, an old "installed" would hide Install). A failed one stays, so its reason can be read.
          if (data.done && !data.error) return;
          setInstalling(true);
          setInstallOperationAppId(appId);
          setInstallEvents(data.events);
          setInstallError(data.error || null);
          if (data.done) setInstallDone(true);
          else setPollingAppId(appId);
        }
      } catch { /* nothing to show */ }
    }
    void checkExistingInstall();
    return () => { active = false; };
  }, [appId]);

  const handleInstall = async (config: InstallConfig) => {
    setShowInstallDialog(false);
    setInstalling(true);
    setInstallOperationAppId(config.appId);
    setInstallEvents([preparingInstallEvent]);
    setInstallDone(false);
    setInstallError(null);
    // The server installs in the background; the page follows its progress.
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
      try { res.body?.cancel(); } catch { /* already closed */ }
    } catch (err) {
      setInstallEvents([{ step: 0, totalSteps: 0, status: 'error', message: translateInterface("m545028cf06c9"), detail: String(err) }]);
      setInstallError(err instanceof Error ? err.message : String(err));
      setInstallDone(true);
      return;
    }
    setPollingAppId(config.appId);
  };

  const handleRemoveDirectEntry = async () => {
    if (!app?.sourceId?.startsWith('direct:')) return;
    setRemovingDirectEntry(true);
    try {
      const res = await authenticatedFetch(`/api/market/direct/${encodeURIComponent(app.sourceId)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || translateInterface("m1a8ce79186c6"));
      router.push('/market');
    } catch (err) {
      setRemoveMessage(err instanceof Error ? err.message : translateInterface("m1a8ce79186c6"));
    } finally {
      setRemovingDirectEntry(false);
    }
  };

  const categories = useMemo(() => categoryLookup(catalog.categories), [catalog.categories]);

  // ── Loading and not found ─────────────────────────

  const back = (
    <Link href="/market" className="settings-back -ml-1 mb-4 w-fit">
      <ChevronLeft className="size-5" aria-hidden />
      {translateInterface("m5238d9bd03d5")}
    </Link>
  );

  if (loading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>;
  }

  if (error || !app) {
    return (
      <div className="mx-auto max-w-3xl">
        {back}
        <div className="rounded-2xl border border-dashed p-10 text-center">
          <AlertCircle className="mx-auto mb-3 h-9 w-9 text-muted-foreground/60" aria-hidden />
          <h1 className="text-lg font-semibold">{translateInterface("mfc142cacf2d2")}</h1>
          <p className="mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">{error || market("notFound", { app: appId })}</p>
          <Button variant="outline" className="mt-5 rounded-full" onClick={() => router.push('/market')}>{translateInterface("mf3198e9d9e96")}</Button>
        </div>
      </div>
    );
  }

  // ── Derived ───────────────────────────────────────

  const isInstalled = (status?.status ?? 'not-installed') !== 'not-installed';
  const isDirectEntry = !!app.sourceId?.startsWith('direct:');
  const sourceNotAccepted = app.sourceNotAccepted === true;
  const screenshots = app.detail?.screenshots ?? [];
  const about = app.detail?.longDescription || app.description;
  const summary = app.tagline || (app.detail?.longDescription ? app.description : null);
  const aboutIsLong = about.length > 360 || about.split('\n').length > 4;

  // How people sign in, and who can open it, as the manifest says (whether an installed app's sign-in is on, and who
  // may use it, are on its page in Settings).
  const ownAccountSignIn = app.supportsSSO || !!app.integrations?.some((integration) => integration.type === 'identity');
  const gate = app.forwardAuth !== 'disabled';
  // Admission applies to every app; only public access (the "Only <site> users" switch off) opens one (YE-154).
  const everyone = !!app.publicAccess && !app.gateOnly;
  const signIn = ownAccountSignIn ? market("facts.signInAccount", { site: siteName }) : gate ? market("facts.signInGate", { site: siteName }) : market("facts.signInOwn");
  const access = everyone ? market("facts.accessAnyone") : market("facts.accessUsers", { site: siteName });
  const facts = [
    { label: market("facts.signIn"), value: signIn },
    { label: market("facts.access"), value: access },
    app.license ? { label: market("facts.licence"), value: app.license } : null,
    app.version ? { label: market("facts.version"), value: app.version } : null,
  ].filter((fact): fact is { label: string; value: string } => !!fact);

  // What installing it adds to this server, in plain words.
  type Addition = { icon: typeof Globe; label: string; hint: string };
  const additions = ([
    !isInstalled && domain && app.defaultSubdomain ? { icon: Globe, label: market("adds.address"), hint: `${app.defaultSubdomain}.${domain}` } : null,
    ownAccountSignIn ? { icon: KeyRound, label: market("adds.account", { site: siteName }), hint: market("adds.accountHint") } : null,
    !ownAccountSignIn && gate ? { icon: ShieldCheck, label: market("adds.gate", { site: siteName }), hint: market("adds.gateHint", { site: siteName }) } : null,
    everyone ? { icon: Users, label: market("adds.public"), hint: market("adds.publicHint") } : null,
    app.capabilities?.widgets ? { icon: LayoutGrid, label: market("adds.widgets"), hint: market("adds.widgetsHint", { site: siteName }) } : null,
    app.capabilities?.notifications ? { icon: BellRing, label: market("adds.notifications"), hint: market("adds.notificationsHint", { site: siteName }) } : null,
    app.capabilities?.ai_api ? { icon: Bot, label: market("adds.ai"), hint: market("adds.aiHint") } : null,
    app.capabilities?.smtp ? { icon: Mail, label: market("adds.email"), hint: market("adds.emailHint") } : null,
    app.capabilities?.link_handlers?.length ? { icon: Link2, label: market("adds.links"), hint: app.capabilities.link_handlers.map((handler) => handler.description).filter(Boolean).join(' · ') || market("adds.linksHint") } : null,
    app.surfaces?.length ? { icon: AtSign, label: market("adds.surfaces", { site: siteName }), hint: market("adds.surfacesHint", { count: app.surfaces.length, site: siteName }) } : null,
  ] as (Addition | null)[]).filter((addition): addition is Addition => !!addition);

  const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
  const links = [
    app.website ? { icon: Globe, label: market("links.website"), url: app.website } : null,
    app.docs ? { icon: BookOpen, label: market("links.docs"), url: app.docs } : null,
    app.support ? { icon: MessageCircle, label: market("links.support"), url: app.support } : null,
    app.sourceCode ? { icon: Code2, label: market("links.source"), url: app.sourceCode } : null,
  ].filter((link): link is { icon: typeof Globe; label: string; url: string } => !!link);

  const related = (() => {
    const seen = new Set<string>([app.id]);
    return catalog.apps
      .filter((other) => other.category === app.category && !other.installBlocked)
      .filter((other) => (seen.has(other.id) ? false : (seen.add(other.id), true)))
      .slice(0, 6);
  })();

  const latestInstallEvent = installEvents[installEvents.length - 1];
  const installPercent = latestInstallEvent?.totalSteps ? Math.round((latestInstallEvent.step / latestInstallEvent.totalSteps) * 100) : 0;
  const thisInstall = installing && installOperationAppId === appId && installEvents.length > 0;
  const installFailed = installOperationAppId === appId && installDone && (!!installError || latestInstallEvent?.status === 'error');

  // ── The one action, in the header ───────────────────

  const action = thisInstall ? null : isInstalled ? (
    <>
      {status?.url && (
        <Button asChild className="rounded-full px-6">
          <a href={status.url} target="_blank" rel="noopener noreferrer">{translateInterface("med077f3d8125")}<ExternalLink /></a>
        </Button>
      )}
      <Button asChild variant="outline" className="rounded-full">
        <Link href={`/settings/apps/${encodeURIComponent(app.id)}`}>{market("manageInSettings")}</Link>
      </Button>
    </>
  ) : app.installBlocked ? null : (
    <>
      <Button className="rounded-full px-7" onClick={() => setShowInstallDialog(true)} disabled={sourceNotAccepted}>{translateInterface("m569ca49f4aaf")}</Button>
      {isDirectEntry && (
        <Button variant="ghost" className="rounded-full" onClick={handleRemoveDirectEntry} disabled={removingDirectEntry}>
          {removingDirectEntry ? <Loader2 className="animate-spin" /> : <Trash2 />}
          {translateInterface("mf466b942b616")}
        </Button>
      )}
    </>
  );

  return (
    <div className="mx-auto max-w-[880px] pb-16">
      {back}

      <header className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-4 sm:gap-5">
          <MarketIcon app={app} size={88} tile={categories.tile(app.category)} />
          <div className="min-w-0 flex-1 pt-1">
            <h1 className="text-[26px] font-semibold leading-tight tracking-tight [overflow-wrap:anywhere] sm:text-[30px]">{app.name}</h1>
            {summary && <p className="mt-1 text-[15px] leading-snug text-muted-foreground">{summary}</p>}
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              {[app.developer && market("by", { developer: app.developer }), app.category && categories.label(app.category), app.sourceId && app.sourceId !== 'official' ? (app.sourceName || app.sourceId) : null].filter(Boolean).join(' · ')}
            </p>
            {isInstalled && <p className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-medium text-foreground"><CheckCircle2 className="h-4 w-4 text-primary" aria-hidden />{translateInterface("mf8b32f4e92bd")}</p>}
          </div>
        </div>
        {action && <div className="flex shrink-0 flex-wrap gap-2 sm:flex-col sm:items-stretch sm:pt-2 [&>*]:flex-1 sm:[&>*]:flex-none">{action}</div>}
      </header>

      {!thisInstall && !isInstalled && app.installBlocked && <div className="mt-5"><InstallBlockedNotice app={app} /></div>}
      {removeMessage && <p role="alert" className="mt-3 text-[13px] text-destructive">{removeMessage}</p>}

      {thisInstall && (
        <section aria-live="polite" className="mt-6 rounded-2xl border bg-card p-5">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium">
              {installDone ? (installFailed ? translateInterface("md472ecf6a07e") : market("installed", { app: app.name })) : translateInterface("m336d8f982177", { value0: String(app.name) })}
            </span>
            {!installDone && <span className="text-muted-foreground tabular-nums">{installPercent}%</span>}
          </div>
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className={`h-full rounded-full transition-all duration-500 ${installFailed ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${installDone ? 100 : installPercent}%` }} />
          </div>
          {latestInstallEvent?.message && <p className="mt-2.5 text-[13px] text-muted-foreground">{latestInstallEvent.message}</p>}
          {installFailed && latestInstallEvent?.detail && <p className="mt-1 text-[13px] text-destructive [overflow-wrap:anywhere]">{latestInstallEvent.detail}</p>}
          {installEvents.length > 1 && (
            <details className="settings-details mt-2">
              <summary>{market("installSteps")}</summary>
              <ol className="mt-2 space-y-1.5 text-[13px]">
                {installEvents.map((event, i) => (
                  <li key={`${event.step}-${i}-${event.message}`} className="flex items-start gap-2">
                    {event.status === 'running' ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                      : event.status === 'error' ? <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                      : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 [overflow-wrap:anywhere]">{event.message}{event.detail ? <span className="text-muted-foreground"> · {event.detail}</span> : null}</span>
                  </li>
                ))}
              </ol>
            </details>
          )}
          {installDone && (
            <div className="mt-4 flex flex-wrap gap-2">
              {!installFailed && status?.url && (
                <Button asChild className="rounded-full px-6"><a href={status.url} target="_blank" rel="noopener noreferrer">{translateInterface("med077f3d8125")}<ExternalLink /></a></Button>
              )}
              <Button variant="outline" className="rounded-full" onClick={() => { setInstalling(false); setInstallEvents([]); setInstallDone(false); }}>
                {installFailed ? translateInterface("m48845bff334a") : market("done")}
              </Button>
            </div>
          )}
        </section>
      )}

      {sourceNotAccepted && (
        <p className="mt-5 flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
          {translateInterface("me9861c99fab8", { source: app.sourceName || app.sourceId || '', id: app.sourceId || '' })}
        </p>
      )}
      {isDirectEntry && (
        <p className="mt-5 flex items-start gap-2.5 rounded-xl border bg-muted/40 p-4 text-sm text-muted-foreground">
          <Globe className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span><span className="font-medium text-foreground">{translateInterface("m8687edd1b0f6")}.</span> {translateInterface("m9ef0e4135980")}</span>
        </p>
      )}

      {facts.length > 0 && (
        <dl className="market-facts mt-7" style={{ '--market-facts': facts.length } as CSSProperties}>
          {facts.map((fact) => (
            <div key={fact.label} className="market-fact"><dt>{fact.label}</dt><dd>{fact.value}</dd></div>
          ))}
        </dl>
      )}

      {screenshots.length > 0 && (
        <section aria-label={market("screenshots")} className="mt-7">
          <div className="market-shots">
            {screenshots.map((shot, i) => (
              <button key={shot.url} type="button" className="market-shot" onClick={() => setShown(i)}
                aria-label={shot.caption || translateInterface("m7e71e3bb6213", { value0: String(i + 1) })}>
                <Shot url={shot.url} />
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="mt-8 space-y-9">
        <section aria-labelledby="market-about" className="space-y-2">
          <h2 id="market-about" className="text-lg font-semibold tracking-tight">{market("about")}</h2>
          <Prose text={about} className={aboutIsLong && !aboutOpen ? 'max-h-[8.25rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]' : ''} />
          {aboutIsLong && (
            <button type="button" className="settings-link" onClick={() => setAboutOpen((open) => !open)}>{aboutOpen ? market("less") : market("more")}</button>
          )}
        </section>

        {additions.length > 0 && (
          <section aria-labelledby="market-adds" className="settings-section">
            <h2 id="market-adds" className="text-lg font-semibold tracking-tight">{market("adds.title")}</h2>
            <ul className="settings-group">
              {additions.map((addition) => {
                const Icon = addition.icon;
                return (
                  <li key={addition.label} className="settings-item">
                    <span className="settings-row-icon" aria-hidden><Icon className="size-[18px]" /></span>
                    <span className="settings-item-text">
                      <span className="settings-item-label">{addition.label}</span>
                      <span className="settings-item-hint">{addition.hint}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {app.detail?.releaseNotes && (
          <section aria-labelledby="market-new" className="space-y-2">
            <h2 id="market-new" className="text-lg font-semibold tracking-tight">{market("whatsNew")}</h2>
            {app.version && <p className="text-[13px] text-muted-foreground tabular-nums">{market("version", { version: app.version })}</p>}
            <Prose text={app.detail.releaseNotes} />
          </section>
        )}

        {links.length > 0 && (
          <section aria-labelledby="market-links" className="settings-section">
            <h2 id="market-links" className="text-lg font-semibold tracking-tight">{market("links.title")}</h2>
            <ul className="settings-group">
              {links.map((link) => {
                const Icon = link.icon;
                return (
                  <li key={link.label}>
                    <a href={link.url} target="_blank" rel="noopener noreferrer" className="settings-row settings-row-compact">
                      <span className="settings-row-icon" aria-hidden><Icon className="size-[18px]" /></span>
                      <span className="min-w-0 flex-1 font-medium">{link.label}</span>
                      <span className="min-w-0 truncate text-[13px] text-muted-foreground">{host(link.url)}</span>
                      <ExternalLink className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {(variants.length > 0 || app.tags.length > 0) && (
          <section className="space-y-3">
            {variants.map((variant) => (
              <p key={variant.sourceId} className="text-[13px] text-muted-foreground">
                {translateInterface("mf1c107e6139e", { source: variant.sourceName })}
                {variant.version && app.version && variant.version !== app.version ? ` (${variant.version})` : ''}{" · "}
                <Link href={`/market/${encodeURIComponent(app.id)}?source=${encodeURIComponent(variant.sourceId)}`} className="font-medium text-primary hover:underline">{translateInterface("mdcc839a4015c")}</Link>
              </p>
            ))}
            {app.tags.length > 0 && (
              <ul className="flex flex-wrap gap-1.5" aria-label={market("tags")}>
                {app.tags.map((tag) => (
                  <li key={tag}>
                    <Link href={`/market?q=${encodeURIComponent(tag)}`} className="inline-flex h-8 items-center rounded-full bg-muted px-3 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">{tag}</Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {related.length > 0 && (
          <section aria-labelledby="market-related" className="space-y-3">
            <h2 id="market-related" className="text-lg font-semibold tracking-tight">{market("related", { category: categories.label(app.category) })}</h2>
            <div className="market-grid">
              {related.map((other) => <AppTile key={`${other.id}-${other.sourceId ?? ''}`} app={other} installed={false} tile={categories.tile(other.category)} />)}
            </div>
          </section>
        )}
      </div>

      {shown !== null && screenshots[shown] && (
        <div role="dialog" aria-modal="true" aria-label={screenshots[shown].caption || market("screenshots")}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" onClick={() => setShown(null)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setShown(null);
            if (event.key === 'ArrowLeft') setShown((index) => (index !== null && index > 0 ? index - 1 : index));
            if (event.key === 'ArrowRight') setShown((index) => (index !== null && index < screenshots.length - 1 ? index + 1 : index));
          }}>
          <div className="relative max-h-full max-w-5xl" onClick={(event) => event.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={screenshots[shown].url} alt={screenshots[shown].caption || ''} className="max-h-[80vh] w-auto rounded-xl object-contain" />
            <p className="mt-3 text-center text-sm text-white/80">{screenshots[shown].caption} <span className="tabular-nums text-white/50">{shown + 1} / {screenshots.length}</span></p>
            <button type="button" autoFocus onClick={() => setShown(null)} aria-label={market("close")} className="absolute right-2 top-2 flex size-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"><X className="h-4 w-4" /></button>
            {shown > 0 && <button type="button" onClick={() => setShown(shown - 1)} aria-label={market("previous")} className="absolute left-2 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"><ChevronLeft className="h-5 w-5" /></button>}
            {shown < screenshots.length - 1 && <button type="button" onClick={() => setShown(shown + 1)} aria-label={market("next")} className="absolute right-2 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"><ChevronRight className="h-5 w-5" /></button>}
          </div>
        </div>
      )}

      {showInstallDialog && !app.installBlocked && (
        <InstallDialog app={app} domain={domain || ''} siteName={siteName} onInstall={handleInstall} onClose={() => setShowInstallDialog(false)} />
      )}
    </div>
  );
}

/**
 * Text from a manifest: blank lines make paragraphs, and a line that starts with "-", "*" or "•" stays its own line;
 * other line breaks are where its author wrapped the text, so they flow (they would break oddly on a phone).
 */
function Prose({ text, className = '' }: { text: string; className?: string }) {
  const paragraphs = text.trim().split(/\n\s*\n/).map((paragraph) => paragraph.split('\n').reduce<string[]>((lines, line) => {
    const trimmed = line.trim();
    if (/^[-*•]\s/.test(trimmed) || lines.length === 0) lines.push(trimmed);
    else lines[lines.length - 1] += ` ${trimmed}`;
    return lines;
  }, []));
  return (
    <div className={`space-y-3 text-[15px] leading-relaxed text-foreground/85 ${className}`}>
      {paragraphs.map((lines, i) => <p key={i}>{lines.map((line, j) => <span key={j} className="block">{line}</span>)}</p>)}
    </div>
  );
}

/** A screenshot, or a quiet frame where it does not load. */
function Shot({ url }: { url: string }) {
  return <MarketPicture src={url} className="absolute inset-0 h-full w-full object-cover object-top"
    fallback={<span className="absolute inset-0 flex items-center justify-center text-muted-foreground/50"><Camera className="h-7 w-7" /></span>} />;
}
