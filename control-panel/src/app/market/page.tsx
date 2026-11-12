'use client';





import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import * as LucideIcons from 'lucide-react';
import {
  AlertCircle,
  Check,
  Download,
  Grid3x3,
  type LucideIcon,
  Loader2,
  Package,
  Plus,
  Search,
  Store,
} from 'lucide-react';
import type { MarketApp, AppStatusInfo, MarketCategory, MarketCuration, MarketBundle } from '@/lib/market/types';
import { Input } from '@/components/ui/input';

/* ─────────────────────────── helpers ─────────────────────────── */

// Category labels, icons, ordering, and tile colours are data-driven — they come from the
// `categories:` section of the Market catalog (see fetchCategories / catIndex below), NOT
// from a hardcoded map. Adding/renaming a category is a catalog.yaml change only.
const DEFAULT_TILE = { bg: '#f4f4f5', fg: '#52525b' };

function prettify(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1).replace(/[-_]/g, ' ');
}

function lucideByName(name?: string): LucideIcon {
  if (!name) return Package;
  const map = LucideIcons as unknown as Record<string, LucideIcon>;
  const pascal = name.charAt(0).toUpperCase() + name.slice(1);
  return map[name] || map[pascal] || Package;
}

function MarketIcon({ app, size = 44, tile }: { app: MarketApp; size?: number; tile?: { bg: string; fg: string } }) {
  if (app.iconUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={app.iconUrl}
        alt=""
        className="shrink-0 rounded-[14px] object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  const { bg, fg } = tile || DEFAULT_TILE;
  const Icon = lucideByName(app.icon);
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-[14px]"
      style={{ width: size, height: size, background: bg, color: fg }}
    >
      <Icon style={{ width: Math.round(size * 0.46), height: Math.round(size * 0.46) }} />
    </div>
  );
}

// Health-at-a-glance dot. Not-installed → muted. Installed → coloured by health:
// green healthy, red unhealthy, amber unknown (so a broken app stands out on its card).
function StatusDot({ status, health }: { status?: string; health?: string }) {
  const translateInterface = useInterfaceTranslations("interface");

  const installed = !!status && status !== 'not-installed';
  if (!installed) return <span className="inline-block size-2 shrink-0 rounded-full bg-muted-foreground/30" />;
  const color = health === 'unhealthy' ? 'bg-red-500' : health === 'unknown' ? 'bg-amber-500' : 'bg-green-500';
  const title = health === 'unhealthy' ? translateInterface("m317b1fbc1e13") : health === 'unknown' ? translateInterface("m6a5465ac1dd5") : translateInterface("m7f1e323b6272");
  return <span title={title} className={`inline-block size-2 shrink-0 rounded-full ${color}`} />;
}

function variantHref(app: MarketApp): string {
  return app.sourceId ? `/market/${app.id}?source=${encodeURIComponent(app.sourceId)}` : `/market/${app.id}`;
}

type Section = 'apps' | 'installed' | 'updates' | 'added';

/* ─────────────────────────── page ─────────────────────────── */

