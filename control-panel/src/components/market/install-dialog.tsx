'use client';

import { useState, useEffect } from 'react';
import { X, Key, Type, Globe, Eye, EyeOff, ChevronDown, ChevronRight, Settings2, Wifi, Plug, ShieldCheck, ShieldOff, Sparkles, HardDrive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslations } from 'next-intl';
import type { MarketApp, InstallConfig } from '@/lib/market/types';
import type { ConnectionsResponse } from '@/app/api/market/app/[appId]/connections/route';

interface InstallDialogProps {
  app: MarketApp;
  domain: string;
  /** Server display name (e.g. "Byka") for plain-language access labels. */
  siteName?: string;
  onInstall: (config: InstallConfig) => void;
  onClose: () => void;
}

type ParamDef = NonNullable<MarketApp['installParams']>[number];
type AIGroup = {
  id: string;
  name: string;
  isDefault: boolean;
  enabledModelCount: number;
  unavailableRouteCount: number;
  status: 'empty' | 'degraded' | 'available';
};
type StorageLocation = {
  id: string;
  name: string;
  driver: string;
  internal: boolean;
  availableBytes: number | null;
  totalBytes: number | null;
};

function formatBytes(value: number | null): string {
  if (value === null) return 'Space unavailable';
  if (value < 1024 ** 3) return `${Math.round(value / 1024 ** 2)} MB available`;
  return `${(value / 1024 ** 3).toFixed(value < 10 * 1024 ** 3 ? 1 : 0)} GB available`;
}

/** Slugify a string for use as subdomain: lowercase, replace spaces/special chars with hyphens */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function identityIntegration(app: MarketApp) {
  return app.integrations?.find((integration) => integration.type === 'identity');
}

function defaultAccountLogin(app: MarketApp): boolean {
  const identity = identityIntegration(app);
  if (app.supportsSSO) return true;
  if (identity) return identity.required || identity.installByDefault || identity.recommended || false;
  if (app.forwardAuth === 'disabled') return false;
  if (app.forwardAuth === 'enabled') return true;
  return true;
}

