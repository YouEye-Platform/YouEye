'use client';

import { useState, useEffect } from 'react';
import { X, Key, Type, Globe, Eye, EyeOff, ChevronDown, ChevronRight, Settings2, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslations } from 'next-intl';
import type { MarketApp, InstallConfig, ApprovedConnection } from '@/lib/market/types';
import type { ConnectionsResponse } from '@/app/api/market/app/[appId]/connections/route';

interface InstallDialogProps {
  app: MarketApp;
  domain: string;
  onInstall: (config: InstallConfig) => void;
  onClose: () => void;
}

type ParamDef = NonNullable<MarketApp['installParams']>[number];

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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [connections, setConnections] = useState<ConnectionsResponse | null>(null);
  const [connectionToggles, setConnectionToggles] = useState<Record<string, boolean>>({});

  // Initialize defaults
  useEffect(() => {
    const defaults: Record<string, string> = {};
    for (const param of app.installParams ?? []) {
      if (param.default !== undefined) {
        defaults[param.name] = String(param.default);
      }
    }
    setInstallParamsState(defaults);
  }, [app.installParams]);

  // Fetch connections
  useEffect(() => {
    fetch(`/api/market/app/${encodeURIComponent(app.id)}/connections`)
      .then(res => res.ok ? res.json() : null)
      .then((data: ConnectionsResponse | null) => {
        if (data) {
          setConnections(data);
          const toggles: Record<string, boolean> = {};
          for (const c of data.outgoing) {
            toggles[c.targetAppId] = c.installed;
          }
          setConnectionToggles(toggles);
        }
      })
      .catch(() => {});
  }, [app.id]);

  // Auto-slugify subdomain when name changes (unless user manually edited subdomain)
  useEffect(() => {
    if (!subdomainManuallyEdited && displayName !== app.name) {
      const slug = slugify(displayName);
      if (slug) setSubdomain(slug);
    }
  }, [displayName, subdomainManuallyEdited, app.name]);

  const params = app.installParams ?? [];
  // Split into required (always visible) and advanced (collapsible)
  const requiredParams = params.filter((p) => p.required);
  const advancedParams = params.filter((p) => !p.required);

  const validateParam = (param: ParamDef, value: string): string | null => {
    if (param.required && !value.trim()) return `${param.label} is required`;
    if (!value.trim()) return null; // Optional and empty is fine

    if (param.validation?.pattern) {
      try {
        const regex = new RegExp(param.validation.pattern);
        if (!regex.test(value)) {
          return param.validation.message || `Invalid format for ${param.label}`;
        }
      } catch { /* invalid regex — skip */ }
    }
    if (param.type === 'number') {
      const num = Number(value);
      if (isNaN(num)) return `${param.label} must be a number`;
      if (param.validation?.min !== undefined && num < param.validation.min) {
        return `${param.label} must be at least ${param.validation.min}`;
      }
      if (param.validation?.max !== undefined && num > param.validation.max) {
        return `${param.label} must be at most ${param.validation.max}`;
      }
    }
    if (param.type === 'select' && param.choices) {
      if (!param.choices.some((c) => c.value === value)) {
        return `Invalid selection for ${param.label}`;
      }
    }
    return null;
  };

  const updateParam = (name: string, value: string) => {
    setInstallParamsState((prev) => ({ ...prev, [name]: value }));
    // Clear validation error on change
    setValidationErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const validateAll = (): boolean => {
    const errors: Record<string, string> = {};
    for (const param of params) {
      const value = installParamsState[param.name] ?? '';
      const error = validateParam(param, value);
      if (error) errors[param.name] = error;
    }
    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const installDisabled =
    !displayName.trim() ||
    !subdomain.trim() ||
    requiredParams.some((p) => !installParamsState[p.name]?.trim());

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (installDisabled) return;
    if (!validateAll()) return;

    const resolvedParams: Record<string, string> = {};
    for (const [k, v] of Object.entries(installParamsState)) {
      if (v.trim()) resolvedParams[k] = v.trim();
    }

    const trimmedName = displayName.trim();
    const approvedConnections: ApprovedConnection[] = connections?.outgoing?.map(c => ({
      targetAppId: c.targetAppId,
      approved: connectionToggles[c.targetAppId] ?? false,
    })) ?? [];

    onInstall({
      appId: app.id,
      subdomain: subdomain.trim().toLowerCase(),
      domain,
      installParams: Object.keys(resolvedParams).length > 0 ? resolvedParams : undefined,
      customName: trimmedName !== app.name ? trimmedName : undefined,
      approvedConnections: approvedConnections.length > 0 ? approvedConnections : undefined,
    });
  };

  const fullUrl = `https://${subdomain}.${domain}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800 shrink-0">
          <h2 className="text-lg font-semibold">{t('install')} {app.name}</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5 overflow-y-auto">
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

          {/* Required install parameters (always visible) */}
          {requiredParams.map((param) => (
            <ParamField
              key={param.name}
              param={param}
              value={installParamsState[param.name] ?? ''}
              onChange={(v) => updateParam(param.name, v)}
              error={validationErrors[param.name]}
              showPassword={showPasswords[param.name]}
              onTogglePassword={() =>
                setShowPasswords((p) => ({ ...p, [param.name]: !p[param.name] }))
              }
            />
          ))}

          {/* Advanced options (collapsible) */}
          {advancedParams.length > 0 && (
            <div className="border border-gray-100 rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                {showAdvanced ? (
                  <ChevronDown className="h-4 w-4 text-gray-400" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-gray-400" />
                )}
                <Settings2 className="h-3.5 w-3.5 text-gray-400" />
                Advanced Options
                <span className="text-xs text-gray-400 ml-auto">
                  ({advancedParams.length})
                </span>
              </button>
              {showAdvanced && (
                <div className="px-4 pb-4 space-y-4 border-t border-gray-100 pt-4">
                  {advancedParams.map((param) => (
                    <ParamField
                      key={param.name}
                      param={param}
                      value={installParamsState[param.name] ?? ''}
                      onChange={(v) => updateParam(param.name, v)}
                      error={validationErrors[param.name]}
                      showPassword={showPasswords[param.name]}
                      onTogglePassword={() =>
                        setShowPasswords((p) => ({ ...p, [param.name]: !p[param.name] }))
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Connections */}
          {connections && connections.outgoing.length > 0 && (
            <div className="space-y-3">
              <Label className="flex items-center gap-1.5">
                <Link2 className="h-3.5 w-3.5 text-gray-500" />
                Connections
              </Label>
              <p className="text-xs text-gray-400">
                This app can connect to the following apps.
              </p>
              <div className="space-y-2">
                {connections.outgoing.map(c => (
                  <div
                    key={c.targetAppId}
                    className="flex items-center justify-between rounded-lg border border-gray-100 dark:border-gray-800 p-3"
                  >
                    <div>
                      <p className="text-sm font-medium">{c.targetAppName}</p>
                      <p className="text-xs text-gray-400">
                        {c.description || `Connect to ${c.targetAppName}`}
                        {!c.installed && (
                          <span className="text-amber-500 ml-1">(not installed)</span>
                        )}
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={connectionToggles[c.targetAppId] ?? false}
                      onClick={() => setConnectionToggles(prev => ({
                        ...prev,
                        [c.targetAppId]: !prev[c.targetAppId],
                      }))}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        connectionToggles[c.targetAppId] ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                          connectionToggles[c.targetAppId] ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

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

// ── Parameter Field Component ─────────────────────────────────

interface ParamFieldProps {
  param: ParamDef;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  showPassword?: boolean;
  onTogglePassword?: () => void;
}

function ParamField({ param, value, onChange, error, showPassword, onTogglePassword }: ParamFieldProps) {
  const paramType = param.type ?? 'string';
  const iconClass = 'h-3.5 w-3.5 text-gray-500';

  return (
    <div className="space-y-2">
      <Label htmlFor={`param-${param.name}`} className="flex items-center gap-1.5">
        <Key className={iconClass} />
        {param.label}
        {param.required && <span className="text-red-500">*</span>}
      </Label>

      {/* Boolean: toggle switch */}
      {paramType === 'boolean' ? (
        <button
          type="button"
          role="switch"
          aria-checked={value === 'true'}
          onClick={() => onChange(value === 'true' ? 'false' : 'true')}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            value === 'true' ? 'bg-blue-500' : 'bg-gray-300'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
              value === 'true' ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      ) : paramType === 'select' && param.choices ? (
        /* Select: dropdown */
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={`param-${param.name}`}>
            <SelectValue placeholder={`Select ${param.label}`} />
          </SelectTrigger>
          <SelectContent>
            {param.choices.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : paramType === 'password' ? (
        /* Password: input with show/hide toggle */
        <div className="relative">
          <Input
            id={`param-${param.name}`}
            type={showPassword ? 'text' : 'password'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={`Enter ${param.label}`}
            className="font-mono text-sm pr-10"
            required={param.required}
          />
          <button
            type="button"
            onClick={onTogglePassword}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
          >
            {showPassword ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        </div>
      ) : paramType === 'number' ? (
        /* Number: numeric input with min/max */
        <Input
          id={`param-${param.name}`}
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Enter ${param.label}`}
          className="font-mono text-sm"
          required={param.required}
          min={param.validation?.min}
          max={param.validation?.max}
        />
      ) : (
        /* String: plain text input */
        <Input
          id={`param-${param.name}`}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Enter ${param.label}`}
          className="text-sm"
          required={param.required}
        />
      )}

      {/* Description */}
      {param.description && (
        <p className="text-xs text-gray-400">{param.description}</p>
      )}

      {/* Validation error */}
      {error && (
        <p className="text-xs text-red-500">{error}</p>
      )}
    </div>
  );
}
