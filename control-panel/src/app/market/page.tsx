'use client';

import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useState, useEffect, useCallback, useMemo, type CSSProperties } from 'react';
import Link from 'next/link';
import { AlertCircle, Download, Loader2, Search, Store, X } from 'lucide-react';
import type { MarketApp, AppStatusInfo, MarketCategory, MarketCuration, MarketBundle } from '@/lib/market/types';
import { Button } from '@/components/ui/button';
import { AppCard, MarketIcon, categoryLookup, lucideByName } from '@/components/market/market-parts';

/**
 * The Market: finding and installing apps. What an installed app does on this server (its health, updates, access
 * and data) is on its page in Settings → Apps; the Market only says it is installed and opens it.
 *
 * Home: every app is shown at work (its first screenshot). The catalog's picks lead (the apps built for YouEye and
 * its collections, the first one large), then bundles, then one shelf per category; a category chip or a search
 * shows a full grid. Search and the category are in the address (?q=, ?category=), so they survive back and reload.
 */
export default function MarketPage() {
  const translateInterface = useInterfaceTranslations("interface");
  const market = useInterfaceTranslations("marketStore");

  const [apps, setApps] = useState<MarketApp[]>([]);
  const [categoryDefs, setCategoryDefs] = useState<MarketCategory[]>([]);
  const [curation, setCuration] = useState<MarketCuration | null>(null);
  const [bundles, setBundles] = useState<MarketBundle[]>([]);
  const [installingBundle, setInstallingBundle] = useState<string | null>(null);
  const [bundleMsg, setBundleMsg] = useState<string>('');
  const [statuses, setStatuses] = useState<Record<string, AppStatusInfo>>({});
  const [sourceCount, setSourceCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [catalogWarnings, setCatalogWarnings] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  // 'all', a category id, or 'added' (apps added by address).
  const [category, setCategory] = useState<string>('all');

  const fetchCatalog = useCallback(async () => {
    try {
      const res = await fetch('/api/market/catalog');
      if (!res.ok) throw new Error(translateInterface("m8888c9ac53d1"));
      const data = await res.json();
      setApps(data.apps || []);
      setCatalogWarnings(Array.isArray(data.warnings) ? data.warnings.map((warning: { message: string }) => warning.message) : []);
      setCategoryDefs(Array.isArray(data.categories) ? data.categories : []);
      setCuration(data.curation ?? null);
      setBundles(Array.isArray(data.bundles) ? data.bundles : []);
      setError(null);
    } catch (err) {
      console.error('[Market] catalog load failed', err);
      setError(translateInterface("m8888c9ac53d1"));
    }
  }, [translateInterface]);

  const fetchStatuses = useCallback(async () => {
    try {
      const res = await fetch('/api/market/status');
      if (!res.ok) return;
      const data = await res.json();
      const map: Record<string, AppStatusInfo> = {};
      for (const s of data.apps || []) map[s.appId] = s;
      setStatuses(map);
    } catch (err) {
      console.error('[Market] status load failed', err);
    }
  }, []);

  const fetchSourceCount = useCallback(async () => {
    try {
      const res = await fetch('/api/market/source');
      if (!res.ok) return;
      const data = await res.json();
      const list = data.sources?.length ? data.sources : data.source ? [data.source] : [];
      setSourceCount(list.filter((s: { enabled?: boolean }) => s.enabled !== false).length || list.length);
    } catch (err) {
      console.error('[Market] source count load failed', err);
    }
  }, []);

  // Install and wire a bundle: POST and read the progress stream, showing the latest message.
  const handleInstallBundle = useCallback(async (bundleId: string, sourceId?: string) => {
    setInstallingBundle(bundleId);
    setBundleMsg(translateInterface("m530bcc355f0a"));
    try {
      const query = sourceId ? `?source=${encodeURIComponent(sourceId)}` : '';
      const res = await fetch(`/api/market/bundles/${bundleId}/install${query}`, { method: 'POST' });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          const line = part.replace(/^data: /, '').trim();
          if (!line) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.message && evt.message !== 'done') setBundleMsg(evt.message);
            if (evt.status === 'error') setBundleMsg(evt.message || translateInterface("m33b4717bdc2f"));
          } catch {
            /* a partial frame */
          }
        }
      }
      setBundleMsg(translateInterface("m256c43047177"));
      await Promise.all([fetchStatuses(), fetchCatalog()]);
    } catch (err) {
      setBundleMsg(`${translateInterface("m33b4717bdc2f")}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTimeout(() => setInstallingBundle(null), 2500);
    }
  }, [fetchStatuses, fetchCatalog, translateInterface]);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchCatalog(), fetchStatuses(), fetchSourceCount()]).finally(() => setLoading(false));
    const interval = setInterval(fetchStatuses, 15_000);
    return () => clearInterval(interval);
  }, [fetchCatalog, fetchStatuses, fetchSourceCount]);

  // Search and category from the address (?q=, ?category=; ?tag= from older links is a search).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q') ?? params.get('tag');
    if (q) setSearch(q);
    const c = params.get('category');
    if (c) setCategory(c);
  }, []);
  useEffect(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set('q', search.trim());
    if (category !== 'all') params.set('category', category);
    const query = params.toString();
    const next = `${window.location.pathname}${query ? `?${query}` : ''}`;
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, '', next);
  }, [search, category]);

  const categories = useMemo(() => categoryLookup(categoryDefs), [categoryDefs]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
      </div>
    );
  }

  /* ── derived ── */

  const isInstalled = (app: MarketApp) => (statuses[app.id]?.status || 'not-installed') !== 'not-installed';

  // One entry per app: the official Market's comes first when another source lists the same id.
  const unique = (() => {
    const seen = new Set<string>();
    return [...apps]
      .sort((a, b) => Number(a.sourceId !== 'official') - Number(b.sourceId !== 'official'))
      .filter((app) => {
        const key = `${app.itemKind || 'app'}:${app.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  })();
  const byId = (ids?: string[]) => (ids ?? []).map((id) => unique.find((app) => app.id === id)).filter((app): app is MarketApp => !!app);

  const query = search.trim().toLowerCase();
  const matches = (app: MarketApp) => !query || [app.name, app.tagline, app.description, app.category && categories.label(app.category), app.developer, app.sourceName, ...(app.tags || [])]
    .filter(Boolean).join(' ').toLowerCase().includes(query);
  // Apps added by address, every one: an app added by URL whose id an official app also has is still listed here (the
  // one-per-id list above keeps the official copy).
  const added = apps.filter((app) => app.sourceId?.startsWith('direct:'));
  const usedCategories = Array.from(new Set(unique.map((app) => app.category || 'other')))
    .sort((a, b) => categories.order(a) - categories.order(b) || a.localeCompare(b));

  const browsing = !!query || category !== 'all';
  const listed = (category === 'added' ? added : unique)
    .filter(matches)
    .filter((app) => category === 'all' || category === 'added' || (app.category || 'other') === category)
    .sort((a, b) => a.name.localeCompare(b.name));

  // Curation (only decoration: without it the plain shelves show). The catalog's own picks lead the page: the apps
  // built for YouEye, then its collections. The first non-empty one is shown large. Nothing is "featured" unless the
  // catalog says so.
  const builtFor = curation?.spotlight?.apps?.length ? byId(curation.spotlight.apps) : unique.filter((app) => app.integration === 'native');
  const builtForTitle = curation?.spotlight?.title || translateInterface("m0fffd883a159");
  const picks = [
    ...(builtFor.length ? [{ id: 'built-for', label: builtForTitle, hint: market("builtForHint"), apps: builtFor }] : []),
    ...(curation?.collections ?? []).map((c) => ({ id: c.id, label: c.label, hint: undefined as string | undefined, apps: byId(c.apps) })),
  ].filter((pick) => pick.apps.length > 0);
  const bundleCards = bundles.map((b) => ({ ...b, memberApps: byId(b.members) })).filter((b) => b.memberApps.length > 0);
  const shelves = usedCategories
    .map((id) => ({ id, apps: unique.filter((app) => (app.category || 'other') === id).sort((a, b) => a.name.localeCompare(b.name)) }))
    .filter((shelf) => shelf.apps.length > 0);
  const card = (app: MarketApp, size?: 'large') => (
    <AppCard key={`${app.id}-${app.sourceId ?? ''}`} app={app} installed={isInstalled(app)} tile={categories.tile(app.category)} size={size} />
  );

  return (
    <div className="mx-auto max-w-[1120px] pb-20">
      <header className="flex flex-col gap-5 pb-8 md:flex-row md:items-end md:justify-between md:gap-10">
        <div className="min-w-0">
          <h1 className="text-[2.125rem] font-semibold leading-[1.1] tracking-[-0.02em] text-foreground md:text-[2.5rem]">{translateInterface("m5238d9bd03d5")}</h1>
          <p className="mt-2 max-w-[34rem] text-[15px] leading-relaxed text-muted-foreground">{market("subtitle")}</p>
        </div>
        <div className="market-search md:max-w-[22rem]">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={market("searchPlaceholder")} aria-label={translateInterface("ma10a36fa1098")} />
          {search && (
            <button type="button" onClick={() => setSearch('')} aria-label={market("clearSearch")}
              className="absolute right-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      {error && (
        <div role="alert" className="mb-8 flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}
      {catalogWarnings.length > 0 && (
        <details className="settings-details mb-6 text-[13px]">
          <summary><AlertCircle className="mr-1.5 h-3.5 w-3.5 text-amber-600" aria-hidden />{market("someMissing", { count: catalogWarnings.length })}</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-9 text-muted-foreground">
            {catalogWarnings.map((warning, index) => <li key={index}>{warning}</li>)}
          </ul>
        </details>
      )}

      <nav aria-label={market("categories")} className="market-chips mb-10">
        <button type="button" aria-pressed={category === 'all'} className="market-chip" onClick={() => setCategory('all')}>{translateInterface("ma52ace420f21")}</button>
        {usedCategories.map((id) => {
          const CategoryIcon = lucideByName(categories.icon(id));
          return (
            <button key={id} type="button" aria-pressed={category === id} className="market-chip" onClick={() => setCategory(id)}>
              <CategoryIcon className="h-3.5 w-3.5" aria-hidden />{categories.label(id)}
            </button>
          );
        })}
        {added.length > 0 && (
          <button type="button" aria-pressed={category === 'added'} className="market-chip" onClick={() => setCategory('added')}>
            {market("addedByAddress")} <span className="tabular-nums opacity-70">{added.length}</span>
          </button>
        )}
      </nav>

      {browsing ? (
        <section aria-labelledby="market-results" className="space-y-6">
          <h2 id="market-results" className="text-xl font-semibold tracking-tight">
            {query ? market("results", { query: search.trim() }) : category === 'added' ? market("addedByAddress") : categories.label(category)}
            <span className="ml-2 font-normal text-muted-foreground tabular-nums">{listed.length}</span>
          </h2>
          {listed.length === 0 ? (
            <div className="rounded-2xl border border-dashed py-16 text-center">
              <Store className="mx-auto mb-3 h-9 w-9 text-muted-foreground/50" aria-hidden />
              <p className="text-[15px] text-muted-foreground">{apps.length === 0 ? translateInterface("mc0d5412c5745") : query ? market("noResults", { query: search.trim() }) : translateInterface("mecb17af93f66")}</p>
              {apps.length > 0 && (
                <Button variant="outline" className="mt-5 rounded-full" onClick={() => { setSearch(''); setCategory('all'); }}>{market("showAll")}</Button>
              )}
            </div>
          ) : (
            <div className="market-results">{listed.map((app) => card(app))}</div>
          )}
        </section>
      ) : (
        <div className="space-y-14 md:space-y-16">
          {picks.map((pick, index) => (
            <section key={pick.id} aria-labelledby={`market-pick-${pick.id}`} className="space-y-5">
              <div>
                <h2 id={`market-pick-${pick.id}`} className={`${index === 0 ? 'text-2xl' : 'text-xl'} font-semibold tracking-tight`}>{pick.label}</h2>
                {pick.hint && <p className="mt-1 text-[14px] text-muted-foreground">{pick.hint}</p>}
              </div>
              <div className={`market-shelf${index === 0 ? ' market-shelf-large' : ''}`}
                style={index === 0 ? ({ '--market-cols': Math.min(3, pick.apps.length) } as CSSProperties) : undefined}>
                {pick.apps.map((app) => card(app, index === 0 ? 'large' : undefined))}
              </div>
            </section>
          ))}

          {bundleCards.length > 0 && (
            <section aria-labelledby="market-bundles" className="space-y-5">
              <div>
                <h2 id="market-bundles" className="text-xl font-semibold tracking-tight">{translateInterface("mff042b6ded4e")}</h2>
                <p className="mt-1 text-[14px] text-muted-foreground">{translateInterface("m303e7cf98fb4")}</p>
              </div>
              <ul className="settings-group">
                {bundleCards.map((b) => {
                  const busy = installingBundle === b.id;
                  return (
                    <li key={b.id} className="settings-item">
                      <span className="flex shrink-0 -space-x-2" aria-hidden>
                        {b.memberApps.map((app) => <span key={app.id} className="rounded-[10px] ring-2 ring-card"><MarketIcon app={app} size={40} tile={categories.tile(app.category)} /></span>)}
                      </span>
                      <span className="settings-item-text">
                        <span className="settings-item-label">{b.name}</span>
                        <span className="settings-item-hint">{busy && bundleMsg ? bundleMsg : (b.setupSummary || b.description)}</span>
                      </span>
                      <Button className="rounded-full" onClick={() => handleInstallBundle(b.id, b.sourceId)}
                        disabled={installingBundle !== null || b.sourceNotAccepted === true}
                        title={b.sourceNotAccepted ? translateInterface("m8ba391628be0") : undefined}>
                        {busy ? <Loader2 className="animate-spin" /> : <Download />}
                        {busy ? translateInterface("m530bcc355f0a") : translateInterface("me860b43c8a66")}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* One shelf per category. Small ones sit side by side (each as wide as its apps), packed into the grid. */}
          <div className="market-mosaic">
            {shelves.map((shelf) => (
              <section key={shelf.id} aria-labelledby={`market-shelf-${shelf.id}`} className="min-w-0 space-y-5"
                style={{ '--span-d': Math.min(4, shelf.apps.length), '--span-t': Math.min(3, shelf.apps.length) } as CSSProperties}>
                <div className="flex items-baseline justify-between gap-4">
                  <h2 id={`market-shelf-${shelf.id}`} className="text-xl font-semibold tracking-tight">
                    {categories.label(shelf.id)}<span className="ml-2 font-normal text-muted-foreground tabular-nums">{shelf.apps.length}</span>
                  </h2>
                  {shelf.apps.length > 4 && (
                    <button type="button" className="settings-link shrink-0" onClick={() => { setCategory(shelf.id); window.scrollTo({ top: 0 }); }}>{market("seeAll")}</button>
                  )}
                </div>
                <div className="market-shelf">{shelf.apps.slice(0, 8).map((app) => card(app))}</div>
              </section>
            ))}
          </div>
        </div>
      )}

      <p className="mt-16 text-center text-[13px] text-muted-foreground">
        {translateInterface("connectedMarkets", { count: sourceCount })}
        <Link href="/market/sources" className="font-medium text-primary hover:underline">{translateInterface("mb00d1920b294")}</Link>
      </p>
    </div>
  );
}
