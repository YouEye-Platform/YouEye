'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Globe, ChevronDown, ChevronUp, ArrowLeft, ArrowRight, AlertTriangle,
  Lock, ShieldAlert, Upload, Check, Copy, Loader2, ShieldCheck,
  RotateCcw, Sparkles, RefreshCw, Info, KeyRound, Cloud,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { TLD_OPTIONS } from '@/lib/wordart-presets';
import { useTranslations } from 'next-intl';
import { acceptRegistrationProof, runNamesEnrollment } from '@/lib/youeye-names/popup';

export type TlsChoice = 'youeye-names' | 'byo-provider' | 'letsencrypt' | 'selfsigned' | 'upload';

type AcmePhase = 'choice' | 'records' | 'verifying' | 'done';

interface DnsChallenge {
  domain: string;
  txtName: string;
  txtValue: string;
}

interface NamePreview {
  name: string;
  fqdn: string;
  wildcardFqdn: string;
  available: boolean;
}

interface NamesDisclosure {
  terms: {
    version: string;
    summary: string;
    certificateTransparencyRequired: true;
  };
  privacy: {
    version: string;
    accountRequired: boolean;
    rawSourceIpStoredByApplication: boolean;
    certificateTransparencyPublic: boolean;
    rotatingAbuseIdentifiers: { individualIpHours: number; subnetDays: number };
  };
  service?: { privacyPolicyUrl?: string };
}

interface NamesReadinessView {
  reachable: boolean;
  service?: { managedZone: string };
  readiness?: {
    installation: {
      canProceedNow: boolean;
      state: 'ready' | 'challenge' | 'degraded' | 'paused' | 'blocked';
      reasonCodes: string[];
    };
    dns?: { state: string };
    initialCertificate?: {
      primary: { provider: string; state: string };
      fallback: { provider: string; state: string };
    };
  };
  error?: string;
}

interface DomainReuseSummary {
  reuse: boolean;
  domain: string | null;
  provider: { id: string; zoneName: string } | null;
  hasDnsToken: boolean;
  expiresAt: string | null;
  certValid: boolean;
}

interface Props {
  siteName: string;
  setSiteName: (v: string) => void;
  domainSlug: string;
  setDomainSlug: (v: string) => void;
  tld: string;
  setTld: (v: string) => void;
  customTld: string;
  setCustomTld: (v: string) => void;
  subdomains: Record<string, string>;
  setSubdomains: (v: Record<string, string>) => void;
  identityName: string;
  setIdentityName: (v: string) => void;
  tlsChoice: TlsChoice;
  setTlsChoice: (v: TlsChoice) => void;
  acmeCertIssued: boolean;
  setAcmeCertIssued: (v: boolean) => void;
  /** Chosen YouEye Names subdomain (e.g. "quiet-wood-9e"). */
  yenName: string;
  setYenName: (v: string) => void;
  yenFqdn: string;
  setYenFqdn: (v: string) => void;
  yenTermsVersion: string;
  setYenTermsVersion: (v: string) => void;
  yenCtAccepted: boolean;
  setYenCtAccepted: (v: boolean) => void;
  setYenReusing?: (v: boolean) => void;
  byoDomain: string;
  setByoDomain: (v: string) => void;
  byoProviderToken: string;
  setByoProviderToken: (v: string) => void;
  onNext: () => void;
  onBack: () => void;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function isLocalDomain(tld: string): boolean {
  return /^\.(local|test|internal|lan|home|localhost|invalid|example)$/i.test(tld);
}

function normalizeHostnameInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return parsed.hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return trimmed.replace(/^https?:\/\//, '').split('/')[0].toLowerCase().replace(/\.+$/, '');
  }
}

function isLocalHostname(hostname: string): boolean {
  const normalized = normalizeHostnameInput(hostname);
  if (!normalized) return false;
  if (normalized === 'localhost') return true;
  const labels = normalized.split('.');
  if (labels.length < 2) return true;
  return isLocalDomain(`.${labels[labels.length - 1]}`);
}

async function readSetupJson(response: Response, fallback: string): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    const text = await response.text().catch(() => '');
    const looksLikeLoginPage = response.redirected || response.url.includes('/login') || text.trim().startsWith('<!DOCTYPE');
    if (looksLikeLoginPage || contentType.toLowerCase().includes('text/html')) {
      throw new Error('Setup session expired. Refresh setup and sign in again.');
    }
    throw new Error(`${fallback} (${response.status})`);
  }

  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    throw new Error(`${fallback} returned an unreadable response`);
  }
}

