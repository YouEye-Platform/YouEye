'use client';

import { useState, useEffect } from 'react';
import {
  Globe, ChevronDown, ChevronUp, ArrowRight, AlertTriangle,
  Lock, ShieldAlert, Upload,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { TLD_OPTIONS } from '@/lib/wordart-presets';
import { useTranslations } from 'next-intl';

export type TlsChoice = 'letsencrypt' | 'selfsigned' | 'upload';

interface Props {
  siteName: string;
  setSiteName: (v: string) => void;
  domainSlug: string;
  setDomainSlug: (v: string) => void;
  tld: string;
  setTld: (v: string) => void;
  subdomains: Record<string, string>;
  setSubdomains: (v: Record<string, string>) => void;
  authentikName: string;
  setAuthentikName: (v: string) => void;
  tlsChoice: TlsChoice;
  setTlsChoice: (v: TlsChoice) => void;
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
  subdomains, setSubdomains,
  authentikName, setAuthentikName,
  tlsChoice, setTlsChoice,
  onNext,
}: Props) {
  const t = useTranslations('setup');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [authentikEdited, setAuthentikEdited] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const [customTld, setCustomTld] = useState('');
  const isCustomTld = tld === '__custom__';

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
          />
          <div className="relative shrink-0">
            <select
              value={tld}
              onChange={e => { e.stopPropagation(); setTld(e.target.value); }}
              onMouseDown={e => e.stopPropagation()}
              className="h-11 rounded-l-none rounded-r-md border border-input bg-muted pl-3 pr-8 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer"
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
              onChange={e => setCustomTld(e.target.value.replace(/^\./, '').replace(/[^a-z0-9.-]/gi, '').toLowerCase())}
              placeholder="wtf"
              className="h-9 text-sm font-mono flex-1"
              autoFocus
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
          onClick={() => setTlsChoice('letsencrypt')}
          className={`w-full text-left rounded-xl border p-4 transition-all ${
            tlsChoice === 'letsencrypt'
              ? 'border-green-400 bg-green-50/60 ring-1 ring-green-300 dark:bg-green-950/30 dark:border-green-700'
              : 'hover:border-green-300 hover:bg-green-50/30'
          } ${isLocal ? 'opacity-50 pointer-events-none' : ''}`}
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
          onClick={() => setTlsChoice('selfsigned')}
          className={`w-full text-left rounded-xl border p-4 transition-all ${
            tlsChoice === 'selfsigned'
              ? 'border-primary/40 bg-muted/60 ring-1 ring-primary/30'
              : 'hover:border-primary/30 hover:bg-muted/30'
          }`}
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
          onClick={() => setTlsChoice('upload')}
          className={`w-full text-left rounded-xl border p-4 transition-all ${
            tlsChoice === 'upload'
              ? 'border-primary/40 bg-muted/60 ring-1 ring-primary/30'
              : 'hover:border-primary/30 hover:bg-muted/30'
          }`}
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

      {/* Advanced Settings */}
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

      {/* Next button */}
      <div className="pt-2 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-[400ms]">
        <Button
          onClick={onNext}
          disabled={!canProceed}
          className="w-full h-12 text-base gap-2"
        >
          {t('continue')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
