'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, Store, AlertCircle, RefreshCw, Shield, Globe } from 'lucide-react';
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

function groupByCategory(apps: MarketApp[]): Record<string, MarketApp[]> {
  const groups: Record<string, MarketApp[]> = {};
  for (const app of apps) {
    const cat = app.category || 'other';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(app);
  }
  return groups;
}

export default function MarketPage() {
  const [apps, setApps] = useState<MarketApp[]>([]);
  const [statuses, setStatuses] = useState<Record<string, AppStatusInfo>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      fetchCatalog(),
      fetchStatuses(),
      fetchDomain(),
    ]).finally(() => setLoading(false));

    const interval = setInterval(() => {
      fetchStatuses();
    }, 10_000);
    return () => clearInterval(interval);
  }, [fetchCatalog, fetchStatuses, fetchDomain]);

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

  // Separate native and marketplace, then split installed/available
  const nativeApps = apps.filter((a) => a.integration === 'native' || a.type === 'native');
  const marketplaceApps = apps.filter((a) => a.integration !== 'native' && a.type !== 'native');

  const installedApps = marketplaceApps.filter(
    (a) => statuses[a.id]?.status && statuses[a.id]?.status !== 'not-installed'
  );
  const availableApps = marketplaceApps.filter(
    (a) => !statuses[a.id]?.status || statuses[a.id]?.status === 'not-installed'
  );

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

      {/* Built for YouEye — native apps, grouped by category */}
      {nativeApps.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
            <Shield className="h-4 w-4" />
            {t('builtForYouEye') ?? 'Built for YouEye'} ({nativeApps.length})
          </h2>
          {Object.entries(groupByCategory(nativeApps)).map(([cat, catApps]) => (
            <div key={cat} className="space-y-3">
              <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                {CATEGORIES[cat] || cat}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {catApps.map((app) => (
                  <AppCard
                    key={app.id}
                    app={app}
                    status={statuses[app.id]}
                    installProgress={installProgresses[app.id]}
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

      {/* Installed marketplace apps (flat, no category grouping) */}
      {installedApps.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            {t('installed')} ({installedApps.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {installedApps.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                status={statuses[app.id]}
                installProgress={installProgresses[app.id]}
              />
            ))}
          </div>
        </div>
      )}

      {/* Available marketplace apps, grouped by category */}
      {availableApps.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            {t('available')} ({availableApps.length})
          </h2>
          {Object.entries(groupByCategory(availableApps)).map(([cat, catApps]) => (
            <div key={cat} className="space-y-3">
              <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                {CATEGORIES[cat] || cat}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {catApps.map((app) => (
                  <AppCard
                    key={app.id}
                    app={app}
                    status={statuses[app.id]}
                    installProgress={installProgresses[app.id]}
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