export default function SetupServerName({
  siteName, setSiteName,
  domainSlug, setDomainSlug,
  tld, setTld,
  customTld, setCustomTld,
  subdomains, setSubdomains,
  identityName, setIdentityName,
  tlsChoice, setTlsChoice,
  acmeCertIssued, setAcmeCertIssued,
  yenName, setYenName,
  yenFqdn, setYenFqdn,
  yenTermsVersion, setYenTermsVersion,
  yenCtAccepted, setYenCtAccepted,
  setYenReusing,
  byoDomain, setByoDomain,
  byoProviderToken, setByoProviderToken,
  onNext, onBack,
}: Props) {
  const t = useTranslations('setup');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [identityEdited, setIdentityEdited] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const isCustomTld = tld === '__custom__';

  // ── YouEye Names preview cycle (non-committing — no cert here) ──
  const [yenOptions, setYenOptions] = useState<NamePreview[]>([]);
  const [yenIndex, setYenIndex] = useState(0);
  const [yenLoading, setYenLoading] = useState(false);
  const [yenError, setYenError] = useState('');
  const currentYen = yenOptions[yenIndex];
  const [yenDisclosure, setYenDisclosure] = useState<NamesDisclosure | null>(null);
  const [yenReadiness, setYenReadiness] = useState<NamesReadinessView | null>(null);
  const [yenRegistered, setYenRegistered] = useState(false);
  // Reuse: a bundle staged by the installer (--names-bundle) locks the address.
  const [reusing, setReusing] = useState(false);

  // ACME inline flow state (the "connect your own domain" path)
  const [acmePhase, setAcmePhase] = useState<AcmePhase>('choice');
  const [acmeOrderId, setAcmeOrderId] = useState('');
  const [acmeChallenges, setAcmeChallenges] = useState<DnsChallenge[]>([]);
  const [acmeLoading, setAcmeLoading] = useState(false);
  const [acmeError, setAcmeError] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [includeWildcard, setIncludeWildcard] = useState(true);
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerValid, setProviderValid] = useState(false);
  const [providerError, setProviderError] = useState('');
  const [providerZone, setProviderZone] = useState('');
  const [domainReuse, setDomainReuse] = useState<DomainReuseSummary | null>(null);

  // Auto-fill domain slug from site name (for the own-domain path)
  useEffect(() => {
    if (!slugEdited) setDomainSlug(slugify(siteName));
  }, [siteName, slugEdited, setDomainSlug]);

  // Auto-fill identity provider name.
  useEffect(() => {
    if (!identityEdited) {
      setIdentityName(siteName ? `${siteName} ID` : 'Identity Provider');
    }
  }, [siteName, identityEdited, setIdentityName]);

  const fetchPreviews = useCallback(async () => {
    setYenLoading(true);
    setYenError('');
    try {
      const csrfRes = await fetch('/api/auth/csrf');
      const { csrfToken } = await csrfRes.json();
      const res = await fetch('/api/tls/youeye-names/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ count: 3 }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('yenError'));
      const opts: NamePreview[] = (data.previews || []).filter((p: NamePreview) => p.available);
      if (!opts.length) throw new Error(t('yenError'));
      setYenOptions(opts);
      setYenIndex(0);
    } catch (e) {
      setYenError(
        e instanceof Error
          ? (e.name === 'TimeoutError' ? t('yenError') : e.message)
          : t('yenError'),
      );
    } finally {
      setYenLoading(false);
    }
  }, [t]);

  const startNamesEnrollment = useCallback(async () => {
    if (yenReadiness?.readiness && !yenReadiness.readiness.installation.canProceedNow) {
      setYenError('YouEye Names cannot start a new address right now. Try again later or choose another address option.');
      return;
    }
    setYenLoading(true);
    setYenError('');
    try {
      await runNamesEnrollment('install_register', { accept: acceptRegistrationProof });
      setYenRegistered(true);
      await fetchPreviews();
    } catch (error) {
      setYenError(error instanceof Error ? error.message : 'Could not verify this installation.');
    } finally {
      setYenLoading(false);
    }
  }, [fetchPreviews, yenReadiness]);

  useEffect(() => {
    let active = true;
    fetch('/api/tls/youeye-names/readiness', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as NamesReadinessView;
        if (!active) return;
        setYenReadiness(body);
      })
      .catch(() => {
        if (active) setYenReadiness({ reachable: false, error: 'Could not reach YouEye Names.' });
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    fetch('/api/tls/youeye-names/disclosure', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load the YouEye Names notice.');
        return data as NamesDisclosure;
      })
      .then((data) => {
        if (!active) return;
        setYenDisclosure(data);
        setYenTermsVersion(data.terms.version);
      })
      .catch((error) => {
        if (active) setYenError(error instanceof Error ? error.message : 'Could not load the YouEye Names notice.');
      });
    return () => { active = false; };
  }, [setYenTermsVersion]);

  // Check once for a staged reuse bundle (installer --names-bundle).
  useEffect(() => {
    let active = true;
    fetch('/api/tls/youeye-names/reuse')
      .then((r) => r.json())
      .then((d) => {
        if (active && d?.reuse && d.name && d.fqdn) {
          setReusing(true);
          setYenReusing?.(true);
          setYenName(d.name);
          setYenFqdn(d.fqdn);
        }
      })
      .catch(() => {})
    return () => { active = false; };
  }, [setYenFqdn, setYenName, setYenReusing]);

  // Check once for a staged BYO domain bundle (installer --domain-bundle).
  useEffect(() => {
    let active = true;
    fetch('/api/tls/domain/reuse')
      .then((r) => r.json())
      .then((d: DomainReuseSummary) => {
        if (!active || !d?.reuse || !d.domain) return;
        setDomainReuse(d);
        setByoDomain(d.domain);
        setTlsChoice('byo-provider');
        setProviderZone(d.provider?.zoneName || '');
        setProviderValid(!!d.hasDnsToken);
        setProviderError('');
      })
      .catch((error) => { console.warn('[setup] Could not check staged BYO domain bundle:', error); });
    return () => { active = false; };
  }, [setByoDomain, setTlsChoice]);

  // Keep the lifted name in sync with the shown address.
  useEffect(() => {
    if (currentYen) {
      setYenName(currentYen.name);
      setYenFqdn(currentYen.fqdn);
    }
  }, [currentYen, setYenFqdn, setYenName]);

  const refreshYen = () => {
    if (yenRegistered) void fetchPreviews();
    else void startNamesEnrollment();
  };

  const effectiveTld = isCustomTld ? (customTld.startsWith('.') ? customTld : `.${customTld}`) : tld;
  const ownDomain = `${domainSlug}${effectiveTld}`;
  const isRealTld = isCustomTld
    ? !isLocalDomain(effectiveTld)
    : TLD_OPTIONS.find(opt => opt.value === tld)?.group === 'real';
  const isLocal = isCustomTld ? isLocalDomain(effectiveTld) : isLocalDomain(tld);

  const acmeInProgress = tlsChoice === 'letsencrypt' && acmePhase !== 'choice' && !acmeCertIssued;
  const providerDomain = normalizeHostnameInput(byoDomain);
  const manualLetsEncryptIsLocal = tlsChoice === 'byo-provider'
    ? (providerDomain ? isLocalHostname(providerDomain) : false)
    : isLocal;
  const usingStagedDomainToken = !!(
    domainReuse?.reuse &&
    domainReuse.hasDnsToken &&
    domainReuse.domain === providerDomain
  );

  const canProceed = siteName.trim().length > 0 && (
    tlsChoice === 'youeye-names'
      ? (reusing
          ? !!yenName && !!yenFqdn
          : !!currentYen && !!yenDisclosure && !!yenTermsVersion && yenCtAccepted &&
            yenReadiness?.readiness?.installation.canProceedNow === true)
      : tlsChoice === 'byo-provider'
        ? providerDomain.length > 0 && (usingStagedDomainToken || byoProviderToken.trim().length > 0)
        : domainSlug.length > 0 && (!isCustomTld || customTld.length > 0)
  );

  const carryProviderDomainToManualCertificate = () => {
    if (!providerDomain) return;
    const lastDot = providerDomain.lastIndexOf('.');
    if (lastDot <= 0) return;

    const slug = providerDomain.slice(0, lastDot);
    const suffix = `.${providerDomain.slice(lastDot + 1)}`;
    setSlugEdited(true);
    setDomainSlug(slug);
    if (TLD_OPTIONS.some(opt => opt.value === suffix)) {
      setTld(suffix);
      setCustomTld('');
    } else {
      setTld('__custom__');
      setCustomTld(providerDomain.slice(lastDot + 1));
    }
  };

  const selectOwn = (choice: Exclude<TlsChoice, 'youeye-names'>) => {
    if (choice === 'letsencrypt' && tlsChoice === 'byo-provider') {
      carryProviderDomainToManualCertificate();
    }
    setAcmePhase('choice');
    setAcmeOrderId('');
    setAcmeChallenges([]);
    setAcmeError('');
    setAcmeCertIssued(false);
    setProviderError('');
    setProviderValid(false);
    setProviderZone('');
    setTlsChoice(choice);
  };

  const backToYouEyeNames = () => {
    setAcmePhase('choice');
    setAcmeCertIssued(false);
    setAcmeError('');
    setTlsChoice('youeye-names');
  };

  const resetAcmeFlow = () => {
    setAcmePhase('choice');
    setAcmeOrderId('');
    setAcmeChallenges([]);
    setAcmeError('');
    setAcmeCertIssued(false);
  };

  const copyText = (text: string, idx: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(idx);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const handleStartAcme = async () => {
    setAcmeLoading(true);
    setAcmeError('');
    try {
      const csrfRes = await fetch('/api/auth/csrf');
      const { csrfToken } = await csrfRes.json();
      const res = await fetch('/api/tls/acme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ domain: ownDomain, includeWildcard }),
        signal: AbortSignal.timeout(35_000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start order');
      setAcmeOrderId(data.orderId);
      setAcmeChallenges(data.challenges);
      setAcmePhase('records');
    } catch (e) {
      const msg = e instanceof Error
        ? (e.name === 'TimeoutError'
          ? "Request timed out — Let's Encrypt may be rate-limiting this domain. Try again later or use a self-signed certificate."
          : e.message)
        : 'Failed to start ACME order';
      setAcmeError(msg);
    } finally {
      setAcmeLoading(false);
    }
  };

  const handleVerifyAcme = async () => {
    setAcmeLoading(true);
    setAcmeError('');
    setAcmePhase('verifying');
    try {
      const csrfRes = await fetch('/api/auth/csrf');
      const { csrfToken } = await csrfRes.json();
      const res = await fetch('/api/tls/acme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ orderId: acmeOrderId }),
        signal: AbortSignal.timeout(65_000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed');
      setAcmePhase('done');
      setAcmeCertIssued(true);
    } catch (e) {
      const msg = e instanceof Error
        ? (e.name === 'TimeoutError'
          ? "Verification timed out — Let's Encrypt may be slow or rate-limiting. Your DNS records are still valid; try again in a few minutes."
          : e.message)
        : 'ACME verification failed';
      setAcmeError(msg);
      setAcmePhase('records');
    } finally {
      setAcmeLoading(false);
    }
  };

  const handleValidateProvider = async (): Promise<boolean> => {
    if (usingStagedDomainToken) {
      setProviderValid(true);
      return true;
    }
    setProviderLoading(true);
    setProviderError('');
    setProviderValid(false);
    setProviderZone('');
    try {
      const csrfRes = await fetch('/api/auth/csrf');
      const csrfData = await readSetupJson(csrfRes, 'Could not read setup session');
      const csrfToken = typeof csrfData.csrfToken === 'string' ? csrfData.csrfToken : '';
      if (!csrfToken) throw new Error('Setup session expired. Refresh setup and sign in again.');
      const res = await fetch('/api/dns-providers/cloudflare/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ domain: providerDomain, token: byoProviderToken }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = await readSetupJson(res, 'Cloudflare connection failed');
      if (!res.ok || data.ok !== true) {
        throw new Error(typeof data.error === 'string' ? data.error : 'Cloudflare connection failed');
      }
      const zone = data.zone && typeof data.zone === 'object'
        ? data.zone as { name?: unknown }
        : null;
      setProviderValid(true);
      setProviderZone(typeof zone?.name === 'string' ? zone.name : '');
      return true;
    } catch (e) {
      const msg = e instanceof Error
        ? (e.name === 'TimeoutError' ? 'Cloudflare validation timed out. Check the token and try again.' : e.message)
        : 'Cloudflare connection failed';
      setProviderError(msg);
      return false;
    } finally {
      setProviderLoading(false);
    }
  };

  const handleContinue = async () => {
    if (tlsChoice === 'byo-provider' && !providerValid) {
      const ok = await handleValidateProvider();
      if (!ok) return;
      onNext();
      return;
    }
    if (tlsChoice === 'letsencrypt' && !acmeCertIssued) {
      handleStartAcme();
      return;
    }
    onNext();
  };

  const onYouEyeNames = tlsChoice === 'youeye-names';

  return (
    <div className="w-full max-w-md mx-auto space-y-6">
      {/* Header */}
      <div className="text-center animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-5">
          <Globe className="h-8 w-8 text-primary" />
        </div>
        <h1 className="text-2xl font-bold mb-2">{t('nameYourServer')}</h1>
        <p className="text-muted-foreground text-sm">{t('nameYourServerDesc')}</p>
      </div>

      {/* Server Name (display) */}
      <div className="space-y-2 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-75">
        <Label htmlFor="siteName">{t('serverName')}</Label>
        <Input
          id="siteName"
          value={siteName}
          onChange={e => setSiteName(e.target.value)}
          placeholder="My Server"
          className="text-lg h-12"
          autoFocus
          disabled={acmeInProgress}
        />
      </div>

      {/* ── PRIMARY: YouEye Names address ── */}
      {onYouEyeNames && (
        <div className="space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-150">
          <div className="flex items-center justify-between">
            <Label>{reusing ? t('yenReuseLabel') : t('yenLabel')}</Label>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
              {reusing ? t('yenReuseBadge') : t('recommended')}
            </span>
          </div>

          {yenReadiness && (
            <div className="flex items-start gap-2 rounded-lg border bg-card px-3 py-2 text-xs">
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                !yenReadiness.reachable || !yenReadiness.readiness?.installation.canProceedNow
                  ? 'bg-red-500'
                  : yenReadiness.readiness.installation.state === 'degraded'
                    ? 'bg-amber-500'
                    : 'bg-green-500'
              }`} />
              <div>
                <p className="font-medium text-foreground">
                  {!yenReadiness.reachable
                    ? 'YouEye Names is offline'
                    : yenReadiness.readiness?.installation.state === 'degraded'
                      ? 'Available with reduced redundancy'
                      : yenReadiness.readiness?.installation.canProceedNow
                        ? `Available for ${yenReadiness.service?.managedZone || 'your secure address'}`
                        : 'New addresses are paused'}
                </p>
                {yenReadiness.readiness?.installation.state === 'degraded' && (
                  <p className="mt-0.5 text-muted-foreground">Setup may continue; the service will use its available DNS and certificate paths.</p>
                )}
                {!yenReadiness.reachable && <p className="mt-0.5 text-muted-foreground">Choose another address option or try again later.</p>}
              </div>
            </div>
          )}

          <div className="rounded-xl border border-primary/40 bg-primary/[0.04] ring-1 ring-primary/20 p-4">
            {reusing ? (
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/10 shrink-0">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                </div>
                <p className="font-mono text-base font-medium truncate" title={yenFqdn}>
                  {yenFqdn}
                </p>
              </div>
            ) : yenError ? (
              <p className="text-sm text-amber-700 dark:text-amber-300">{yenError}</p>
            ) : yenOptions.length > 0 ? (
              <div className="space-y-2" role="radiogroup" aria-label="Choose your YouEye address">
                {yenOptions.map((option, index) => (
                  <button
                    key={option.fqdn}
                    type="button"
                    role="radio"
                    aria-checked={yenIndex === index}
                    onClick={() => setYenIndex(index)}
                    className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${yenIndex === index ? 'border-primary bg-background shadow-sm' : 'border-border/70 hover:bg-background/60'}`}
                  >
                    <span className={`flex h-4 w-4 items-center justify-center rounded-full border ${yenIndex === index ? 'border-primary' : 'border-muted-foreground/50'}`}>
                      {yenIndex === index && <span className="h-2 w-2 rounded-full bg-primary" />}
                    </span>
                    <span className="truncate font-mono text-sm font-medium">{option.fqdn}</span>
                  </button>
                ))}
                <Button type="button" variant="ghost" size="sm" onClick={refreshYen} disabled={yenLoading} className="w-full gap-2">
                  <RefreshCw className={`h-3.5 w-3.5 ${yenLoading ? 'animate-spin' : ''}`} />
                  Show other names
                </Button>
              </div>
            ) : yenLoading ? (
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Verification is in progress…
              </p>
            ) : (
              <Button
                type="button"
                onClick={() => void startNamesEnrollment()}
                disabled={yenReadiness?.readiness?.installation.canProceedNow === false || yenReadiness?.reachable === false}
                className="w-full gap-2"
              >
                <ShieldCheck className="h-4 w-4" /> Get a secure address
              </Button>
            )}
            <p className="text-xs text-muted-foreground mt-3 flex items-start gap-1.5">
              <Sparkles className="h-3.5 w-3.5 mt-0.5 shrink-0 text-primary/70" />
              <span>{reusing ? t('yenReuseNote') : t('yenDesc')}</span>
            </p>
          </div>

          {!reusing && yenDisclosure && (
            <div className="rounded-xl border bg-card p-4 text-xs text-muted-foreground">
              <label className="flex cursor-pointer items-start gap-3 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={yenCtAccepted}
                  onChange={(event) => setYenCtAccepted(event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
                />
                <span>
                  I understand that this public address and its certificates appear in public Certificate Transparency logs.
                </span>
              </label>
              <details className="mt-3">
                <summary className="cursor-pointer font-medium text-foreground">Privacy and certificate notice</summary>
                <div className="mt-2 space-y-1.5 leading-relaxed">
                  <p>{yenDisclosure.terms.summary}</p>
                  <p>No account is required. The service does not store your raw source IP in application records; short-lived rotating abuse identifiers are retained for {yenDisclosure.privacy.rotatingAbuseIdentifiers.individualIpHours} hours per address and {yenDisclosure.privacy.rotatingAbuseIdentifiers.subnetDays} days per subnet.</p>
                  <p>Notice {yenDisclosure.privacy.version} · certificate terms {yenDisclosure.terms.version}</p>
                  {yenDisclosure.service?.privacyPolicyUrl && (
                    <p><a className="underline" href={yenDisclosure.service.privacyPolicyUrl} target="_blank" rel="noreferrer">Read the full privacy notice</a></p>
                  )}
                </div>
              </details>
            </div>
          )}

          {/* Secondary options — buttons underneath (hidden when reusing) */}
          {!reusing && (
            <div className="pt-1">
              <p className="text-xs text-muted-foreground mb-2">{t('yenOtherOptions')}</p>
              <div className="grid gap-2">
                <SecondaryOption icon={Cloud} label={t('tlsOwnDomain')} onClick={() => selectOwn('byo-provider')} />
                <SecondaryOption icon={ShieldAlert} label={t('tlsSelfSigned')} onClick={() => selectOwn('selfsigned')} />
                <SecondaryOption icon={Upload} label={t('tlsUploadOwn')} onClick={() => selectOwn('upload')} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── SECONDARY: own domain / self-signed / upload (expanded inline) ── */}
      {!onYouEyeNames && (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-300">
          {!acmeInProgress && !acmeCertIssued && (
            <button
              type="button"
              onClick={backToYouEyeNames}
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              <ArrowRight className="h-3.5 w-3.5 rotate-180" />
              {t('yenBack')}
            </button>
          )}

          {tlsChoice === 'byo-provider' ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>Your domain</Label>
                <Input
                  value={byoDomain}
                  onChange={e => { setByoDomain(e.target.value); setProviderValid(false); setProviderError(''); }}
                  placeholder="home.example.com"
                  className="text-base h-11 font-mono"
                  disabled={providerLoading || !!domainReuse?.reuse}
                />
                <p className="text-xs text-muted-foreground">YouEye will manage this name and its app subdomains.</p>
              </div>
              {domainReuse?.reuse && domainReuse.domain === providerDomain && (
                <div className="rounded-xl border border-primary/30 bg-primary/[0.04] p-4">
                  <div className="flex items-start gap-3">
                    <div className="rounded-lg bg-primary/10 p-2">
                      <ShieldCheck className="h-4 w-4 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">Domain bundle staged</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {domainReuse.certValid
                          ? `Setup will reuse the existing certificate${domainReuse.expiresAt ? `, valid until ${new Date(domainReuse.expiresAt).toLocaleDateString()}` : ''}.`
                          : 'The bundle certificate is close to expiry, so setup will issue a fresh one.'}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {domainReuse.hasDnsToken
                          ? 'The DNS token is included and will be restored into the secret store.'
                          : 'Paste a fresh provider token so DNS sync and renewal can continue.'}
                      </p>
                    </div>
                  </div>
                </div>
              )}
              <div className="rounded-xl border bg-muted/30 p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Cloudflare</p>
                    <p className="text-xs text-muted-foreground">DNS records and HTTPS validation</p>
                  </div>
                  <div className="group relative">
                    <button type="button" className="rounded-full p-1 text-muted-foreground hover:text-foreground" aria-label="Cloudflare token help">
                      <Info className="h-4 w-4" />
                    </button>
                    <div className="pointer-events-none absolute right-0 z-10 mt-2 hidden w-72 rounded-xl border bg-popover p-3 text-left text-xs text-popover-foreground shadow-lg group-hover:block">
                      <p className="font-semibold">Token steps</p>
                      <ol className="mt-2 list-decimal space-y-1 pl-4 text-muted-foreground">
                        <li>Open Cloudflare, then My Profile and API Tokens.</li>
                        <li>Create a token from the Edit zone DNS template.</li>
                        <li>Scope it to this domain&apos;s DNS zone.</li>
                        <li>Grant Zone - Zone - Read and Zone - DNS - Edit.</li>
                      </ol>
                    </div>
                  </div>
                </div>
                {usingStagedDomainToken ? (
                  <p className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-400">
                    Cloudflare token will be restored from the staged bundle.
                  </p>
                ) : (
                  <div className="space-y-2">
                    <Label className="text-xs">API token</Label>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          type="password"
                          value={byoProviderToken}
                          onChange={e => { setByoProviderToken(e.target.value); setProviderValid(false); setProviderError(''); }}
                          placeholder="Paste token"
                          className="h-10 pl-9"
                          disabled={providerLoading}
                        />
                      </div>
                      <Button type="button" variant="outline" className="h-10" disabled={!providerDomain || !byoProviderToken.trim() || providerLoading} onClick={handleValidateProvider}>
                        {providerLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                        Test
                      </Button>
                    </div>
                  </div>
                )}
                {providerValid && (
                  <p className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-400">
                    Cloudflare connected{providerZone ? ` for ${providerZone}` : ''}.
                  </p>
                )}
                {providerError && (
                  <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">{providerError}</p>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Label>{t('serverAddress')}</Label>
              <div className="flex items-center gap-0">
                <Input
                  value={domainSlug}
                  onChange={e => { setSlugEdited(true); setDomainSlug(slugify(e.target.value)); }}
                  placeholder="myserver"
                  className="rounded-r-none border-r-0 text-base h-11 font-mono flex-1"
                  disabled={acmeInProgress}
                />
                <div className="relative shrink-0">
                  <select
                    value={tld}
                    onChange={e => { e.stopPropagation(); setTld(e.target.value); }}
                    onMouseDown={e => e.stopPropagation()}
                    disabled={acmeInProgress}
                    className="h-11 rounded-l-none rounded-r-md border border-input bg-muted pl-3 pr-8 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer disabled:opacity-50"
                    style={{ WebkitAppearance: 'menulist', appearance: 'menulist' }}
                  >
                    <optgroup label="Local network">
                      {TLD_OPTIONS.filter(opt => opt.group === 'local').map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </optgroup>
                    <optgroup label="Public domains">
                      {TLD_OPTIONS.filter(opt => opt.group === 'real').map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </optgroup>
                    <optgroup label="─────────">
                      {TLD_OPTIONS.filter(opt => opt.group === 'custom').map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </optgroup>
                  </select>
                </div>
              </div>

              {isCustomTld && (
                <div className="flex items-center gap-2 animate-in fade-in slide-in-from-top-2 duration-200">
                  <span className="text-sm text-muted-foreground">.</span>
                  <Input
                    value={customTld}
                    onChange={e => setCustomTld(e.target.value.replace(/^\./, '').replace(/[^a-z0-9.-]/gi, '').replace(/\.+$/, '').toLowerCase())}
                    placeholder="example"
                    className="h-9 text-sm font-mono flex-1"
                    autoFocus
                    disabled={acmeInProgress}
                  />
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                {t('serverAddressPreview')}: <span className="font-mono font-medium">{ownDomain || '...'}</span>
              </p>
              {isRealTld && (
                <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-200">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
                  <span>{t('realDomainWarning')}</span>
                </div>
              )}
            </div>
          )}

          {/* Option cards */}
          <div className="space-y-3">
            <Label>{t('certificateChoice')}</Label>

            <OptionCard
              active={tlsChoice === 'byo-provider'}
              disabled={acmeInProgress}
              tone="blue"
              icon={Cloud}
              title="Automatic with Cloudflare"
              desc="YouEye keeps DNS and HTTPS updated for your own domain."
              onClick={() => selectOwn('byo-provider')}
            />
            <OptionCard
              active={tlsChoice === 'letsencrypt'}
              disabled={acmeInProgress || manualLetsEncryptIsLocal}
              tone="green"
              icon={Lock}
              title="Manual Let's Encrypt"
              desc={t('tlsLetsEncryptDesc')}
              note={manualLetsEncryptIsLocal ? t('tlsLetsEncryptLocalWarn') : undefined}
              onClick={() => selectOwn('letsencrypt')}
            />
            <OptionCard
              active={tlsChoice === 'selfsigned'}
              disabled={acmeInProgress}
              icon={ShieldAlert}
              title={t('tlsSelfSigned')}
              desc={t('tlsSelfSignedDesc')}
              onClick={() => selectOwn('selfsigned')}
            />
            <OptionCard
              active={tlsChoice === 'upload'}
              disabled={acmeInProgress}
              icon={Upload}
              title={t('tlsUploadOwn')}
              desc={t('tlsUploadOwnDesc')}
              onClick={() => selectOwn('upload')}
            />
          </div>

          {/* Inline ACME DNS Challenge Flow */}
          {tlsChoice === 'letsencrypt' && acmePhase === 'records' && (
            <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-300">
              <div className="space-y-1">
                <h3 className="font-semibold text-sm">{t('acmeRecordsTitle')}</h3>
                <p className="text-xs text-muted-foreground">{t('acmeRecordsDesc')}</p>
              </div>
              <div className="space-y-3">
                {acmeChallenges.map((challenge, i) => (
                  <div key={i} className="rounded-lg border bg-muted/30 p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground">TXT Record {i + 1}</span>
                      <button onClick={() => copyText(challenge.txtValue, i)} className="p-1 rounded hover:bg-muted transition-colors" title="Copy value">
                        {copiedIndex === i ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5 text-muted-foreground" />}
                      </button>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs text-muted-foreground w-12 flex-shrink-0">Name:</span>
                        <code className="text-xs bg-muted rounded px-2 py-1 break-all">{challenge.txtName}</code>
                      </div>
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs text-muted-foreground w-12 flex-shrink-0">Value:</span>
                        <code className="text-xs bg-muted rounded px-2 py-1 break-all">{challenge.txtValue}</code>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-amber-700 bg-amber-50 rounded-lg p-3 dark:bg-amber-950/30 dark:text-amber-200">{t('acmeRecordsHint')}</p>
              {acmeError && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 dark:bg-red-950/30 dark:text-red-400">{acmeError}</p>}
              <div className="flex gap-2">
                <button onClick={resetAcmeFlow} className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                  <RotateCcw className="h-3.5 w-3.5" />{t('tlsBackToChoice')}
                </button>
                <button onClick={handleVerifyAcme} disabled={acmeLoading} className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-green-600 text-white px-5 py-2.5 text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  {acmeLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{t('acmeVerify')}
                </button>
              </div>
            </div>
          )}

          {tlsChoice === 'letsencrypt' && acmePhase === 'verifying' && (
            <div className="flex items-center gap-3 py-4 animate-in fade-in duration-300">
              <Loader2 className="h-5 w-5 animate-spin text-green-600" />
              <div>
                <h3 className="font-semibold text-sm">{t('acmeVerifying')}</h3>
                <p className="text-xs text-muted-foreground">{t('acmeVerifyingDesc')}</p>
              </div>
            </div>
          )}

          {tlsChoice === 'letsencrypt' && acmeCertIssued && (
            <div className="rounded-xl border bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800 p-5 space-y-2 animate-in fade-in slide-in-from-bottom-4 duration-300">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-green-600" />
                <h3 className="font-semibold text-sm text-green-800 dark:text-green-300">{t('acmeDone')}</h3>
              </div>
              <p className="text-sm text-green-700 dark:text-green-400">{t('acmeDoneDesc')}</p>
            </div>
          )}

          {tlsChoice === 'letsencrypt' && acmePhase === 'choice' && !acmeCertIssued && (
            <label className="flex items-center gap-2 text-sm cursor-pointer animate-in fade-in duration-200">
              <input type="checkbox" checked={includeWildcard} onChange={(e) => setIncludeWildcard(e.target.checked)} className="rounded" />
              {t('acmeWildcard')}
            </label>
          )}

          {tlsChoice === 'letsencrypt' && acmePhase === 'choice' && acmeError && (
            <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 dark:bg-red-950/30 dark:text-red-400 animate-in fade-in duration-200">{acmeError}</p>
          )}
        </div>
      )}

      {/* Advanced Settings */}
      {!acmeInProgress && !acmeCertIssued && (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 delay-300">
          <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
            {t('advancedSettings')}
            {showAdvanced ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {showAdvanced && (
            <div className="mt-3 space-y-3 rounded-lg border p-4 bg-muted/30 animate-in fade-in slide-in-from-top-2 duration-200">
              <div className="space-y-2">
                <Label className="text-xs font-medium">{t('subdomains')}</Label>
                {[
                  { key: 'control', label: t('controlPanel'), placeholder: 'control' },
                  { key: 'identity', label: t('identityProvider'), placeholder: 'id' },
                  { key: 'dns', label: t('dnsPanel'), placeholder: 'dns' },
                ].map(({ key, label, placeholder }) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-24 shrink-0">{label}</span>
                    <div className="flex items-center gap-0 flex-1">
                      <Input
                        value={subdomains[key] || ''}
                        onChange={e => setSubdomains({ ...subdomains, [key]: e.target.value })}
                        placeholder={placeholder}
                        className="rounded-r-none border-r-0 h-8 text-xs font-mono"
                      />
                      <span className="h-8 flex items-center px-2 rounded-r-md border border-input bg-muted text-xs font-mono text-muted-foreground">
                        .{onYouEyeNames ? (yenFqdn || 'name') : `${domainSlug}${effectiveTld}`}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('identityProviderName')}</Label>
                <Input value={identityName} onChange={e => { setIdentityEdited(true); setIdentityName(e.target.value); }} placeholder={`${siteName || 'YouEye'} ID`} className="h-8 text-xs" />
                <p className="text-[10px] text-muted-foreground">{t('identityNameHelper')}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Next button */}
      {acmePhase !== 'records' && acmePhase !== 'verifying' && (
        <div className="flex gap-2 pt-2 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-[400ms]">
          <Button type="button" variant="outline" size="icon" onClick={onBack} title="Back">
            <ArrowLeft className="h-4 w-4" />
            <span className="sr-only">Back</span>
          </Button>
          <Button
            onClick={handleContinue}
            disabled={!canProceed || acmeLoading || providerLoading}
            className="h-12 flex-1 text-base gap-2"
          >
            {acmeLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            {providerLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            {tlsChoice === 'letsencrypt' && !acmeCertIssued
              ? t('acmeStartOrder')
              : tlsChoice === 'byo-provider' && !providerValid
                ? 'Test and continue'
                : t('continue')}
            {!acmeLoading && (tlsChoice !== 'letsencrypt' || acmeCertIssued) && <ArrowRight className="h-4 w-4" />}
          </Button>
        </div>
      )}
    </div>
  );
}

function SecondaryOption({ icon: Icon, label, onClick }: { icon: typeof Lock; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm hover:border-primary/30 hover:bg-muted/40 transition-colors"
    >
      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      <span className="flex-1">{label}</span>
      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground -rotate-90" />
    </button>
  );
}

function OptionCard({
  active, disabled, tone, icon: Icon, title, desc, note, onClick,
}: {
  active: boolean; disabled?: boolean; tone?: 'green' | 'blue'; icon: typeof Lock;
  title: string; desc: string; note?: string; onClick: () => void;
}) {
  const activeRing = tone === 'green'
    ? 'border-green-400 bg-green-50/60 ring-1 ring-green-300 dark:bg-green-950/30 dark:border-green-700'
    : tone === 'blue'
      ? 'border-primary/40 bg-primary/[0.06] ring-1 ring-primary/30'
    : 'border-primary/40 bg-muted/60 ring-1 ring-primary/30';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full text-left rounded-xl border p-4 transition-all ${
        active ? activeRing : 'hover:border-primary/30 hover:bg-muted/30'
      } ${disabled && !active ? 'opacity-50 pointer-events-none' : ''} disabled:cursor-not-allowed`}
    >
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 p-2 rounded-lg ${tone === 'green' ? 'bg-green-100 dark:bg-green-900/40' : tone === 'blue' ? 'bg-primary/10' : 'bg-muted'}`}>
          <Icon className={`h-4 w-4 ${tone === 'green' ? 'text-green-700 dark:text-green-400' : tone === 'blue' ? 'text-primary' : 'text-muted-foreground'}`} />
        </div>
        <div className="flex-1">
          <p className="font-medium text-sm">{title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
          {note && <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">{note}</p>}
        </div>
      </div>
    </button>
  );
}
