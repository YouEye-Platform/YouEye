'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Loader2, Store, AlertCircle, RefreshCw, Shield, Globe, Save, Plus, Trash2, Plug, Search, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppCard } from '@/components/market/app-card';
import { UninstallDialog } from '@/components/market/uninstall-dialog';
import { OrphanSection } from '@/components/market/orphan-section';
import { InstallFromUrlDialog } from '@/components/market/install-from-url-dialog';
import { authenticatedFetch } from '@/lib/api-client';
import { useTranslations } from 'next-intl';
import type { MarketApp, InstallEvent, AppStatusInfo } from '@/lib/market/types';

// Categories for grouping
const CATEGORIES: Record<string, string> = {
  productivity: 'Productivity',
  media: 'Media',
  search: 'Search',
  social: 'Social',
  utilities: 'Utilities',
};

interface MarketSourceConfig {
  id: string;
  name: string;
  repo_url: string;
  enabled: boolean;
  priority: number;
  trust: 'official' | 'community' | 'custom';
}

interface MarketAppGroup {
  key: string;
  primary: MarketApp;
  variants: MarketApp[];
}

function groupByCatalogIdentity(apps: MarketApp[]): MarketAppGroup[] {
  const groups = new Map<string, MarketApp[]>();
  for (const app of apps) {
    const key = `${app.itemKind || 'app'}:${app.id}`;
    groups.set(key, [...(groups.get(key) ?? []), app]);
  }
  return Array.from(groups.entries()).map(([key, variants]) => ({
    key,
    primary: variants[0],
    variants,
  }));
}

function groupByCategory(groups: MarketAppGroup[]): Record<string, MarketAppGroup[]> {
  const byCategory: Record<string, MarketAppGroup[]> = {};
  for (const group of groups) {
    const cat = group.primary.category || 'other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(group);
  }
  return byCategory;
}

function emptySource(index: number): MarketSourceConfig {
  return {
    id: `custom-${Date.now()}`,
    name: `Market ${index + 1}`,
    repo_url: '',
    enabled: true,
    priority: index,
    trust: 'custom',
  };
}

function variantHref(app: MarketApp): string {
  return app.sourceId
    ? `/market/${app.id}?source=${encodeURIComponent(app.sourceId)}`
    : `/market/${app.id}`;
}

