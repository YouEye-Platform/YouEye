'use client';
import {useLocale} from "next-intl";






import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useState, useEffect } from 'react';
import { ChevronRight, ShieldOff, X } from 'lucide-react';
import { MarketIcon } from '@/components/market/market-parts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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

/** The install form. An app this box cannot install (it needs a newer YouEye) never gets one. */
export function InstallDialog(props: InstallDialogProps) {
  if (props.app.installBlocked) return null;
  return <InstallDialogForm {...props} />;
}

function InstallDialogForm({ app, domain, siteName = 'YouEye', onInstall, onClose }: InstallDialogProps) {
  const translateInterface = useInterfaceTranslations("interface");
  const locale = useLocale();
function formatBytes(value: number | null): string {
  if (value === null) return translateInterface("m77b235a4e47f");
  if (value < 1024 ** 3) return translateInterface("m0cb4031e7c01", {amount: new Intl.NumberFormat(locale).format(Math.round(value / 1024 ** 2))});
  return translateInterface("m9e3fa5262cda", {amount: new Intl.NumberFormat(locale, {maximumFractionDigits: value < 10 * 1024 ** 3 ? 1 : 0}).format(value / 1024 ** 3)});
}


  const t = useTranslations('market');
  const marketStore = useInterfaceTranslations('marketStore');
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
  // An app added by URL needs one confirmation: the owner trusts its publisher and, when it has setup files, lets
  // them run. The dialog shows where it comes from, its images and its setup files.
  const [directConsent, setDirectConsent] = useState(!isDirectEntry);
  const setupFiles = app.setups ?? [];
  const needsSetupApproval = isDirectEntry && setupFiles.length > 0;
  const directHost = (() => {
    try { return app.sourceRepoUrl ? new URL(app.sourceRepoUrl).host : ''; } catch { return ''; }
  })();
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
    !directConsent ||
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
      acceptUnverifiedPublisher: isDirectEntry ? directConsent : undefined,
      allowSetup: needsSetupApproval ? directConsent : undefined,
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

  const accountLoginLabel = (app.supportsSSO || loginIntegration) ? translateInterface("m9696eb03a395") : translateInterface("m659fff76f687", { value0: String(siteName) });
  const accountLoginHint = (app.supportsSSO || loginIntegration)
    ? translateInterface("m58ce1fed0ab1", { value0: String(siteName) })
    : app.forwardAuth === 'disabled'
      ? translateInterface("mf87c41b17f22")
      : translateInterface("meb2a62b44094", { value0: String(siteName) });
  const otherIntegrations = app.integrations?.filter((integration) => integration.id !== loginIntegration?.id) ?? [];
  const internetChoice = !!connections?.internet?.needsInternet;
  const blockedByRetained = !retainedData || (retainedData.retained && (!retainedData.canAdopt || !adoptRetainedData));

  // One row of the dialog: a label, a line about it, and its switch.
  const row = (key: string, label: string, hint: string, checked: boolean, onChange: (value: boolean) => void, disabled = false, extra?: React.ReactNode) => (
    <li key={key} className="settings-item">
      <span className="settings-item-text">
        <span className="settings-item-label">{label}</span>
        <span className="settings-item-hint">{hint}</span>
      </span>
      <Switch className="shrink-0" checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
      {extra && <div className="basis-full">{extra}</div>}
    </li>
  );

  // Where and who first; everything with a sensible default (name, address, storage, network, setup files) is folded.
  // A click beside the dialog does not close it (it would throw the choices away, also when it only closes an open
  // list); Close and Cancel do.
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="install-title"
        className="flex max-h-[92dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl bg-background shadow-xl sm:rounded-2xl">
        <div className="flex shrink-0 items-start gap-3.5 border-b px-5 py-4">
          <MarketIcon app={app} size={44} />
          <div className="min-w-0 flex-1">
            <h2 id="install-title" className="text-lg font-semibold leading-tight">{t('install')} {displayName || app.name}</h2>
            <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{marketStore("install.opensAt", { address: fullUrl.replace(/^https:\/\//, '') })}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={translateInterface("m7d9eb7acb13e")}
            className="-mr-1.5 flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form id="install-form" onSubmit={handleSubmit} className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
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
              <AlertDescription className="space-y-2">
                <p>{translateInterface("m0831254a1909")}</p>
                {directHost && <p className="font-medium text-foreground">{translateInterface("mf6c7ca4ee26a", { host: directHost })}</p>}
                {(app.images?.length ?? 0) > 0 && (
                  <div>
                    <p className="font-medium text-foreground">{translateInterface("mbe7e2f201293")}</p>
                    <ul className="mt-1 space-y-0.5">
                      {app.images!.map((image) => <li key={image} className="break-all font-mono text-xs">{image}</li>)}
                    </ul>
                  </div>
                )}
                {setupFiles.length > 0 && (
                  <div>
                    <p className="font-medium text-foreground">{translateInterface("m8977bde3d0f7")}</p>
                    <p>{translateInterface("m41a1b4787986")}</p>
                    <ul className="mt-1 space-y-1 rounded-lg border bg-muted/30 p-3">
                      {setupFiles.map((setup) => (
                        <li key={setup.name} className="flex items-center justify-between gap-3">
                          <span className="font-mono text-xs">{setup.name}</span>
                          <span>{setupPurpose(setup.for)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <label className="flex cursor-pointer items-center gap-2 text-foreground">
                  <input type="checkbox" checked={directConsent} onChange={(event) => setDirectConsent(event.target.checked)} />
                  {needsSetupApproval ? translateInterface("m5ae862f2c24b") : translateInterface("m1dbfa29a7696")}</label>
              </AlertDescription>
            </Alert>
          )}

          <section aria-labelledby="install-access" className="settings-section">
            <h3 id="install-access" className="settings-section-title">{marketStore("install.access")}</h3>
            <ul className="settings-group">
              {row('account', accountLoginLabel, accountLoginHint, protectWithAccountLogin, () => toggleAccountLogin(), !!accountLoginLocked)}
              {showForwardAuthGate && row('gate', translateInterface("mc664ff9c2740", { site: siteName }), translateInterface("m59829f8776db", { site: siteName }), forwardAuthGate, setForwardAuthGate)}
              {offersPublicAccess && row('public', translateInterface("ma05ac86e60af"), translateInterface("m7abb883ab0c4", { name: app.name, site: siteName }), publicAccess, setPublicAccess)}
            </ul>
          </section>

          {(supportsAI || otherIntegrations.length > 0) && (
            <section aria-labelledby="install-uses" className="settings-section">
              <h3 id="install-uses" className="settings-section-title">{marketStore("install.uses")}</h3>
              <ul className="settings-group">
                {supportsAI && row('ai', translateInterface("m35b8cb8439d7"), translateInterface("m8504669be16b", { app: app.name }), useAISettings, setUseAISettings, false,
                  useAISettings ? (
                    <div className="space-y-2 pt-1">
                      <Label htmlFor="ai-model-group" className="text-[13px] text-muted-foreground">{translateInterface("madb24ff365bd")}</Label>
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
                    </div>
                  ) : undefined)}
                {otherIntegrations.map((integration) => row(`integration-${integration.id}`, integration.name, integration.description || '',
                  integration.required || (integrationToggles[integration.id] ?? false),
                  (value) => setIntegrationToggles((prev) => ({ ...prev, [integration.id]: value })), !!integration.required))}
              </ul>
            </section>
          )}

          {storageError && <Alert variant="destructive"><AlertDescription>{storageError}</AlertDescription></Alert>}

          <details className="group">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-4 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
              {marketStore("install.options")}
            </summary>
            <div className="mt-3 space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="displayName">{translateInterface("m2b7f6a84de91")}</Label>
                  <Input id="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={app.name} required />
                  <p className="text-xs text-muted-foreground">{translateInterface("m97d84663c998")}</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="subdomain">{t('subdomain')}</Label>
                  <div className="flex min-w-0 items-center gap-1">
                    <Input id="subdomain" value={subdomain} className="min-w-0 flex-1" required pattern="[a-z0-9-]+" title={translateInterface("mc8b461e5a53f")}
                      onChange={(e) => { setSubdomain(e.target.value); setSubdomainManuallyEdited(true); }} />
                    <span className="truncate text-sm text-muted-foreground">.{domain}</span>
                  </div>
                </div>
              </div>

              {storageLocations.length > 1 && (
                <div className="space-y-2">
                  <Label>{translateInterface("ma59e289477fe")}</Label>
                  <p className="text-xs text-muted-foreground">{translateInterface("mb610c62d2252")}</p>
                  <Select value={storagePool} onValueChange={setStoragePool} disabled={storageLoading}>
                    <SelectTrigger aria-label={translateInterface("ma59e289477fe")}>
                      <SelectValue placeholder={translateInterface("mcaece0c6a771")} />
                    </SelectTrigger>
                    <SelectContent>
                      {storageLocations.map((location) => (
                        <SelectItem key={location.id} value={location.id}>{location.name} · {formatBytes(location.availableBytes)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="ghost" size="sm" className="h-auto px-0 text-primary hover:bg-transparent hover:text-primary/80"
                    onClick={() => setShowStorageAdvanced((value) => !value)}>
                    {showStorageAdvanced ? translateInterface("mdbde3782f540") : translateInterface("mf74b747f16b9")}
                  </Button>
                  {showStorageAdvanced && (
                    <div className="grid gap-3 sm:grid-cols-3">
                      {(['config', 'data', 'media'] as const).map((type) => (
                        <div key={type} className="space-y-1.5">
                          <Label htmlFor={`storage-${type}`} className="capitalize">{type}</Label>
                          <Select value={storagePlacements[type] || storagePool} onValueChange={(value) => setStoragePlacements((current) => ({ ...current, [type]: value }))}>
                            <SelectTrigger id={`storage-${type}`}><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {storageLocations.map((location) => <SelectItem key={location.id} value={location.id}>{location.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {internetChoice && (
                <ul className="settings-group">
                  {row('internet', translateInterface("m605a35f5d0ad"), translateInterface("m5deb703324dd"), allowInternet, setAllowInternet)}
                </ul>
              )}

              {!isDirectEntry && setupFiles.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">{translateInterface("m8977bde3d0f7")}</p>
                  <p className="text-xs text-muted-foreground">{translateInterface("m41a1b4787986")}</p>
                  <ul className="space-y-1 rounded-lg border bg-muted/30 p-3 text-sm">
                    {setupFiles.map((setup) => (
                      <li key={setup.name} className="flex items-center justify-between gap-3">
                        <span className="font-mono text-xs">{setup.name}</span>
                        <span className="text-muted-foreground">{setupPurpose(setup.for)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </details>
        </form>

        <div className="flex shrink-0 gap-2 border-t px-5 py-3.5 pb-[max(.875rem,env(safe-area-inset-bottom))] sm:justify-end">
          <Button type="button" variant="outline" className="flex-1 rounded-full sm:flex-none" onClick={onClose}>{tc('cancel')}</Button>
          <Button type="submit" form="install-form" className="flex-1 rounded-full px-6 sm:flex-none" disabled={installDisabled || blockedByRetained}>
            {t('install')}
          </Button>
        </div>
      </div>
    </div>
  );
}

