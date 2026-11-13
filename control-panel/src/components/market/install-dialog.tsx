'use client';
import {useLocale} from "next-intl";






import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useState, useEffect } from 'react';
import { X, Type, Globe, Wifi, Plug, ShieldCheck, ShieldOff, Sparkles, HardDrive } from 'lucide-react';
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
  const translateInterface = useInterfaceTranslations("interface");
  const locale = useLocale();
function formatBytes(value: number | null): string {
  if (value === null) return translateInterface("m77b235a4e47f");
  if (value < 1024 ** 3) return translateInterface("m0cb4031e7c01", {amount: new Intl.NumberFormat(locale).format(Math.round(value / 1024 ** 2))});
  return translateInterface("m9e3fa5262cda", {amount: new Intl.NumberFormat(locale, {maximumFractionDigits: value < 10 * 1024 ** 3 ? 1 : 0}).format(value / 1024 ** 3)});
}


  const t = useTranslations('market');
  const tc = useTranslations('common');
  const [retainedData, setRetainedData] = useState<{ retained: boolean; canAdopt?: boolean; version?: string }>();
  const [adoptRetainedData, setAdoptRetainedData] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/market/app/${encodeURIComponent(app.id)}/retained`)
      .then(async response => {
        if (!response.ok) throw new Error(translateInterface("m3a5222eebc95"));
        return response.json();
      }).then(data => { if (!cancelled) setRetainedData(data); })
      .catch(() => { if (!cancelled) setRetainedData({ retained: true, canAdopt: false }); });
    return () => { cancelled = true; };
  }, [app.id]);

  const [displayName, setDisplayName] = useState(app.name);
  const [subdomain, setSubdomain] = useState(app.defaultSubdomain);
  const [subdomainManuallyEdited, setSubdomainManuallyEdited] = useState(false);
  const [connections, setConnections] = useState<ConnectionsResponse | null>(null);
  const [integrationToggles, setIntegrationToggles] = useState<Record<string, boolean>>({});
  const [allowInternet, setAllowInternet] = useState(false);
  const [protectWithAccountLogin, setProtectWithAccountLogin] = useState(() => defaultAccountLogin(app));
  // Forward-auth proxy gate — SEPARATE from account login. Only meaningful for apps that do
  // their own YouEye ID login (native SSO or an identity integration); for them it is an
  // optional extra gate, off by default and fully operable. Plain apps drive the gate from
  // `protectWithAccountLogin` instead, so this stays false/ignored for them.
  const [forwardAuthGate, setForwardAuthGate] = useState(false);
  // Apps that protect themselves (manifest `public_access`) install public unless the owner turns it off here.
  const offersPublicAccess = app.publicAccess === true;
  const [publicAccess, setPublicAccess] = useState(offersPublicAccess);
  const supportsAI = app.capabilities?.ai_api === true;
  const [useAISettings, setUseAISettings] = useState(supportsAI);
  const [aiGroups, setAIGroups] = useState<AIGroup[]>([]);
  const [aiGroupId, setAIGroupId] = useState('');
  const [aiGroupsLoading, setAIGroupsLoading] = useState(supportsAI);
  const [aiGroupsError, setAIGroupsError] = useState('');
  const isDirectEntry = app.sourceId?.startsWith('direct:') === true;
  const [directSourceAccepted, setDirectSourceAccepted] = useState(!isDirectEntry);
  // Setup files of an app from an added (URL) source need a second, explicit approval.
  const setupFiles = app.setups ?? [];
  const needsSetupApproval = isDirectEntry && setupFiles.length > 0;
  const [setupFilesAllowed, setSetupFilesAllowed] = useState(!needsSetupApproval);
  const setupPurpose = (purpose: string) => {
    if (purpose === 'install') return translateInterface("m3214819b16f1");
    if (purpose === 'sso') return translateInterface("mfb7ed10de1ed");
    if (purpose === 'url-change') return translateInterface("m18bac77ed792");
    if (purpose.startsWith('connect:')) return translateInterface("m7c07160bf0db", { app: purpose.slice('connect:'.length) });
    return purpose;
  };
  const [storageLocations, setStorageLocations] = useState<StorageLocation[]>([]);
  const [storagePool, setStoragePool] = useState('');
  const [storageLoading, setStorageLoading] = useState(true);
  const [storageError, setStorageError] = useState('');
  const [showStorageAdvanced, setShowStorageAdvanced] = useState(false);
  const [storagePlacements, setStoragePlacements] = useState<Partial<Record<'config' | 'data' | 'media', string>>>({});

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
        if (!response.ok) throw new Error(payload.error || translateInterface("m05b6b93500f0"));
        return payload as { groups: AIGroup[]; defaultGroupId: string | null };
      })
      .then((payload) => {
        if (cancelled) return;
        setAIGroups(payload.groups);
        setAIGroupId(payload.defaultGroupId || payload.groups[0]?.id || '');
        setAIGroupsError('');
      })
      .catch((error) => {
        if (!cancelled) setAIGroupsError(error instanceof Error ? error.message : translateInterface("m05b6b93500f0"));
      })
      .finally(() => { if (!cancelled) setAIGroupsLoading(false); });
    return () => { cancelled = true; };
  }, [supportsAI]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/market/storage/locations', { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json() as { locations?: StorageLocation[]; defaultPool?: string; error?: string };
        if (!response.ok || !payload.locations?.length) throw new Error(payload.error || translateInterface("mcd3adbb05399"));
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        setStorageLocations(payload.locations!);
        setStoragePool(payload.defaultPool || payload.locations![0].id);
        setStorageError('');
      })
      .catch((error) => {
        if (!cancelled) setStorageError(error instanceof Error ? error.message : translateInterface("mcd3adbb05399"));
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

  const installDisabled =
    !displayName.trim() ||
    !subdomain.trim() ||
    !directSourceAccepted ||
    !setupFilesAllowed ||
    (supportsAI && useAISettings && (aiGroupsLoading || !aiGroupId || Boolean(aiGroupsError))) ||
    storageLoading || !storagePool || Boolean(storageError);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (installDisabled) return;
    if (!retainedData || (retainedData.retained && (!retainedData.canAdopt || !adoptRetainedData))) return;

    const trimmedName = displayName.trim();
    const selectedIntegrations = (app.integrations ?? [])
      .filter((integration) => integration.required || integrationToggles[integration.id])
      .map((integration) => integration.id);

    onInstall({
      appId: app.id,
      adoptRetainedData: retainedData.retained ? adoptRetainedData : undefined,
      catalogKey: app.catalogKey,
      sourceId: app.sourceId,
      sourceName: app.sourceName,
      sourceRepoUrl: app.sourceRepoUrl,
      acceptUnverifiedPublisher: isDirectEntry ? directSourceAccepted : undefined,
      allowSetup: needsSetupApproval ? setupFilesAllowed : undefined,
      manifestPath: app.manifestPath,
      manifestRepo: app.manifestRepo,
      manifestBranch: app.manifestBranch,
      manifestDigest: app.manifestDigest,
      subdomain: subdomain.trim().toLowerCase(),
      domain,
      customName: trimmedName !== app.name ? trimmedName : undefined,
      selectedIntegrations: (app.integrations?.length ?? 0) > 0 ? selectedIntegrations : undefined,
      protectWithAccountLogin,
      forwardAuthGate,
      publicAccess: offersPublicAccess ? publicAccess : undefined,
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
            <p className="mt-1 text-sm text-gray-500">{translateInterface("m6ebd2f3388ea")}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-600"
            aria-label={translateInterface("m7d9eb7acb13e")}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-6 overflow-y-auto">
          {retainedData?.retained && (
            <Alert>
              <AlertTitle>{translateInterface("m9d7821eaa7d7")}</AlertTitle>
              <AlertDescription>
                <p>{translateInterface("m502211a79754", {version: retainedData.version || translateInterface("ma191bf55dd89")})}</p>
                {retainedData.canAdopt ? (
                  <label className="mt-3 flex items-center gap-2">
                    <input type="checkbox" checked={adoptRetainedData} onChange={event => setAdoptRetainedData(event.target.checked)} />
                    {translateInterface("mc6c504da789d")}</label>
                ) : <p className="mt-2">{translateInterface("mb6d7676c3f6f")}</p>}
              </AlertDescription>
            </Alert>
          )}
          {isDirectEntry && (
            <Alert>
              <ShieldOff className="h-4 w-4" />
              <AlertTitle>{translateInterface("m9bb143fefd58")}</AlertTitle>
              <AlertDescription>
                <p>{translateInterface("m0831254a1909")}</p>
                <label className="mt-2 flex cursor-pointer items-center gap-2 text-foreground">
                  <Switch checked={directSourceAccepted} onCheckedChange={setDirectSourceAccepted} />
                  {translateInterface("m1dbfa29a7696")}</label>
              </AlertDescription>
            </Alert>
          )}
          {setupFiles.length > 0 && (
            <section className="space-y-2" aria-labelledby="install-setup-files">
              <h3 id="install-setup-files" className="text-sm font-semibold text-foreground">{translateInterface("m8977bde3d0f7")}</h3>
              <p className="text-sm text-muted-foreground">{translateInterface("m41a1b4787986")}</p>
              <ul className="space-y-1 rounded-lg border bg-muted/30 p-3 text-sm">
                {setupFiles.map((setup) => (
                  <li key={setup.name} className="flex items-center justify-between gap-3">
                    <span className="font-mono text-xs">{setup.name}</span>
                    <span className="text-muted-foreground">{setupPurpose(setup.for)}</span>
                  </li>
                ))}
              </ul>
              {needsSetupApproval && (
                <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                  <input type="checkbox" checked={setupFilesAllowed} onChange={(event) => setSetupFilesAllowed(event.target.checked)} />
                  {translateInterface("m2514aaccdb83")}</label>
              )}
            </section>
          )}
          <section className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">{translateInterface("m8fdd2ee8475e")}</h3>
              <p className="mt-1 text-sm text-gray-500">{translateInterface("m329fb0a6938f")}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="displayName" className="flex items-center gap-1.5">
                  <Type className="h-3.5 w-3.5 text-gray-500" />
                  {translateInterface("m2b7f6a84de91")}</Label>
                <Input
                  id="displayName"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={app.name}
                  required
                />
                <p className="text-xs text-gray-400">{translateInterface("m97d84663c998")}</p>
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
                    title={translateInterface("mc8b461e5a53f")}
                  />
                  <span className="text-sm text-gray-400 whitespace-nowrap">.{domain}</span>
                </div>
                <p className="text-xs text-gray-400">
                  {translateInterface("m08a626105319")}<span className="font-mono text-gray-600 dark:text-gray-300">{fullUrl}</span>
                </p>
              </div>
            </div>
          </section>

          {storageLocations.length > 1 && (
            <section className="space-y-3">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <HardDrive className="size-4 text-primary" />
                  {translateInterface("ma59e289477fe")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{translateInterface("mb610c62d2252")}</p>
              </div>
              <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
                <Select value={storagePool} onValueChange={setStoragePool} disabled={storageLoading}>
                  <SelectTrigger aria-label={translateInterface("ma59e289477fe")}>
                    <SelectValue placeholder={translateInterface("mcaece0c6a771")} />
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
                  {showStorageAdvanced ? translateInterface("mdbde3782f540") : translateInterface("mf74b747f16b9")}
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
              <h3 className="text-sm font-semibold text-gray-900">{translateInterface("mec5ba0abb717")}</h3>
              <p className="mt-1 text-sm text-gray-500">{translateInterface("m727abb1e0536")}</p>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-gray-50/60 p-4">
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 rounded-md p-2 ${protectWithAccountLogin ? 'bg-blue-50 text-blue-600' : 'bg-white text-gray-400'}`}>
                  {protectWithAccountLogin ? <ShieldCheck className="h-4 w-4" /> : <ShieldOff className="h-4 w-4" />}
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {(app.supportsSSO || loginIntegration) ? translateInterface("m9696eb03a395") : translateInterface("m659fff76f687", { value0: String(siteName) })}
                  </p>
                  <p className="mt-1 text-xs text-gray-500">
                    {(app.supportsSSO || loginIntegration)
                      ? translateInterface("m58ce1fed0ab1", { value0: String(siteName) })
                      : app.forwardAuth === 'disabled'
                        ? translateInterface("mf87c41b17f22")
                        : translateInterface("meb2a62b44094", { value0: String(siteName) })}
                  </p>
                  <p className="mt-1 text-xs text-gray-400">
                    {translateInterface("me3904ac31cbf")}{accountLoginDefault ? translateInterface("m130011756125") : translateInterface("mca7981b46ecf")}
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
                <h3 className="text-sm font-semibold text-gray-900">{translateInterface("m5409213a3a49")}</h3>
                <p className="mt-1 text-sm text-gray-500">
                  {translateInterface("m8ab486d9fa85", {site: siteName})}
                </p>
              </div>
              <div className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-gray-50/60 p-4">
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 rounded-md p-2 ${forwardAuthGate ? 'bg-blue-50 text-blue-600' : 'bg-white text-gray-400'}`}>
                    {forwardAuthGate ? <ShieldCheck className="h-4 w-4" /> : <ShieldOff className="h-4 w-4" />}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{translateInterface("mc664ff9c2740", {site: siteName})}</p>
                    <p className="mt-1 text-xs text-gray-500">
                      {translateInterface("m59829f8776db", {site: siteName})}
                    </p>
                    <p className="mt-1 text-xs text-gray-400">{translateInterface("m092f0f6c78e1")}</p>
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

          {offersPublicAccess && (
            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">{translateInterface("m03e7db61b2e1")}</h3>
                <p className="mt-1 text-sm text-gray-500">
                  {translateInterface("m7abb883ab0c4", {name: app.name, site: siteName})}
                </p>
              </div>
              <div className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-gray-50/60 p-4">
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 rounded-md p-2 ${publicAccess ? 'bg-amber-50 text-amber-600' : 'bg-blue-50 text-blue-600'}`}>
                    {publicAccess ? <ShieldOff className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{translateInterface("ma05ac86e60af")}</p>
                    <p className="mt-1 text-xs text-gray-500">{translateInterface("m9fe9ebe58220")}</p>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={publicAccess}
                  onClick={() => setPublicAccess((v) => !v)}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                    publicAccess ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                      publicAccess ? 'translate-x-6' : 'translate-x-1'
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
                    {translateInterface("m35b8cb8439d7")}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {translateInterface("m8504669be16b", {app: app.name})}
                  </p>
                </div>
                <Switch
                  checked={useAISettings}
                  onCheckedChange={setUseAISettings}
                  aria-label={translateInterface("m18ff0c26ee4a")}
                />
              </div>
              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">{translateInterface("m18ff0c26ee4a")}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {useAISettings
                        ? translateInterface("md1a34cdcce56", { value0: String(app.name) })
                        : translateInterface("m2f3bac5071c5", { value0: String(app.name) })}
                    </p>
                  </div>
                  <Badge variant={useAISettings ? 'default' : 'secondary'}>
                    {useAISettings ? translateInterface("m130011756125") : translateInterface("mca7981b46ecf")}
                  </Badge>
                </div>
                {useAISettings && (
                  <div className="mt-4 space-y-2">
                    <Label htmlFor="ai-model-group">{translateInterface("madb24ff365bd")}</Label>
                    <Select value={aiGroupId} onValueChange={setAIGroupId} disabled={aiGroupsLoading}>
                      <SelectTrigger id="ai-model-group">
                        <SelectValue placeholder={aiGroupsLoading ? translateInterface("m2f1fe94eeb19") : translateInterface("m0c7e5871a4e6")} />
                      </SelectTrigger>
                      <SelectContent>
                        {aiGroups.map((group) => (
                          <SelectItem key={group.id} value={group.id} disabled={group.status === 'empty'}>
                            {translateInterface("m0b7c0ace70d0", {group: group.name, count: group.enabledModelCount})}{group.isDefault ? translateInterface("m2a7e0b7b2062") : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {aiGroupsError && <Alert variant="destructive">{aiGroupsError}</Alert>}
                    {aiGroups.find((group) => group.id === aiGroupId)?.unavailableRouteCount ? (
                      <Alert variant="destructive">{translateInterface("m8b198f2376e2")}</Alert>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {translateInterface("m6da71dfecc65", {app: app.name})}
                    </p>
                  </div>
                )}
              </div>
            </section>
          )}

          {(app.integrations?.filter((integration) => integration.id !== loginIntegration?.id).length ?? 0) > 0 && (
            <div className="space-y-3">
              <Label className="flex items-center gap-1.5">
                <Plug className="h-3.5 w-3.5 text-gray-500" />
                {translateInterface("m090512d93fcc")}</Label>
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
              {translateInterface("m06b77df118c5")}</Label>
            <div className="flex items-center justify-between rounded-lg border border-gray-100 dark:border-gray-800 p-3">
              <div>
                <p className="text-sm font-medium">{translateInterface("m605a35f5d0ad")}</p>
                <p className="text-xs text-gray-400">
                  {translateInterface("m5deb703324dd")}
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
            <Button type="submit" className="flex-1" disabled={installDisabled || !retainedData
              || (retainedData.retained && (!retainedData.canAdopt || !adoptRetainedData))}>
              {t('install')} {displayName || app.name}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

