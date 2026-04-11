'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  Server,
  Box,
  Cog,
  Monitor,
  Database,
  ShieldCheck,
  Globe,
  Shield,
  LayoutDashboard,
  Loader2,
  RefreshCw,
  ChevronRight,
  ArrowUpCircle,
  CheckCircle2,
  Circle,
  AlertCircle,
  MinusCircle,
  Package,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { authenticatedFetch } from '@/lib/api-client';
import { useTranslations } from 'next-intl';
import type { UnifiedApp, UnifiedAppsResponse } from '@/app/api/apps/unified/route';

const ICON_MAP: Record<string, typeof Package> = {
  Server,
  Box,
  Cog,
  Monitor,
  Database,
  ShieldCheck,
  Globe,
  Shield,
  LayoutDashboard,
};

const STATUS_BADGE: Record<
  string,
  { label: string; className: string; Icon: typeof CheckCircle2 }
> = {
  running: {
    label: 'Running',
    className: 'bg-green-100 text-green-700 border-green-200',
    Icon: CheckCircle2,
  },
  stopped: {
    label: 'Stopped',
    className: 'bg-gray-100 text-gray-600 border-gray-200',
    Icon: Circle,
  },
  partial: {
    label: 'Partial',
    className: 'bg-amber-100 text-amber-700 border-amber-200',
    Icon: MinusCircle,
  },
  'not-installed': {
    label: 'Not Installed',
    className: 'bg-gray-50 text-gray-400 border-gray-100',
    Icon: Circle,
  },
  unknown: {
    label: 'Unknown',
    className: 'bg-gray-100 text-gray-500 border-gray-200',
    Icon: AlertCircle,
  },
};

function StatusBadge({ status }: { status: string }) {
  const config = STATUS_BADGE[status] ?? STATUS_BADGE.unknown;
  const { Icon } = config;
  return (
    <Badge variant="outline" className={config.className}>
      <Icon className="h-3 w-3" />
      {config.label}
    </Badge>
  );
}

function AppRow({
  app,
  showUpdate,
}: {
  app: UnifiedApp;
  showUpdate?: boolean;
}) {
  const Icon = ICON_MAP[app.icon] ?? Package;
  const isSystem = app.category === 'system' && app.containers.length === 0;

  return (
    <Link
      href={`/apps/${app.id}`}
      className="flex items-center gap-4 px-4 py-3 rounded-lg border border-gray-100 bg-white hover:border-blue-200 hover:shadow-sm transition-all group"
    >
      <div
        className={`p-2 rounded-lg shrink-0 ${
          isSystem ? 'bg-gray-100' : 'bg-blue-50'
        }`}
      >
        <Icon
          className={`h-5 w-5 ${isSystem ? 'text-gray-500' : 'text-blue-600'}`}
        />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-900 truncate">
            {app.displayName}
          </span>
          {app.version && (
            <span className="text-xs text-gray-400 font-mono">
              v{app.version}
            </span>
          )}
        </div>
        <p className="text-sm text-gray-500 truncate">{app.description}</p>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {showUpdate && app.updateInfo && (
          <span className="text-xs text-amber-600 font-medium hidden sm:block">
            {app.updateInfo}
          </span>
        )}
        <StatusBadge status={app.status} />
        <ChevronRight className="h-4 w-4 text-gray-300 group-hover:text-blue-500 transition-colors" />
      </div>
    </Link>
  );
}

export default function AppsPage() {
  const t = useTranslations('apps');
  const tc = useTranslations('common');
  const [data, setData] = useState<UnifiedAppsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchApps = useCallback(async () => {
    try {
      const res = await fetch('/api/apps/unified');
      if (!res.ok) throw new Error('Failed to load apps');
      const json: UnifiedAppsResponse = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApps();
    const interval = setInterval(fetchApps, 15_000); // refresh every 15s
    return () => clearInterval(interval);
  }, [fetchApps]);

  const handleCheckUpdates = async () => {
    setChecking(true);
    try {
      await authenticatedFetch('/api/apps/check-updates', { method: 'POST' });
      await fetchApps();
    } catch {
      // ignore
    } finally {
      setChecking(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 flex items-center gap-2 text-red-600">
        <AlertCircle className="h-5 w-5 shrink-0" />
        <span>{error ?? 'Failed to load apps'}</span>
      </div>
    );
  }

  const appsWithUpdates = data.apps.filter((a) => a.updateAvailable);
  const appsWithoutUpdates = data.apps.filter((a) => !a.updateAvailable);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-gray-500 mt-1">
            {t('description')}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleCheckUpdates}
          disabled={checking || data.checkInProgress}
        >
          {checking || data.checkInProgress ? (
            <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-1.5" />
          )}
          {t('checkForUpdates')}
        </Button>
      </div>

      {/* Last checked info */}
      {data.lastCheckedAt && (
        <p className="text-xs text-gray-400">
          {t('lastChecked')}:{' '}
          {new Date(data.lastCheckedAt).toLocaleString()}
        </p>
      )}

      {/* Updates Available Section */}
      {appsWithUpdates.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 px-1">
            <ArrowUpCircle className="h-4 w-4 text-amber-500" />
            <h2 className="text-sm font-semibold text-amber-700 uppercase tracking-wide">
              {t('updatesAvailable')}
            </h2>
            <Badge variant="outline" className="bg-amber-50 text-amber-600 border-amber-200">
              {appsWithUpdates.length}
            </Badge>
          </div>
          <div className="space-y-1.5">
            {appsWithUpdates.map((app) => (
              <AppRow key={app.id} app={app} showUpdate />
            ))}
          </div>
        </div>
      )}

      {/* All Services Section */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide px-1">
          {appsWithUpdates.length > 0 ? t('upToDate') : t('allServices')}
        </h2>
        <div className="space-y-1.5">
          {appsWithoutUpdates.map((app) => (
            <AppRow key={app.id} app={app} />
          ))}
        </div>
      </div>
    </div>
  );
}