export function InstallDialog({ app, domain, siteName = 'YouEye', onInstall, onClose }: InstallDialogProps) {
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
  const [integrationToggles, setIntegrationToggles] = useState<Record<string, boolean>>({});
  const [allowInternet, setAllowInternet] = useState(false);
  const [protectWithAccountLogin, setProtectWithAccountLogin] = useState(() => defaultAccountLogin(app));
  // Forward-auth proxy gate — SEPARATE from account login. Only meaningful for apps that do
  // their own YouEye ID login (native SSO or an identity integration); for them it is an
  // optional extra gate, off by default and fully operable. Plain apps drive the gate from
  // `protectWithAccountLogin` instead, so this stays false/ignored for them.
  const [forwardAuthGate, setForwardAuthGate] = useState(false);
  const supportsAI = app.capabilities?.ai_api === true;
  const [useAISettings, setUseAISettings] = useState(supportsAI);
  const [aiGroups, setAIGroups] = useState<AIGroup[]>([]);
  const [aiGroupId, setAIGroupId] = useState('');
  const [aiGroupsLoading, setAIGroupsLoading] = useState(supportsAI);
  const [aiGroupsError, setAIGroupsError] = useState('');
  const isDirectEntry = app.sourceId?.startsWith('direct:') === true;
  const [directSourceAccepted, setDirectSourceAccepted] = useState(!isDirectEntry);
  const [storageLocations, setStorageLocations] = useState<StorageLocation[]>([]);
  const [storagePool, setStoragePool] = useState('');
  const [storageLoading, setStorageLoading] = useState(true);
  const [storageError, setStorageError] = useState('');
  const [showStorageAdvanced, setShowStorageAdvanced] = useState(false);
  const [storagePlacements, setStoragePlacements] = useState<Partial<Record<'config' | 'data' | 'media', string>>>({});

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

  useEffect(() => {
    const toggles: Record<string, boolean> = {};
    for (const integration of app.integrations ?? []) {
      toggles[integration.id] = integration.required || integration.installByDefault || integration.recommended || false;
    }
    setIntegrationToggles(toggles);
    setProtectWithAccountLogin(defaultAccountLogin(app));
  }, [app]);

  // Fetch connections
  useEffect(() => {
    fetch(`/api/market/app/${encodeURIComponent(app.id)}/connections`)
      .then(res => res.ok ? res.json() : null)
      .then((data: ConnectionsResponse | null) => {
        if (data) {
          setConnections(data);
          setAllowInternet(data.internet.needsInternet);
        }
      })
      .catch(() => {});
  }, [app.id]);

  useEffect(() => {
    if (!supportsAI) return;
    let cancelled = false;
    setAIGroupsLoading(true);
    fetch('/api/market/ai/groups', { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'AI model groups are unavailable');
        return payload as { groups: AIGroup[]; defaultGroupId: string | null };
      })
      .then((payload) => {
        if (cancelled) return;
        setAIGroups(payload.groups);
        setAIGroupId(payload.defaultGroupId || payload.groups[0]?.id || '');
        setAIGroupsError('');
      })
      .catch((error) => {
        if (!cancelled) setAIGroupsError(error instanceof Error ? error.message : 'AI model groups are unavailable');
      })
      .finally(() => { if (!cancelled) setAIGroupsLoading(false); });
    return () => { cancelled = true; };
  }, [supportsAI]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/market/storage/locations', { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json() as { locations?: StorageLocation[]; defaultPool?: string; error?: string };
        if (!response.ok || !payload.locations?.length) throw new Error(payload.error || 'Storage locations are unavailable');
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        setStorageLocations(payload.locations!);
        setStoragePool(payload.defaultPool || payload.locations![0].id);
        setStorageError('');
      })
      .catch((error) => {
        if (!cancelled) setStorageError(error instanceof Error ? error.message : 'Storage locations are unavailable');
      })
      .finally(() => { if (!cancelled) setStorageLoading(false); });
    return () => { cancelled = true; };
  }, []);

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
    !directSourceAccepted ||
    (supportsAI && useAISettings && (aiGroupsLoading || !aiGroupId || Boolean(aiGroupsError))) ||
    storageLoading || !storagePool || Boolean(storageError) ||
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
    const selectedIntegrations = (app.integrations ?? [])
      .filter((integration) => integration.required || integrationToggles[integration.id])
      .map((integration) => integration.id);

    onInstall({
      appId: app.id,
      catalogKey: app.catalogKey,
      sourceId: app.sourceId,
      sourceName: app.sourceName,
      sourceRepoUrl: app.sourceRepoUrl,
      acceptUnverifiedPublisher: isDirectEntry ? directSourceAccepted : undefined,
      manifestPath: app.manifestPath,
      manifestRepo: app.manifestRepo,
      manifestBranch: app.manifestBranch,
      manifestDigest: app.manifestDigest,
      subdomain: subdomain.trim().toLowerCase(),
      domain,
      installParams: Object.keys(resolvedParams).length > 0 ? resolvedParams : undefined,
      customName: trimmedName !== app.name ? trimmedName : undefined,
      selectedIntegrations: (app.integrations?.length ?? 0) > 0 ? selectedIntegrations : undefined,
      protectWithAccountLogin,
      forwardAuthGate,
      allowInternet,
      aiSettings: supportsAI
        ? { enabled: useAISettings, ...(useAISettings ? { modelGroupId: aiGroupId } : {}) }
        : undefined,
      storage: {
        pool: storagePool,
        placements: showStorageAdvanced && Object.keys(storagePlacements).length > 0
          ? storagePlacements
          : undefined,
      },
    });
  };

  const fullUrl = `https://${subdomain}.${domain}`;
  const loginIntegration = identityIntegration(app);
  const accountLoginLocked = app.supportsSSO || loginIntegration?.required || (!loginIntegration && app.forwardAuth === 'disabled');
  const accountLoginDefault = defaultAccountLogin(app);
  // The forward-auth gate is an OPTIONAL extra gate only for apps that do their own YouEye ID
  // login (native SSO, or an identity integration that's currently selected). Plain apps use
  // the account-login toggle above as their gate, so this extra control is hidden for them.
  // It is never available when the manifest hard-disables forward-auth.
  const appDoesOwnLogin = app.supportsSSO || (!!loginIntegration && protectWithAccountLogin);
  const showForwardAuthGate = appDoesOwnLogin && app.forwardAuth !== 'disabled';

  const toggleAccountLogin = () => {
    if (accountLoginLocked) return;
    const next = !protectWithAccountLogin;
    setProtectWithAccountLogin(next);
    if (loginIntegration) {
      setIntegrationToggles((current) => ({ ...current, [loginIntegration.id]: next }));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-2xl mx-4 overflow-hidden max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800 shrink-0">
          <div>
            <h2 className="text-lg font-semibold">{t('install')} {app.name}</h2>
            <p className="mt-1 text-sm text-gray-500">Choose the name, address, and access options for this install.</p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-600"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-6 overflow-y-auto">
          {isDirectEntry && (
            <Alert>
              <ShieldOff className="h-4 w-4" />
              <AlertTitle>Review this app before installing</AlertTitle>
              <AlertDescription>
                <p>You added this app directly. YouEye checked its manifest and install package for safety, but has not verified who published it.</p>
                <label className="mt-2 flex cursor-pointer items-center gap-2 text-foreground">
                  <Switch checked={directSourceAccepted} onCheckedChange={setDirectSourceAccepted} />
                  I trust this source and want to install it
                </label>
              </AlertDescription>
            </Alert>
          )}
          <section className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Basics</h3>
              <p className="mt-1 text-sm text-gray-500">Set how the app appears and where it will open.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="displayName" className="flex items-center gap-1.5">
                  <Type className="h-3.5 w-3.5 text-gray-500" />
                  Display name
                </Label>
                <Input
                  id="displayName"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={app.name}
                  required
                />
                <p className="text-xs text-gray-400">Shown in the app drawer.</p>
              </div>

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
                  Opens at <span className="font-mono text-gray-600 dark:text-gray-300">{fullUrl}</span>
                </p>
              </div>
            </div>
          </section>

          {storageLocations.length > 1 && (
            <section className="space-y-3">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <HardDrive className="size-4 text-primary" />
                  Storage location
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">Choose where this app keeps its files.</p>
              </div>
              <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
                <Select value={storagePool} onValueChange={setStoragePool} disabled={storageLoading}>
                  <SelectTrigger aria-label="Storage location">
                    <SelectValue placeholder="Choose storage" />
                  </SelectTrigger>
                  <SelectContent>
                    {storageLocations.map((location) => (
                      <SelectItem key={location.id} value={location.id}>
                        {location.name} · {formatBytes(location.availableBytes)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto px-0 text-primary hover:bg-transparent hover:text-primary/80"
                  onClick={() => setShowStorageAdvanced((value) => !value)}
                >
                  {showStorageAdvanced ? 'Hide advanced placement' : 'Advanced placement'}
                </Button>
                {showStorageAdvanced && (
                  <div className="grid gap-3 border-t pt-3 sm:grid-cols-3">
                    {(['config', 'data', 'media'] as const).map((type) => (
                      <div key={type} className="space-y-2">
                        <Label htmlFor={`storage-${type}`} className="capitalize">{type}</Label>
                        <Select
                          value={storagePlacements[type] || storagePool}
                          onValueChange={(value) => setStoragePlacements((current) => ({ ...current, [type]: value }))}
                        >
                          <SelectTrigger id={`storage-${type}`}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {storageLocations.map((location) => (
                              <SelectItem key={location.id} value={location.id}>{location.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {storageError && <Alert variant="destructive"><AlertDescription>{storageError}</AlertDescription></Alert>}

          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Access</h3>
              <p className="mt-1 text-sm text-gray-500">Protect this app with account login.</p>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-gray-50/60 p-4">
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 rounded-md p-2 ${protectWithAccountLogin ? 'bg-blue-50 text-blue-600' : 'bg-white text-gray-400'}`}>
                  {protectWithAccountLogin ? <ShieldCheck className="h-4 w-4" /> : <ShieldOff className="h-4 w-4" />}
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {(app.supportsSSO || loginIntegration) ? 'Sign in with YouEye ID' : `Only ${siteName} users`}
                  </p>
                  <p className="mt-1 text-xs text-gray-500">
                    {(app.supportsSSO || loginIntegration)
                      ? `Users sign in to this app with their ${siteName} ID account.`
                      : app.forwardAuth === 'disabled'
                        ? 'This app cannot be gated — it does not support account login.'
                        : `Require a ${siteName} account before anyone can open this app.`}
                  </p>
                  <p className="mt-1 text-xs text-gray-400">
                    Default from manifest: {accountLoginDefault ? 'On' : 'Off'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={protectWithAccountLogin}
                disabled={accountLoginLocked}
                onClick={toggleAccountLogin}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${
                  protectWithAccountLogin ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                    protectWithAccountLogin ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </section>

          {showForwardAuthGate && (
            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Extra account gate</h3>
                <p className="mt-1 text-sm text-gray-500">
                  This app signs in with {siteName} ID. You can also require a {siteName} account
                  before the app even loads — an optional extra gate. Most apps don&apos;t need it.
                </p>
              </div>
              <div className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-gray-50/60 p-4">
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 rounded-md p-2 ${forwardAuthGate ? 'bg-blue-50 text-blue-600' : 'bg-white text-gray-400'}`}>
                    {forwardAuthGate ? <ShieldCheck className="h-4 w-4" /> : <ShieldOff className="h-4 w-4" />}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">Only {siteName} users</p>
                    <p className="mt-1 text-xs text-gray-500">
                      Only people with a {siteName} account can open this app — a sign-in gate at the
                      reverse proxy, on top of the app&apos;s own sign-in.
                    </p>
                    <p className="mt-1 text-xs text-gray-400">Default: Off</p>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={forwardAuthGate}
                  onClick={() => setForwardAuthGate((v) => !v)}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                    forwardAuthGate ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                      forwardAuthGate ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </section>
          )}

          {supportsAI && (
            <section className="space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    <Sparkles className="size-4 text-primary" />
                    AI models
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Use models from your AI Settings so {app.name} works immediately.
                  </p>
                </div>
                <Switch
                  checked={useAISettings}
                  onCheckedChange={setUseAISettings}
                  aria-label="Use AI Settings"
                />
              </div>
              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Use AI Settings</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {useAISettings
                        ? `A separate AI instance will be created for ${app.name}.`
                        : `You’ll configure AI providers inside ${app.name} after installation.`}
                    </p>
                  </div>
                  <Badge variant={useAISettings ? 'default' : 'secondary'}>
                    {useAISettings ? 'On' : 'Off'}
                  </Badge>
                </div>
                {useAISettings && (
                  <div className="mt-4 space-y-2">
                    <Label htmlFor="ai-model-group">Model group</Label>
                    <Select value={aiGroupId} onValueChange={setAIGroupId} disabled={aiGroupsLoading}>
                      <SelectTrigger id="ai-model-group">
                        <SelectValue placeholder={aiGroupsLoading ? 'Loading model groups…' : 'Choose a model group'} />
                      </SelectTrigger>
                      <SelectContent>
                        {aiGroups.map((group) => (
                          <SelectItem key={group.id} value={group.id} disabled={group.status === 'empty'}>
                            {group.name}{group.isDefault ? ' · Default' : ''} · {group.enabledModelCount} model{group.enabledModelCount === 1 ? '' : 's'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {aiGroupsError && <Alert variant="destructive">{aiGroupsError}</Alert>}
                    {aiGroups.find((group) => group.id === aiGroupId)?.unavailableRouteCount ? (
                      <Alert variant="destructive">Some routes in this group need a provider connection.</Alert>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      You can still add other providers inside {app.name}. The initial model is the group&apos;s <code>default</code> alias.
                    </p>
                  </div>
                )}
              </div>
            </section>
          )}

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

          {(app.integrations?.filter((integration) => integration.id !== loginIntegration?.id).length ?? 0) > 0 && (
            <div className="space-y-3">
              <Label className="flex items-center gap-1.5">
                <Plug className="h-3.5 w-3.5 text-gray-500" />
                Integrations
              </Label>
              <div className="space-y-2">
                {app.integrations!.filter((integration) => integration.id !== loginIntegration?.id).map(integration => (
                  <div
                    key={integration.id}
                    className="flex items-center justify-between rounded-lg border border-gray-100 dark:border-gray-800 p-3"
                  >
                    <div>
                      <p className="text-sm font-medium">{integration.name}</p>
                      {integration.description && (
                        <p className="text-xs text-gray-400">{integration.description}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={integration.required || (integrationToggles[integration.id] ?? false)}
                      disabled={integration.required}
                      onClick={() => setIntegrationToggles(prev => ({
                        ...prev,
                        [integration.id]: !prev[integration.id],
                      }))}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-60 ${
                        integration.required || integrationToggles[integration.id] ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                          integration.required || integrationToggles[integration.id] ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Internet / LAN Access */}
          {connections?.internet?.needsInternet && (
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <Wifi className="h-3.5 w-3.5 text-gray-500" />
              Internet &amp; LAN Access
            </Label>
            <div className="flex items-center justify-between rounded-lg border border-gray-100 dark:border-gray-800 p-3">
              <div>
                <p className="text-sm font-medium">Allow Internet &amp; LAN Access</p>
                <p className="text-xs text-gray-400">
                  {connections?.internet?.hosts?.length
                    ? `Uses: ${connections.internet.hosts.join(', ')}`
                    : 'Allow this app to make outbound network requests'}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={allowInternet}
                onClick={() => setAllowInternet(prev => !prev)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  allowInternet ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                    allowInternet ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
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
