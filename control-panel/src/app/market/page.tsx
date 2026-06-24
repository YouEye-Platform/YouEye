'use client';

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
  Search,
  Sparkles,
  Store,
} from 'lucide-react';
import type { MarketApp, AppStatusInfo, MarketCategory } from '@/lib/market/types';

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

function StatusDot({ status }: { status?: string }) {
  const ok = !!status && status !== 'not-installed';
  return <span className={`inline-block size-2 shrink-0 rounded-full ${ok ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />;
}

function variantHref(app: MarketApp): string {
  return app.sourceId ? `/market/${app.id}?source=${encodeURIComponent(app.sourceId)}` : `/market/${app.id}`;
}

type Section = 'apps' | 'installed' | 'updates' | 'integrations';

/* ─────────────────────────── page ─────────────────────────── */

export default function MarketPage() {
  const [apps, setApps] = useState<MarketApp[]>([]);
  const [categoryDefs, setCategoryDefs] = useState<MarketCategory[]>([]);
  const [statuses, setStatuses] = useState<Record<string, AppStatusInfo>>({});
  const [sourceCount, setSourceCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [section, setSection] = useState<Section>('apps');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  const fetchCatalog = useCallback(async () => {
    try {
      const res = await fetch('/api/market/catalog');
      if (!res.ok) throw new Error('Failed to load the Market catalog');
      const data = await res.json();
      setApps(data.apps || []);
      setCategoryDefs(Array.isArray(data.categories) ? data.categories : []);
      if (Array.isArray(data.sources)) {
        setSourceCount(data.sources.filter((s: { enabled?: boolean }) => s.enabled !== false).length || data.sources.length);
      }
      setError(null);
    } catch (err) {
      console.error('[Market] catalog load failed', err);
      setError(err instanceof Error ? err.message : 'Failed to load the Market catalog');
    }
  }, []);

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

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchCatalog(), fetchStatuses(), fetchSourceCount()]).finally(() => setLoading(false));
    const interval = setInterval(fetchStatuses, 10_000);
    return () => clearInterval(interval);
  }, [fetchCatalog, fetchStatuses, fetchSourceCount]);

  /* ── derived ── */

  const statusOf = (app: MarketApp) => statuses[app.id]?.status || 'not-installed';
  const isInstalled = (app: MarketApp) => statusOf(app) !== 'not-installed';
  const hasUpdate = (app: MarketApp) => !!statuses[app.id]?.updateAvailable;
  const kindOf = (app: MarketApp) => (app.itemKind === 'integration' ? 'integration' : 'app');

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
  const realApps = visible.filter((a) => kindOf(a) === 'app');
  const integrations = visible.filter((a) => kindOf(a) === 'integration');

  const counts = {
    apps: realApps.length,
    installed: realApps.filter(isInstalled).length,
    updates: realApps.filter(hasUpdate).length,
    integrations: integrations.length,
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

  // Native apps highlighted in the "Built for <server>" row.
  const nativeApps = realApps.filter((a) => a.integration === 'native');
  const featured = nativeApps.find((a) => !isInstalled(a)) || nativeApps[0] || realApps[0];

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

  const sectionApps = (() => {
    if (section === 'installed') return dedupe(realApps.filter(isInstalled));
    if (section === 'updates') return dedupe(realApps.filter(hasUpdate));
    if (section === 'integrations') return dedupe(integrations);
    return dedupe(realApps);
  })();

  const filteredSectionApps = categoryFilter === 'all'
    ? sectionApps
    : sectionApps.filter((a) => (a.category || 'other') === categoryFilter);

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
          <h1 className="text-[26px] font-bold tracking-tight">Market</h1>
          <p className="mt-1 text-sm text-muted-foreground">Apps for your server. Install with one click — everything runs at home.</p>
        </div>
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search apps"
            aria-label="Search apps"
            className="h-10 w-full rounded-full border bg-background pl-9 pr-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </section>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {/* Pill bar */}
      <nav className="flex flex-wrap items-center gap-2">
        <button type="button" className={pill(section === 'apps')} onClick={() => setSection('apps')}>
          <Grid3x3 className="h-3.5 w-3.5" /> All apps
        </button>
        <button type="button" className={pill(section === 'installed')} onClick={() => setSection('installed')}>
          <Check className="h-3.5 w-3.5" /> Installed
          {counts.installed > 0 && <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[11px]">{counts.installed}</span>}
        </button>
        <button type="button" className={pill(section === 'updates')} onClick={() => setSection('updates')}>
          <Download className="h-3.5 w-3.5" /> Updates
          {counts.updates > 0 && <span className="ml-0.5 rounded-full bg-primary/15 px-1.5 text-[11px] text-primary">{counts.updates}</span>}
        </button>
        <button type="button" className={pill(section === 'integrations')} onClick={() => setSection('integrations')}>
          <Sparkles className="h-3.5 w-3.5" /> Integrations
        </button>

        {usedCategories.length > 0 && <span className="mx-1 h-5 w-px bg-border" />}
        <button type="button" className={pill(categoryFilter === 'all')} onClick={() => setCategoryFilter('all')}>
          All
        </button>
        {usedCategories.map((cat) => {
          const CatIcon = lucideByName(catIconName(cat));
          return (
            <button key={cat} type="button" className={pill(categoryFilter === cat)} onClick={() => setCategoryFilter(cat)}>
              <CatIcon className="h-3.5 w-3.5" /> {catLabel(cat)}
            </button>
          );
        })}

        <Link href="/market/sources" className={`${pill(false)} ml-auto`}>
          <Store className="h-3.5 w-3.5" /> Sources
          {sourceCount > 0 && <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[11px]">{sourceCount}</span>}
        </Link>
      </nav>

      {/* Built for your server — native big-tiles (only on All apps, unfiltered) */}
      {section === 'apps' && categoryFilter === 'all' && nativeApps.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-[17px] font-bold tracking-tight">Built for your server</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {dedupe(nativeApps).map((app) => (
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

      {/* Featured banner */}
      {section === 'apps' && categoryFilter === 'all' && featured && (
        <section className="grid overflow-hidden rounded-2xl border md:grid-cols-2">
          <div className="flex flex-col justify-center gap-2.5 p-8">
            <div className="text-[12px] font-semibold uppercase tracking-wider text-primary">Featured</div>
            <h3 className="text-[22px] font-bold tracking-tight">{featured.name}</h3>
            <p className="text-sm text-muted-foreground">{featured.description}</p>
            <div className="pt-1">
              <Link
                href={variantHref(featured)}
                className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                {isInstalled(featured) ? `Open ${featured.name}` : `Install ${featured.name}`}
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
          <p className="text-sm">{apps.length === 0 ? 'No apps in the catalog yet.' : 'Nothing matches your search or filters.'}</p>
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
                      {app.integration === 'native' && (
                        <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">Native</span>
                      )}
                    </div>
                    <div className="truncate text-[12.5px] text-muted-foreground">{app.description || app.sourceName || '—'}</div>
                  </div>
                  {hasUpdate(app) ? (
                    <span className="text-[11px] font-medium text-primary">Update</span>
                  ) : (
                    <StatusDot status={statusOf(app)} />
                  )}
                </Link>
              ))}
            </div>
          </section>
        ))
      )}

      <div className="text-center text-[12.5px] text-muted-foreground">
        {sourceCount} {sourceCount === 1 ? 'market' : 'markets'} connected · <Link href="/market/sources" className="text-primary hover:underline">Manage sources</Link>
      </div>
    </div>
  );
}
