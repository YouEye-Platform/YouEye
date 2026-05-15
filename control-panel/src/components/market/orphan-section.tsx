'use client';

import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, Loader2, Trash2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { authenticatedFetch } from '@/lib/api-client';
import { useTranslations } from 'next-intl';
import type { OrphanResource } from '@/lib/market/types';

const TYPE_LABELS: Record<string, string> = {
  'caddy-route': 'Caddy Route',
  'authentik-app': 'Authentik App',
  'authentik-provider': 'Authentik Provider',
  'postgres-db': 'PostgreSQL Database',
  'dns-entry': 'DNS Entry',
  'volume-dir': 'Volume Directory',
  container: 'Container',
};

export function OrphanSection() {
  const [orphans, setOrphans] = useState<OrphanResource[]>([]);
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const t = useTranslations('market');

  const scan = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authenticatedFetch('/api/admin/orphans');
      if (res.ok) {
        const data = await res.json();
        setOrphans(data.orphans ?? []);
      }
    } catch {
      // Non-fatal
    } finally {
      setLoading(false);
      setScanned(true);
    }
  }, []);

  const cleanupAll = async () => {
    if (!confirm(t('orphanCleanupConfirm') ?? 'Remove all orphaned resources?')) return;
    setCleaning(true);
    try {
      await authenticatedFetch('/api/admin/orphans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cleanup-all' }),
      });
      await scan();
    } catch {
      // Non-fatal
    } finally {
      setCleaning(false);
    }
  };

  const cleanupOne = async (orphan: OrphanResource) => {
    try {
      await authenticatedFetch('/api/admin/orphans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cleanup', orphan }),
      });
      setOrphans((prev) => prev.filter((o) => o !== orphan));
    } catch {
      // Non-fatal
    }
  };

  if (!scanned) {
    return (
      <div className="border border-dashed border-gray-200 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-gray-500">
            <AlertTriangle className="h-4 w-4" />
            <span className="text-sm">{t('orphanScanPrompt') ?? 'Scan for orphaned resources from previous installs'}</span>
          </div>
          <Button variant="outline" size="sm" onClick={scan} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
            {t('orphanScan') ?? 'Scan'}
          </Button>
        </div>
      </div>
    );
  }

  if (orphans.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-amber-600 uppercase tracking-wide flex items-center gap-1.5">
          <AlertTriangle className="h-4 w-4" />
          {t('orphanedResources') ?? 'Orphaned Resources'} ({orphans.length})
        </h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={scan} disabled={loading}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={cleanupAll}
            disabled={cleaning}
            className="text-red-600 hover:bg-red-50"
          >
            {cleaning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : (
              <Trash2 className="h-3.5 w-3.5 mr-1" />
            )}
            {t('orphanCleanAll') ?? 'Clean up all'}
          </Button>
        </div>
      </div>
      <div className="border border-amber-200 rounded-lg divide-y divide-amber-100 bg-amber-50/50">
        {orphans.map((orphan, i) => (
          <div key={`${orphan.type}-${orphan.identifier}-${i}`} className="flex items-center justify-between px-4 py-2.5">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                  {TYPE_LABELS[orphan.type] ?? orphan.type}
                </span>
                <span className="text-sm font-mono text-gray-700">{orphan.identifier}</span>
              </div>
              {orphan.detail && (
                <p className="text-xs text-gray-500 mt-0.5">{orphan.detail}</p>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => cleanupOne(orphan)}
              className="text-red-500 hover:text-red-700 hover:bg-red-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
