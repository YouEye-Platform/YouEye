'use client';

import { useState, useEffect, useCallback } from 'react';
import { Globe, ChevronDown, ChevronUp, ArrowRight, AlertTriangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { TLD_OPTIONS } from '@/lib/wordart-presets';
import { useTranslations } from 'next-intl';

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
  onNext: () => void;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export default function SetupServerName({
  siteName, setSiteName,
  domainSlug, setDomainSlug,
  tld, setTld,
  subdomains, setSubdomains,
  authentikName, setAuthentikName,
  onNext,
}: Props) {
  const t = useTranslations('setup');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [authentikEdited, setAuthentikEdited] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);

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

  const domain = `${domainSlug}${tld}`;
  const isRealTld = TLD_OPTIONS.find(opt => opt.value === tld)?.group === 'real';
  const canProceed = siteName.trim().length > 0 && domainSlug.length > 0;

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
            </select>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('serverAddressPreview')}: <span className="font-mono font-medium">{domain || '...'}</span>
        </p>
        {isRealTld && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
            <span>{t('realDomainWarning')}</span>
          </div>
        )}
      </div>

      {/* Advanced Settings */}
      <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200">
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
                      .{domainSlug}{tld}
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
      <div className="pt-2 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-300">
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
