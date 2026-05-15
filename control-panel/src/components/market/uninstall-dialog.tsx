'use client';

import { useState } from 'react';
import { AlertTriangle, Trash2, Package, Database, Globe, Shield, HardDrive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';
import type { MarketApp } from '@/lib/market/types';

interface UninstallDialogProps {
  app: MarketApp;
  onUninstall: (appId: string, keepData: boolean) => void;
  onClose: () => void;
}

export function UninstallDialog({ app, onUninstall, onClose }: UninstallDialogProps) {
  const [mode, setMode] = useState<'keep' | 'delete'>('keep');
  const t = useTranslations('market');

  const items = [
    { icon: Package, label: 'Container and services', removed: true },
    { icon: Globe, label: 'Caddy reverse proxy route', removed: true },
    { icon: Shield, label: 'Authentik SSO application', removed: app.supportsSSO },
    { icon: Globe, label: 'Pi-Hole DNS entry', removed: true },
    { icon: Database, label: 'Shared database', removed: mode === 'delete' },
    { icon: HardDrive, label: 'App data and volumes', removed: mode === 'delete' },
  ].filter((item) => item.removed !== false || mode === 'delete');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4 overflow-hidden">
        {/* Header */}
        <div className="p-6 pb-4">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-red-50">
              <AlertTriangle className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900">
                {t('uninstallTitle') ?? 'Uninstall'} {app.name}
              </h3>
              <p className="text-sm text-gray-500">
                {t('uninstallDescription') ?? 'Choose what to remove'}
              </p>
            </div>
          </div>

          {/* Mode selection */}
          <div className="space-y-2 mb-4">
            <button
              type="button"
              onClick={() => setMode('keep')}
              className={`w-full text-left p-3 rounded-lg border-2 transition-colors ${
                mode === 'keep'
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="font-medium text-sm">
                {t('uninstallKeepData') ?? 'Uninstall (keep data)'}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {t('uninstallKeepDataDescription') ?? 'Remove the app but keep data for reinstall'}
              </div>
            </button>
            <button
              type="button"
              onClick={() => setMode('delete')}
              className={`w-full text-left p-3 rounded-lg border-2 transition-colors ${
                mode === 'delete'
                  ? 'border-red-500 bg-red-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="font-medium text-sm text-red-700">
                {t('uninstallDeleteData') ?? 'Uninstall + delete all data'}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {t('uninstallDeleteDataDescription') ?? 'Remove everything. This cannot be undone.'}
              </div>
            </button>
          </div>

          {/* What will be removed */}
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
              {t('willBeRemoved') ?? 'Will be removed'}
            </p>
            <ul className="space-y-1.5">
              {items.map((item) => (
                <li key={item.label} className="flex items-center gap-2 text-sm text-gray-700">
                  <item.icon className="h-3.5 w-3.5 text-gray-400" />
                  {item.label}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 bg-gray-50 border-t border-gray-100">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={mode === 'delete' ? 'destructive' : 'default'}
            onClick={() => onUninstall(app.id, mode === 'keep')}
          >
            <Trash2 className="h-4 w-4 mr-1" />
            {mode === 'delete'
              ? (t('uninstallDeleteButton') ?? 'Delete everything')
              : (t('uninstallKeepButton') ?? 'Uninstall')}
          </Button>
        </div>
      </div>
    </div>
  );
}