export default function MarketPage() {
  const translateInterface = useInterfaceTranslations("interface");

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
  const [section, setSection] = useState<Section>('apps');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  // Tag filter — set by clicking a tag on an app detail page (?tag=...). Read on mount from
  // the URL (window-based, so no Suspense boundary is needed for this client component).
  const [tagFilter, setTagFilter] = useState<string | null>(null);

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
      if (Array.isArray(data.sources)) {
        setSourceCount(data.sources.filter((s: { enabled?: boolean }) => s.enabled !== false).length || data.sources.length);
      }
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

  // Install + wire a bundle: POST and stream the SSE progress, showing the latest message.
  const handleInstallBundle = useCallback(async (bundleId: string) => {
    setInstallingBundle(bundleId);
    setBundleMsg('Starting…');
    try {
      const res = await fetch(`/api/market/bundles/${bundleId}/install`, { method: 'POST' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
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
            /* ignore partial frame */
          }
        }
      }
      setBundleMsg(translateInterface("m256c43047177"));
      await Promise.all([fetchStatuses(), fetchCatalog()]);
    } catch (err) {
      setBundleMsg(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTimeout(() => setInstallingBundle(null), 2500);
    }
  }, [fetchStatuses, fetchCatalog, translateInterface]);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchCatalog(), fetchStatuses(), fetchSourceCount()]).finally(() => setLoading(false));
    const interval = setInterval(fetchStatuses, 10_000);
    return () => clearInterval(interval);
  }, [fetchCatalog, fetchStatuses, fetchSourceCount]);

  // Seed the tag filter from ?tag= (set when arriving via a tag click on a detail page).
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tag');
    if (t) setTagFilter(t);
  }, []);

  /* ── derived ── */

  const statusOf = (app: MarketApp) => statuses[app.id]?.status || 'not-installed';
  const healthOf = (app: MarketApp) => statuses[app.id]?.healthStatus;
  const isInstalled = (app: MarketApp) => statusOf(app) !== 'not-installed';
  const hasUpdate = (app: MarketApp) => !!statuses[app.id]?.updateAvailable;

  const matchesSearch = (app: MarketApp) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [app.name, app.description, app.category, app.sourceName, ...(app.tags || [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(q);
  };

  const visible = apps.filter(matchesSearch);
  const realApps = visible;

  const counts = {
    apps: realApps.length,
    installed: realApps.filter(isInstalled).length,
    updates: realApps.filter(hasUpdate).length,
    added: realApps.filter((app) => app.sourceId?.startsWith('direct:')).length,
  };

  // Category metadata index — data-driven labels/icons/tiles/order from the catalog.
  const catIndex = useMemo(() => new Map(categoryDefs.map((c) => [c.id, c])), [categoryDefs]);
  const catLabel = (id?: string) => catIndex.get(id || 'other')?.label ?? prettify(id || 'other');
  const catTile = (id?: string) => catIndex.get(id || 'other')?.tile ?? DEFAULT_TILE;
  const catIconName = (id?: string) => catIndex.get(id || 'other')?.icon;
  const catOrder = (id?: string) => catIndex.get(id || 'other')?.order ?? Number.MAX_SAFE_INTEGER;

  // Categories actually used by apps, ordered by the catalog's `order` (label/icon from data).
  const usedCategories = Array.from(new Set(realApps.map((a) => a.category).filter(Boolean) as string[]))
    .sort((a, b) => catOrder(a) - catOrder(b) || a.localeCompare(b));

  // Dedupe by catalog identity so the same app from multiple sources collapses.
  const dedupe = (list: MarketApp[]) => {
    const seen = new Set<string>();
    return list.filter((a) => {
      const key = `${a.itemKind || 'app'}:${a.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  // Resolve an ordered list of app ids → apps (existing real apps only, deduped, order kept).
  const resolveIds = (ids?: string[]) => {
    const out: MarketApp[] = [];
    for (const id of ids ?? []) {
      const app = realApps.find((a) => a.id === id);
      if (app && !out.some((o) => o.id === app.id)) out.push(app);
    }
    return out;
  };

  // Native apps — fallback for the spotlight when the catalog declares no curation.
  const nativeApps = realApps.filter((a) => a.integration === 'native');

  // Spotlight ("Built for <server>" strip) + collections come from catalog curation (data),
  // with a graceful fallback to native apps when no curation is declared.
  const spotlightApps = curation?.spotlight?.apps?.length
    ? resolveIds(curation.spotlight.apps)
    : dedupe(nativeApps);
  const spotlightTitle = curation?.spotlight?.title || translateInterface("m0fffd883a159");
  const collectionStrips = (curation?.collections ?? [])
    .map((c) => ({ id: c.id, label: c.label, apps: resolveIds(c.apps) }))
    .filter((c) => c.apps.length > 0);

  // Bundles — curated install-and-wire recipes. Cards resolve their member ids to the
  // already-loaded apps for icons/names. Members still appear in the normal category browse.
  const bundleCards = bundles
    .map((b) => ({ ...b, memberApps: resolveIds(b.members) }))
    .filter((b) => b.memberApps.length > 0);

  const featured = spotlightApps.find((a) => !isInstalled(a)) || spotlightApps[0] || realApps[0];

  // App ids surfaced in a curated strip — excluded from the generic category browse below
  // (on the unfiltered All-apps view, where the strips are visible) so they aren't shown twice.
  const curatedIds = new Set<string>([
    ...spotlightApps.map((a) => a.id),
    ...collectionStrips.flatMap((c) => c.apps.map((a) => a.id)),
  ]);

  const sectionApps = (() => {
    if (section === 'installed') return dedupe(realApps.filter(isInstalled));
    if (section === 'updates') return dedupe(realApps.filter(hasUpdate));
    if (section === 'added') return dedupe(realApps.filter((app) => app.sourceId?.startsWith('direct:')));
    return dedupe(realApps);
  })();

  const showingStrips = section === 'apps' && categoryFilter === 'all' && !tagFilter;
  const filteredSectionApps = (categoryFilter === 'all'
    ? sectionApps
    : sectionApps.filter((a) => (a.category || 'other') === categoryFilter)
  )
    .filter((a) => !tagFilter || a.tags?.some((t) => t.toLowerCase() === tagFilter.toLowerCase()))
    .filter((a) => !(showingStrips && curatedIds.has(a.id)));

  // Group the browse list by category.
  const byCategory: Record<string, MarketApp[]> = {};
  for (const a of filteredSectionApps) {
    const cat = a.category || 'other';
    (byCategory[cat] ||= []).push(a);
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-7 w-7 animate-spin text-primary" />
      </div>
    );
  }

  const pill = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors ${
      active ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground hover:bg-accent'
    }`;

  return (
    <div className="mx-auto max-w-[1040px] space-y-6 px-1 pb-16">
      {/* Hero */}
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-gradient-to-br from-primary/[0.06] to-transparent p-8">
        <div>
          <h1 className="text-[26px] font-bold tracking-tight">{translateInterface("m5238d9bd03d5")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{translateInterface("m0ee0f0fef9c7")}</p>
        </div>
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={translateInterface("ma10a36fa1098")}
            aria-label={translateInterface("ma10a36fa1098")}
            className="h-10 rounded-full pl-9 pr-4"
          />
        </div>
      </section>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {catalogWarnings.length > 0 && (
        <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
          <p>{translateInterface("m190601e77afe")}</p>
          <ul className="mt-2 list-disc pl-5">
            {catalogWarnings.map((warning, index) => <li key={index}>{warning}</li>)}
          </ul>
        </div>
      )}

      {/* Pill bar */}
      <nav className="flex flex-wrap items-center gap-2">
        <button type="button" className={pill(section === 'apps')} onClick={() => setSection('apps')}>
          <Grid3x3 className="h-3.5 w-3.5" /> {" "}{translateInterface("m01bed311e7d0")}</button>
        <button type="button" className={pill(section === 'installed')} onClick={() => setSection('installed')}>
          <Check className="h-3.5 w-3.5" /> {" "}{translateInterface("mf8b32f4e92bd")}{counts.installed > 0 && <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[11px]">{counts.installed}</span>}
        </button>
        <button type="button" className={pill(section === 'updates')} onClick={() => setSection('updates')}>
          <Download className="h-3.5 w-3.5" /> {" "}{translateInterface("m22e2bada8f1c")}{counts.updates > 0 && <span className="ml-0.5 rounded-full bg-primary/15 px-1.5 text-[11px] text-primary">{counts.updates}</span>}
        </button>
        <button type="button" className={pill(section === 'added')} onClick={() => setSection('added')}>
          <Plus className="h-3.5 w-3.5" /> {translateInterface("m6b02e0d363a4")}{counts.added > 0 && <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[11px]">{counts.added}</span>}
        </button>

        {usedCategories.length > 0 && <span className="mx-1 h-5 w-px bg-border" />}
        <button type="button" className={pill(categoryFilter === 'all')} onClick={() => setCategoryFilter('all')}>
          {translateInterface("ma52ace420f21")}</button>
        {usedCategories.map((cat) => {
          const CatIcon = lucideByName(catIconName(cat));
          return (
            <button key={cat} type="button" className={pill(categoryFilter === cat)} onClick={() => setCategoryFilter(cat)}>
              <CatIcon className="h-3.5 w-3.5" /> {catLabel(cat)}
            </button>
          );
        })}
        {tagFilter && (
          <button
            type="button"
            onClick={() => setTagFilter(null)}
            title={translateInterface("m58f0f5967b9e")}
            className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-[13px] font-medium text-primary"
          >
            #{tagFilter} <span className="text-[15px] leading-none">×</span>
          </button>
        )}

        <Link href="/market/sources" className={`${pill(false)} ml-auto`}>
          <Store className="h-3.5 w-3.5" /> {translateInterface("mcaf85b0888d7")}{sourceCount > 0 && <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[11px]">{sourceCount}</span>}
        </Link>
      </nav>

      {/* Spotlight — "Built for <server>" big-tiles (data-driven curation; All apps, unfiltered) */}
      {showingStrips && spotlightApps.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-[17px] font-bold tracking-tight">{spotlightTitle}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {spotlightApps.map((app) => (
              <Link
                key={app.id}
                href={variantHref(app)}
                className="flex flex-col items-center gap-2 rounded-[14px] p-4 text-center transition-all hover:-translate-y-0.5 hover:shadow-md"
              >
                <MarketIcon app={app} size={56} tile={catTile(app.category)} />
                <span className="text-[13.5px] font-semibold">{app.name}</span>
                <span className="text-[11.5px] text-muted-foreground">{catLabel(app.category)}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Bundles — curated install-and-wire recipes (data-driven; All apps, unfiltered) */}
      {showingStrips && bundleCards.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[17px] font-bold tracking-tight">{translateInterface("mff042b6ded4e")}</h2>
            <span className="text-[12.5px] text-muted-foreground">{translateInterface("m303e7cf98fb4")}</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {bundleCards.map((b) => {
              const BIcon = lucideByName(b.icon || 'package');
              return (
                <div key={b.id} className="flex flex-col gap-3 rounded-2xl border bg-card p-5">
                  <div className="flex items-center gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-primary/10 text-primary">
                      <BIcon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[15px] font-bold">{b.name}</div>
                      <div className="text-[12.5px] text-muted-foreground">{b.setupSummary || b.description}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {b.memberApps.map((app) => (
                      <span
                        key={`${b.id}-${app.id}`}
                        className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-[12px]"
                      >
                        <MarketIcon app={app} size={18} tile={catTile(app.category)} />
                        {app.name}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-3 pt-1">
                    <button
                      type="button"
                      onClick={() => handleInstallBundle(b.id)}
                      disabled={installingBundle !== null}
                      className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-1.5 text-[13px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                    >
                      {installingBundle === b.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                      {installingBundle === b.id ? translateInterface("m530bcc355f0a") : translateInterface("me860b43c8a66")}
                    </button>
                    {installingBundle === b.id && bundleMsg && (
                      <span className="truncate text-[12px] text-muted-foreground">{bundleMsg}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Curated collections (data-driven; All apps, unfiltered) */}
      {showingStrips && collectionStrips.map((coll) => (
        <section key={coll.id} className="space-y-2">
          <h2 className="text-[17px] font-bold tracking-tight">{coll.label}</h2>
          <div className="grid gap-x-6 gap-y-1 rounded-xl border bg-card p-2 md:grid-cols-2 lg:grid-cols-3">
            {coll.apps.map((app) => (
              <Link
                key={`${coll.id}-${app.id}`}
                href={variantHref(app)}
                className="flex items-center gap-3 rounded-xl px-2.5 py-2.5 transition-colors hover:bg-accent"
              >
                <MarketIcon app={app} size={44} tile={catTile(app.category)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{app.name}</div>
                  <div className="truncate text-[12.5px] text-muted-foreground">{app.description || app.sourceName || '—'}</div>
                </div>
                {hasUpdate(app) ? (
                  <span className="text-[11px] font-medium text-primary">{translateInterface("mc1c1009d3f37")}</span>
                ) : (
                  <StatusDot status={statusOf(app)} health={healthOf(app)} />
                )}
              </Link>
            ))}
          </div>
        </section>
      ))}

      {/* Featured banner */}
      {section === 'apps' && categoryFilter === 'all' && featured && (
        <section className="grid overflow-hidden rounded-2xl border md:grid-cols-2">
          <div className="flex flex-col justify-center gap-2.5 p-8">
            <div className="text-[12px] font-semibold uppercase tracking-wider text-primary">{translateInterface("mc533cafab69e")}</div>
            <h3 className="text-[22px] font-bold tracking-tight">{featured.name}</h3>
            <p className="text-sm text-muted-foreground">{featured.description}</p>
            <div className="pt-1">
              <Link
                href={variantHref(featured)}
                className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                {isInstalled(featured) ? translateInterface("m3dfbdb809ebf", { value0: String(featured.name) }) : translateInterface("mfa4031f94844", { value0: String(featured.name) })}
              </Link>
            </div>
          </div>
          <div className="hidden items-center justify-center bg-gradient-to-br from-slate-900 to-slate-700 p-8 md:flex">
            <MarketIcon app={featured} size={96} tile={catTile(featured.category)} />
          </div>
        </section>
      )}

      {/* Category sections (compact rows) */}
      {Object.keys(byCategory).length === 0 ? (
        <div className="rounded-xl border bg-card py-16 text-center text-muted-foreground">
          <Store className="mx-auto mb-3 h-10 w-10 opacity-40" />
          <p className="text-sm">{apps.length === 0 ? translateInterface("mc0d5412c5745") : translateInterface("mecb17af93f66")}</p>
        </div>
      ) : (
        Object.entries(byCategory)
          .sort((a, b) => catOrder(a[0]) - catOrder(b[0]) || a[0].localeCompare(b[0]))
          .map(([cat, list]) => (
          <section key={cat} className="space-y-2">
            <h2 className="text-[17px] font-bold tracking-tight">{catLabel(cat)}</h2>
            <div className="grid gap-x-6 gap-y-1 rounded-xl border bg-card p-2 md:grid-cols-2 lg:grid-cols-3">
              {list.map((app) => (
                <Link
                  key={`${app.id}-${app.sourceId ?? ''}`}
                  href={variantHref(app)}
                  className="flex items-center gap-3 rounded-xl px-2.5 py-2.5 transition-colors hover:bg-accent"
                >
                  <MarketIcon app={app} size={44} tile={catTile(app.category)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <span className="truncate">{app.name}</span>
                    </div>
                    <div className="truncate text-[12.5px] text-muted-foreground">{app.description || app.sourceName || '—'}</div>
                  </div>
                  {hasUpdate(app) ? (
                    <span className="text-[11px] font-medium text-primary">{translateInterface("mc1c1009d3f37")}</span>
                  ) : (
                    <StatusDot status={statusOf(app)} health={healthOf(app)} />
                  )}
                </Link>
              ))}
            </div>
          </section>
        ))
      )}

      <div className="text-center text-[12.5px] text-muted-foreground">
        {translateInterface("connectedMarkets", {count: sourceCount})}<Link href="/market/sources" className="text-primary hover:underline">{translateInterface("mb00d1920b294")}</Link>
      </div>
    </div>
  );
}
