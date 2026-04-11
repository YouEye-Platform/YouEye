'use client';

import { useState, useEffect } from 'react';
import { X, Key, Type, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import type { MarketApp, InstallConfig } from '@/lib/market/types';

interface InstallDialogProps {
  app: MarketApp;
  domain: string;
  onInstall: (config: InstallConfig) => void;
  onClose: () => void;
}

/** Slugify a string for use as subdomain: lowercase, replace spaces/special chars with hyphens */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function InstallDialog({ app, domain, onInstall, onClose }: InstallDialogProps) {
  const t = useTranslations('market');
  const tc = useTranslations('common');

  const [displayName, setDisplayName] = useState(app.name);
  const [subdomain, setSubdomain] = useState(app.defaultSubdomain);
  const [subdomainManuallyEdited, setSubdomainManuallyEdited] = useState(false);
  const [installParamsState, setInstallParamsState] = useState<Record<string, string>>({});

  // Auto-slugify subdomain when name changes (unless user manually edited subdomain)
  useEffect(() => {
    if (!subdomainManuallyEdited && displayName !== app.name) {
      const slug = slugify(displayName);
      if (slug) setSubdomain(slug);
    }
  }, [displayName, subdomainManuallyEdited, app.name]);

  const requiredParamsMissing = app.installParams?.some(
    p => p.required && !installParamsState[p.name]?.trim()
  ) ?? false;
  const installDisabled = requiredParamsMissing || !displayName.trim() || !subdomain.trim();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (installDisabled) return;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(installParamsState)) {
      if (v.trim()) params[k] = v.trim();
    }

    const trimmedName = displayName.trim();
    onInstall({
      appId: app.id,
      subdomain: subdomain.trim().toLowerCase(),
      domain,
      installParams: Object.keys(params).length > 0 ? params : undefined,
      customName: trimmedName !== app.name ? trimmedName : undefined,
    });
  };

  const fullUrl = `https://${subdomain}.${domain}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-lg font-semibold">{t('install')} {app.name}</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* Display Name */}
          <div className="space-y-2">
            <Label htmlFor="displayName" className="flex items-center gap-1.5">
              <Type className="h-3.5 w-3.5 text-gray-500" />
              Display Name
            </Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={app.name}
              className="flex-1"
              required
            />
            <p className="text-xs text-gray-400">
              How this app appears in your app drawer.
            </p>
          </div>

          {/* Subdomain */}
          <div className="space-y-2">
            <Label htmlFor="subdomain" className="flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5 text-gray-500" />
              {t('subdomain')}
            </Label>
            <div className="flex items-center gap-1">
              <Input
                id="subdomain"
                value={subdomain}
                onChange={(e) => {
                  setSubdomain(e.target.value);
                  setSubdomainManuallyEdited(true);
                }}
                placeholder="search"
                className="flex-1"
                required
                pattern="[a-z0-9-]+"
                title="Lowercase letters, numbers, and hyphens only"
              />
              <span className="text-sm text-gray-400 whitespace-nowrap">.{domain}</span>
            </div>
            <p className="text-xs text-gray-400">
              Your app will be available at{' '}
              <span className="font-mono text-gray-600 dark:text-gray-300">{fullUrl}</span>
            </p>
          </div>

          {/* Resource summary */}
          <div className="rounded-lg bg-gray-50 dark:bg-gray-800 p-3 space-y-1">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              {t('resources')}
            </p>
            <div className="text-sm text-gray-700 dark:text-gray-300 flex gap-6">
              <span>{t('memory')}: {app.estimatedMemory}</span>
              <span>{t('cpu')}: {app.estimatedCPU}</span>
            </div>
          </div>

          {/* App-specific install parameters */}
          {app.installParams?.map(param => (
            <div key={param.name} className="space-y-2">
              <Label htmlFor={`param-${param.name}`} className="flex items-center gap-1.5">
                <Key className="h-3.5 w-3.5 text-gray-500" />
                {param.label} {param.required && <span className="text-red-500">*</span>}
              </Label>
              <Input
                id={`param-${param.name}`}
                type="password"
                value={installParamsState[param.name] || ''}
                onChange={(e) => setInstallParamsState(prev => ({ ...prev, [param.name]: e.target.value }))}
                placeholder={`Enter ${param.label}`}
                className="font-mono text-sm"
                required={param.required}
              />
              {param.description && (
                <p className="text-xs text-gray-400">{param.description}</p>
              )}
            </div>
          ))}

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <Button type="button" variant="outline" onClick={onClose} className="flex-1">
              {tc('cancel')}
            </Button>
            <Button type="submit" className="flex-1" disabled={installDisabled}>
              {t('install')} {displayName || app.name}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
