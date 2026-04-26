'use client';

import { useState, useEffect } from 'react';
import {
  Globe, ChevronDown, ChevronUp, ArrowRight, AlertTriangle,
  Lock, ShieldAlert, Upload, Check, Copy, Loader2, ShieldCheck,
  RotateCcw,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { TLD_OPTIONS } from '@/lib/wordart-presets';
import { useTranslations } from 'next-intl';

export type TlsChoice = 'letsencrypt' | 'selfsigned' | 'upload';

type AcmePhase = 'choice' | 'records' | 'verifying' | 'done';

interface DnsChallenge {
  domain: string;
  txtName: string;
  txtValue: string;
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
  authentikName: string;
  setAuthentikName: (v: string) => void;
  tlsChoice: TlsChoice;
  setTlsChoice: (v: TlsChoice) => void;
  acmeCertIssued: boolean;
  setAcmeCertIssued: (v: boolean) => void;
  onNext: () => void;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function isLocalDomain(tld: string): boolean {
  return /^\.(local|test|internal|lan|home|localhost|invalid|example)$/i.test(tld);
}

export default function SetupServerName({
  siteName, setSiteName,
  domainSlug, setDomainSlug,
  tld, setTld,
  customTld, setCustomTld,
  subdomains, setSubdomains,
  authentikName, setAuthentikName,
  tlsChoice, setTlsChoice,
  acmeCertIssued, setAcmeCertIssued,
  onNext,
}: Props) {
  const t = useTranslations('setup');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [authentikEdited, setAuthentikEdited] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const isCustomTld = tld === '__custom__';

  // ACME inline flow state
  const [acmePhase, setAcmePhase] = useState<AcmePhase>('choice');
  const [acmeOrderId, setAcmeOrderId] = useState('');
  const [acmeChallenges, setAcmeChallenges] = useState<DnsChallenge[]>([]);
  const [acmeLoading, setAcmeLoading] = useState(false);
  const [acmeError, setAcmeError] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [includeWildcard, setIncludeWildcard] = useState(true);

  // Auto-fill domain slug from site name
  useEffect(() => {
    if (!slugEdited) {
      setDomainSlug(slugify(siteName));
    }
  }, [siteName, slugEdited, setDomainSlug]);

  // Auto-fill authentik name
  useEffect(() => {
    if (!authentikEdited) {
      setAuthentikName(siteName ? `${siteName} ID` : 'YouEye ID');
    }
  }, [siteName, authentikEdited, setAuthentikName]);

  const effectiveTld = isCustomTld ? (customTld.startsWith('.') ? customTld : `.${customTld}`) : tld;
  const domain = `${domainSlug}${effectiveTld}`;
  const isRealTld = isCustomTld
    ? !isLocalDomain(effectiveTld)
    : TLD_OPTIONS.find(opt => opt.value === tld)?.group === 'real';
  const isLocal = isCustomTld ? isLocalDomain(effectiveTld) : isLocalDomain(tld);
  const canProceed = siteName.trim().length > 0 && domainSlug.length > 0 && (!isCustomTld || customTld.length > 0);

  // Lock domain inputs while ACME flow is in progress (domain baked into order)
  const acmeInProgress = tlsChoice === 'letsencrypt' && acmePhase !== 'choice' && !acmeCertIssued;

  // Reset ACME state when switching away from letsencrypt
  const handleTlsChange = (choice: TlsChoice) => {
    if (choice !== 'letsencrypt') {
      setAcmePhase('choice');
      setAcmeOrderId('');
      setAcmeChallenges([]);
      setAcmeError('');
      setAcmeCertIssued(false);
    }
    setTlsChoice(choice);
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
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          domain,
          includeWildcard,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start order');

      setAcmeOrderId(data.orderId);
      setAcmeChallenges(data.challenges);
      setAcmePhase('records');
    } catch (e) {
      setAcmeError(e instanceof Error ? e.message : 'Failed to start ACME order');
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
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ orderId: acmeOrderId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed');

      setAcmePhase('done');
      setAcmeCertIssued(true);
    } catch (e) {
      setAcmeError(e instanceof Error ? e.message : 'ACME verification failed');
      setAcmePhase('records');
    } finally {
      setAcmeLoading(false);
    }
  };

  // Handle Continue button — starts ACME flow if LE selected and not yet done
  const handleContinue = () => {
    if (tlsChoice === 'letsencrypt' && !acmeCertIssued) {
      handleStartAcme();
      return;
    }
    onNext();
  };

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

      {/* Server Name */}
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

      {/* Domain */}
      <div className="space-y-2 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-150">
        <Label>{t('serverAddress')}</Label>
        <div className="flex items-center gap-0">
          <Input
            value={domainSlug}
            onChange={e => {
              setSlugEdited(true);
              setDomainSlug(slugify(e.target.value));
            }}
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

        {/* Custom TLD input */}
        {isCustomTld && (
          <div className="flex items-center gap-2 animate-in fade-in slide-in-from-top-2 duration-200">
            <span className="text-sm text-muted-foreground">.</span>
            <Input
              value={customTld}
              onChange={e => setCustomTld(e.target.value.replace(/^\./, '').replace(/[^a-z0-9.-]/gi, '').replace(/\.+$/, '').toLowerCase())}
              placeholder="wtf"
              className="h-9 text-sm font-mono flex-1"
              autoFocus
              disabled={acmeInProgress}
            />
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          {t('serverAddressPreview')}: <span className="font-mono font-medium">{domain || '...'}</span>
        </p>
        {isRealTld && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
            <span>{t('realDomainWarning')}</span>
          </div>
        )}
      </div>

      {/* ── TLS / Certificate Choice ── */}
      <div className="space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200">
        <Label>{t('certificateChoice')}</Label>

        {/* Let's Encrypt */}
        <button
          type="button"
          onClick={() => handleTlsChange('letsencrypt')}
          disabled={acmeInProgress}
          className={`w-full text-left rounded-xl border p-4 transition-all ${
            tlsChoice === 'letsencrypt'
              ? 'border-green-400 bg-green-50/60 ring-1 ring-green-300 dark:bg-green-950/30 dark:border-green-700'
              : 'hover:border-green-300 hover:bg-green-50/30'
          } ${isLocal ? 'opacity-50 pointer-events-none' : ''} disabled:cursor-not-allowed`}
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 p-2 rounded-lg bg-green-100 dark:bg-green-900/40">
              <Lock className="h-4 w-4 text-green-700 dark:text-green-400" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="font-medium text-sm">{t('tlsLetsEncrypt')}</p>
                {!isLocal && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400">
                    {t('recommended')}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">{t('tlsLetsEncryptDesc')}</p>
              {isLocal && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">{t('tlsLetsEncryptLocalWarn')}</p>
              )}
            </div>
          </div>
        </button>

        {/* Self-signed */}
        <button
          type="button"
          onClick={() => handleTlsChange('selfsigned')}
          disabled={acmeInProgress}
          className={`w-full text-left rounded-xl border p-4 transition-all ${
            tlsChoice === 'selfsigned'
              ? 'border-primary/40 bg-muted/60 ring-1 ring-primary/30'
              : 'hover:border-primary/30 hover:bg-muted/30'
          } disabled:cursor-not-allowed`}
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 p-2 rounded-lg bg-muted">
              <ShieldAlert className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium text-sm">{t('tlsSelfSigned')}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{t('tlsSelfSignedDesc')}</p>
            </div>
          </div>
        </button>

        {/* Upload own cert */}
        <button
          type="button"
          onClick={() => handleTlsChange('upload')}
          disabled={acmeInProgress}
          className={`w-full text-left rounded-xl border p-4 transition-all ${
            tlsChoice === 'upload'
              ? 'border-primary/40 bg-muted/60 ring-1 ring-primary/30'
              : 'hover:border-primary/30 hover:bg-muted/30'
          } disabled:cursor-not-allowed`}
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 p-2 rounded-lg bg-muted">
              <Upload className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium text-sm">{t('tlsUploadOwn')}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{t('tlsUploadOwnDesc')}</p>
            </div>
          </div>
        </button>
      </div>

      {/* ── Inline ACME DNS Challenge Flow ── */}
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
                  <button
                    onClick={() => copyText(challenge.txtValue, i)}
                    className="p-1 rounded hover:bg-muted transition-colors"
                    title="Copy value"
                  >
                    {copiedIndex === i
                      ? <Check className="h-3.5 w-3.5 text-green-500" />
                      : <Copy className="h-3.5 w-3.5 text-muted-foreground" />}
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

          <p className="text-xs text-amber-700 bg-amber-50 rounded-lg p-3 dark:bg-amber-950/30 dark:text-amber-200">
            {t('acmeRecordsHint')}
          </p>

          {acmeError && (
            <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 dark:bg-red-950/30 dark:text-red-400">{acmeError}</p>
          )}

          <div className="flex gap-2">
            <button
              onClick={resetAcmeFlow}
              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t('tlsBackToChoice')}
            </button>
            <button
              onClick={handleVerifyAcme}
              disabled={acmeLoading}
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-green-600 text-white px-5 py-2.5 text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {acmeLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {t('acmeVerify')}
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
        <div className="space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div className="rounded-xl border bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800 p-5 space-y-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-green-600" />
              <h3 className="font-semibold text-sm text-green-800 dark:text-green-300">{t('acmeDone')}</h3>
            </div>
            <p className="text-sm text-green-700 dark:text-green-400">{t('acmeDoneDesc')}</p>
          </div>
        </div>
      )}

      {/* Wildcard checkbox — shown when LE selected and not yet started */}
      {tlsChoice === 'letsencrypt' && acmePhase === 'choice' && !acmeCertIssued && (
        <label className="flex items-center gap-2 text-sm cursor-pointer animate-in fade-in duration-200">
          <input
            type="checkbox"
            checked={includeWildcard}
            onChange={(e) => setIncludeWildcard(e.target.checked)}
            className="rounded"
          />
          {t('acmeWildcard')}
        </label>
      )}

      {/* ACME loading error (shown in choice phase) */}
      {tlsChoice === 'letsencrypt' && acmePhase === 'choice' && acmeError && (
        <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 dark:bg-red-950/30 dark:text-red-400 animate-in fade-in duration-200">{acmeError}</p>
      )}

      {/* Advanced Settings — hidden during ACME flow */}
      {!acmeInProgress && !acmeCertIssued && (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 delay-300">
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('advancedSettings')}
            {showAdvanced ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>

          {showAdvanced && (
            <div className="mt-3 space-y-3 rounded-lg border p-4 bg-muted/30 animate-in fade-in slide-in-from-top-2 duration-200">
              {/* Subdomains */}
              <div className="space-y-2">
                <Label className="text-xs font-medium">{t('subdomains')}</Label>
                {[
                  { key: 'control', label: t('controlPanel'), placeholder: 'control' },
                  { key: 'auth', label: t('identityProvider'), placeholder: 'id' },
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
                        .{domainSlug}{effectiveTld}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Authentik Name */}
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('identityProviderName')}</Label>
                <Input
                  value={authentikName}
                  onChange={e => {
                    setAuthentikEdited(true);
                    setAuthentikName(e.target.value);
                  }}
                  placeholder={`${siteName || 'YouEye'} ID`}
                  className="h-8 text-xs"
                />
                <p className="text-[10px] text-muted-foreground">{t('authentikNameHelper')}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Next button — hidden during ACME records/verifying phases */}
      {acmePhase !== 'records' && acmePhase !== 'verifying' && (
        <div className="pt-2 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-[400ms]">
          <Button
            onClick={handleContinue}
            disabled={!canProceed || acmeLoading}
            className={`w-full h-12 text-base gap-2 ${
              tlsChoice === 'letsencrypt' && !acmeCertIssued
                ? 'bg-green-600 hover:bg-green-700'
                : ''
            }`}
          >
            {acmeLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            {tlsChoice === 'letsencrypt' && !acmeCertIssued
              ? t('acmeStartOrder')
              : t('continue')}
            {!acmeLoading && (tlsChoice !== 'letsencrypt' || acmeCertIssued) && (
              <ArrowRight className="h-4 w-4" />
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