function MarketAppGroupCard({
  group,
  status,
  installProgress,
}: {
  group: MarketAppGroup;
  status?: AppStatusInfo;
  installProgress?: { events: InstallEvent[]; done: boolean };
}) {
  const { primary, variants } = group;

  return (
    <div className="space-y-2">
      <AppCard app={primary} status={status} installProgress={installProgress} />
      {variants.length > 1 && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">
            Sources
          </div>
          <div className="flex flex-wrap gap-1.5">
            {variants.map((variant) => (
              <Link
                key={variant.catalogKey || `${variant.sourceId}-${variant.id}`}
                href={variantHref(variant)}
                className={`rounded-full border px-2 py-0.5 text-xs ${
                  variant.catalogKey === primary.catalogKey
                    ? 'border-blue-200 bg-blue-50 text-blue-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                }`}
              >
                {variant.sourceName || variant.sourceId || 'Market'}
                {variant.version ? ` v${variant.version}` : ''}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function MarketPage() {
  const [apps, setApps] = useState<MarketApp[]>([]);
  const [statuses, setStatuses] = useState<Record<string, AppStatusInfo>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [marketSources, setMarketSources] = useState<MarketSourceConfig[]>([]);
  const [savingMarketRepo, setSavingMarketRepo] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');

  // Install progress (polled from install-status endpoint)
  const [installProgresses, setInstallProgresses] = useState<Record<string, { events: InstallEvent[]; done: boolean }>>({});

  // Uninstall state
  const [uninstallApp, setUninstallApp] = useState<MarketApp | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);

  // Install from URL state
  const [showUrlDialog, setShowUrlDialog] = useState(false);

  const t = useTranslations('market');
  const tc = useTranslations('common');

  const fetchCatalog = useCallback(async () => {
    try {
      const res = await fetch('/api/market/catalog');
      if (!res.ok) throw new Error('Failed to fetch app catalog');
      const data = await res.json();
      setApps(data.apps);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load catalog');
    }
  }, []);

  const fetchMarketSource = useCallback(async () => {
    try {
      const res = await authenticatedFetch('/api/market/source');
      if (!res.ok) throw new Error('Failed to load Market source');
      const data = await res.json();
      setMarketSources(data.sources?.length ? data.sources : [{
        id: data.source?.id || 'official',
        name: data.source?.name || 'Official YouEye Market',
        repo_url: data.source?.repo_url || '',
        enabled: data.source?.enabled ?? true,
        priority: data.source?.priority ?? 0,
        trust: data.source?.trust || 'official',
      }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Market source');
    }
  }, []);

  const fetchStatuses = useCallback(async () => {
    try {
      const res = await fetch('/api/market/status');
      if (!res.ok) throw new Error('Failed to fetch app statuses');
      const data = await res.json();
      const map: Record<string, AppStatusInfo> = {};
      for (const s of data.apps) {
        map[s.appId] = s;
      }
      setStatuses(map);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, []);

  const fetchDomain = useCallback(async () => {
    try {
      const res = await fetch('/api/domain');
      if (res.ok) {
        const data = await res.json();
        // domain is available but not needed on this page anymore
      }
    } catch {
      // Will use fallback
    }
  }, []);

  useEffect(() => {
    Promise.all([
      fetchMarketSource(),
      fetchCatalog(),
      fetchStatuses(),
      fetchDomain(),
    ]).finally(() => setLoading(false));

    const interval = setInterval(() => {
      fetchStatuses();
    }, 10_000);
    return () => clearInterval(interval);
  }, [fetchMarketSource, fetchCatalog, fetchStatuses, fetchDomain]);

  const updateMarketSource = (index: number, patch: Partial<MarketSourceConfig>) => {
    setMarketSources((current) => current.map((source, i) => (
      i === index ? { ...source, ...patch } : source
    )));
  };

  const addMarketSource = () => {
    setMarketSources((current) => [...current, emptySource(current.length)]);
  };

  const removeMarketSource = (index: number) => {
    setMarketSources((current) => current.filter((_, i) => i !== index));
  };

  const saveMarketSources = async () => {
    setSavingMarketRepo(true);
    try {
      const normalizedSources = marketSources
        .map((source, index) => ({
          ...source,
          id: source.id.trim() || `source-${index + 1}`,
          name: source.name.trim() || `Market ${index + 1}`,
          repo_url: source.repo_url.trim(),
          priority: Number.isFinite(Number(source.priority)) ? Number(source.priority) : index,
        }))
        .filter((source) => source.repo_url);

      const res = await authenticatedFetch('/api/market/source', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active_sources: normalizedSources }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save Market source');
      }
      const data = await res.json();
      setMarketSources(data.sources?.length ? data.sources : normalizedSources);
      await fetchCatalog();
      await fetchStatuses();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save Market source');
    } finally {
      setSavingMarketRepo(false);
    }
  };

  // Poll install status for progress on cards
  useEffect(() => {
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/market/install-status');
        if (res.ok) {
          const data = await res.json();
          const progresses: Record<string, { events: InstallEvent[]; done: boolean }> = {};
          for (const install of data.installs) {
            progresses[install.appId] = { events: install.events, done: install.done };
          }
          setInstallProgresses(progresses);
        }
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(pollInterval);
  }, []);

  // ── Uninstall ──────────────────────────────────────────────

  const handleUninstallRequest = (appId: string) => {
    const app = apps.find((a) => a.id === appId);
    if (app) setUninstallApp(app);
  };

  const handleUninstall = async (appId: string, keepData: boolean) => {
    setUninstallApp(null);
    setUninstalling(appId);
    try {
      await authenticatedFetch('/api/market/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, keepData }),
      });
      await fetchStatuses();
    } catch (err) {
      alert(`Uninstall failed: ${err}`);
    } finally {
      setUninstalling(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  const sourceOptions = Array.from(new Map(
    apps
      .filter((app) => app.sourceId || app.sourceName)
      .map((app) => [app.sourceId || app.sourceName || 'market', app.sourceName || app.sourceId || 'Market'])
  ).entries()).sort((a, b) => a[1].localeCompare(b[1]));
  const categoryOptions = Array.from(new Set(apps.map((app) => app.category).filter(Boolean))).sort();
  const hasActiveFilters = !!searchQuery
    || sourceFilter !== 'all'
    || typeFilter !== 'all'
    || statusFilter !== 'all'
    || categoryFilter !== 'all';

  const filteredApps = apps.filter((app) => {
    const status = statuses[app.id]?.status || 'not-installed';
    const itemKind = app.itemKind || 'app';
    const itemType = itemKind === 'integration'
      ? 'integration'
      : app.integration === 'native'
        ? 'native'
        : 'external';

    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLowerCase();
      const haystack = [
        app.name,
        app.description,
        app.category,
        app.sourceName,
        app.sourceId,
        itemType,
        ...(app.tags || []),
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(query)) return false;
    }

    if (sourceFilter !== 'all' && app.sourceId !== sourceFilter && app.sourceName !== sourceFilter) return false;
    if (typeFilter !== 'all' && itemType !== typeFilter) return false;
    if (categoryFilter !== 'all' && app.category !== categoryFilter) return false;
    if (statusFilter === 'installed' && status === 'not-installed') return false;
    if (statusFilter === 'available' && status !== 'not-installed') return false;
    if (statusFilter === 'updates' && !statuses[app.id]?.updateAvailable) return false;

    return true;
  });

  // Separate native, external apps, and other Market item kinds.
  const nativeApps = filteredApps.filter((a) => (a.itemKind || 'app') === 'app' && a.integration === 'native');
  const marketplaceApps = filteredApps.filter((a) => (a.itemKind || 'app') === 'app' && a.integration !== 'native');
  const integrationItems = filteredApps.filter((a) => a.itemKind === 'integration');

  const installedApps = marketplaceApps.filter(
    (a) => statuses[a.id]?.status && statuses[a.id]?.status !== 'not-installed'
  );
  const availableApps = marketplaceApps.filter(
    (a) => !statuses[a.id]?.status || statuses[a.id]?.status === 'not-installed'
  );
  const nativeGroups = groupByCatalogIdentity(nativeApps);
  const installedGroups = groupByCatalogIdentity(installedApps);
  const availableGroups = groupByCatalogIdentity(availableApps);
  const integrationGroups = groupByCatalogIdentity(integrationItems);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Store className="h-7 w-7 text-blue-600" />
            {t('title')}
          </h1>
          <p className="text-gray-500 mt-1">
            {t('description')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowUrlDialog(true)}>
            <Globe className="h-4 w-4 mr-1.5" />
            Install from URL
          </Button>
          <Button variant="outline" size="sm" onClick={() => { fetchCatalog(); fetchStatuses(); }}>
            <RefreshCw className="h-4 w-4 mr-1.5" />
            {tc('refresh')}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 flex items-center gap-2 text-red-600">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="space-y-3 border-y border-gray-200 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <Globe className="h-4 w-4 text-gray-500" />
            Markets
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={addMarketSource}>
              <Plus className="h-4 w-4 mr-1.5" />
              Add
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={saveMarketSources}
              disabled={savingMarketRepo || marketSources.every((source) => !source.repo_url.trim())}
            >
              {savingMarketRepo ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
              Save
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          {marketSources.map((source, index) => (
            <div key={`${source.id}-${index}`} className="grid grid-cols-1 gap-2 rounded-lg border border-gray-200 bg-white p-3 lg:grid-cols-[1fr_2fr_120px_90px_90px_auto] lg:items-center">
              <input
                value={source.name}
                onChange={(event) => updateMarketSource(index, { name: event.target.value })}
                className="h-9 rounded-md border border-gray-300 px-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                placeholder="Market name"
              />
              <input
                value={source.repo_url}
                onChange={(event) => updateMarketSource(index, { repo_url: event.target.value })}
                className="h-9 rounded-md border border-gray-300 px-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                placeholder="https://github.com/youeye-platform/Market"
              />
              <select
                value={source.trust}
                onChange={(event) => updateMarketSource(index, { trust: event.target.value as MarketSourceConfig['trust'] })}
                className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              >
                <option value="official">Official</option>
                <option value="community">Community</option>
                <option value="custom">Custom</option>
              </select>
              <input
                type="number"
                value={source.priority}
                onChange={(event) => updateMarketSource(index, { priority: Number(event.target.value) })}
                className="h-9 rounded-md border border-gray-300 px-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                aria-label="Priority"
              />
              <label className="flex h-9 items-center gap-2 rounded-md border border-gray-200 px-3 text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={source.enabled}
                  onChange={(event) => updateMarketSource(index, { enabled: event.target.checked })}
                  className="h-4 w-4 rounded border-gray-300"
                />
                Enabled
              </label>
              <Button
                variant="outline"
                size="sm"
                onClick={() => removeMarketSource(index)}
                disabled={marketSources.length === 1}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-3">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-gray-700">
          <SlidersHorizontal className="h-4 w-4 text-gray-500" />
          Browse
        </div>
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(220px,2fr)_repeat(4,minmax(140px,1fr))_auto] lg:items-center">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="h-9 w-full rounded-md border border-gray-300 pl-9 pr-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              placeholder="Search Market"
              aria-label="Search Market"
            />
          </label>
          <select
            value={sourceFilter}
            onChange={(event) => setSourceFilter(event.target.value)}
            className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            aria-label="Filter by Market source"
          >
            <option value="all">All Markets</option>
            {sourceOptions.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
            className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            aria-label="Filter by item type"
          >
            <option value="all">All Types</option>
            <option value="native">Native Apps</option>
            <option value="external">External Apps</option>
            <option value="integration">Integrations</option>
          </select>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            aria-label="Filter by install status"
          >
            <option value="all">All Statuses</option>
            <option value="installed">Installed</option>
            <option value="available">Available</option>
            <option value="updates">Updates</option>
          </select>
          <select
            value={categoryFilter}
            onChange={(event) => setCategoryFilter(event.target.value)}
            className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            aria-label="Filter by category"
          >
            <option value="all">All Categories</option>
            {categoryOptions.map((category) => (
              <option key={category} value={category}>{CATEGORIES[category] || category}</option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSearchQuery('');
              setSourceFilter('all');
              setTypeFilter('all');
              setStatusFilter('all');
              setCategoryFilter('all');
            }}
            disabled={!hasActiveFilters}
          >
            Clear
          </Button>
        </div>
        <div className="mt-2 text-xs text-gray-400">
          Showing {filteredApps.length} of {apps.length} Market items
        </div>
      </div>

      {/* Built for YouEye — native apps, grouped by category */}
      {nativeGroups.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
            <Shield className="h-4 w-4" />
            {t('builtForYouEye') ?? 'Built for YouEye'} ({nativeGroups.length})
          </h2>
          {Object.entries(groupByCategory(nativeGroups)).map(([cat, catApps]) => (
            <div key={cat} className="space-y-3">
              <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                {CATEGORIES[cat] || cat}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {catApps.map((group) => (
                  <MarketAppGroupCard
                    key={group.key}
                    group={group}
                    status={statuses[group.primary.id]}
                    installProgress={installProgresses[group.primary.id]}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {apps.length === 0 && !error && (
        <div className="text-center py-16 text-gray-400">
          <Store className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p className="text-lg font-medium">{t('noApps')}</p>
          <p className="text-sm mt-1">{t('catalogEmpty')}</p>
        </div>
      )}

      {apps.length > 0 && filteredApps.length === 0 && !error && (
        <div className="text-center py-16 text-gray-400">
          <Store className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p className="text-lg font-medium">No Market items match these filters</p>
          <p className="text-sm mt-1">Clear a filter or try a broader search.</p>
        </div>
      )}

      {integrationGroups.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
            <Plug className="h-4 w-4" />
            Integrations ({integrationGroups.length})
          </h2>
          {Object.entries(groupByCategory(integrationGroups)).map(([cat, catApps]) => (
            <div key={cat} className="space-y-3">
              <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                {CATEGORIES[cat] || cat}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {catApps.map((group) => (
                  <MarketAppGroupCard
                    key={group.key}
                    group={group}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Installed marketplace apps (flat, no category grouping) */}
      {installedGroups.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            {t('installed')} ({installedGroups.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {installedGroups.map((group) => (
              <MarketAppGroupCard
                key={group.key}
                group={group}
                status={statuses[group.primary.id]}
                installProgress={installProgresses[group.primary.id]}
              />
            ))}
          </div>
        </div>
      )}

      {/* Available marketplace apps, grouped by category */}
      {availableGroups.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            {t('available')} ({availableGroups.length})
          </h2>
          {Object.entries(groupByCategory(availableGroups)).map(([cat, catApps]) => (
            <div key={cat} className="space-y-3">
              <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                {CATEGORIES[cat] || cat}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {catApps.map((group) => (
                  <MarketAppGroupCard
                    key={group.key}
                    group={group}
                    status={statuses[group.primary.id]}
                    installProgress={installProgresses[group.primary.id]}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Orphan resources section */}
      <OrphanSection />

      {/* Uninstall confirmation dialog */}
      {uninstallApp && (
        <UninstallDialog
          app={uninstallApp}
          onUninstall={handleUninstall}
          onClose={() => setUninstallApp(null)}
        />
      )}

      {/* Install from URL dialog */}
      {showUrlDialog && (
        <InstallFromUrlDialog
          domain={'youeye.local'}
          onClose={() => setShowUrlDialog(false)}
          onInstallComplete={() => {
            setShowUrlDialog(false);
            setTimeout(fetchStatuses, 1000);
          }}
        />
      )}
    </div>
  );
}
