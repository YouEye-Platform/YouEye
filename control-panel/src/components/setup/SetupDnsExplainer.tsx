'use client';

import { useState, useEffect, useCallback } from 'react';
import { CheckCircle2, ExternalLink, Download, Monitor, Apple, Terminal, Copy, Check, Globe } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface Props {
  domain: string;
  siteName: string;
  standalone?: boolean;
}

type OS = 'windows' | 'macos' | 'linux';

function CertCommands({ domain }: { domain: string }) {
  const t = useTranslations('setup');
  const [os, setOs] = useState<OS>('windows');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('mac')) setOs('macos');
    else if (ua.includes('linux')) setOs('linux');
  }, []);

  const commands: Record<OS, { label: string; icon: React.ReactNode; steps: string }> = {
    windows: {
      label: 'Windows',
      icon: <Monitor className="h-4 w-4" />,
      steps: `curl -o youeye-ca.crt https://${domain}/api/setup/ca-cert\ncertutil -addstore -f "ROOT" youeye-ca.crt`,
    },
    macos: {
      label: 'macOS',
      icon: <Apple className="h-4 w-4" />,
      steps: `curl -o youeye-ca.crt https://${domain}/api/setup/ca-cert\nsudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain youeye-ca.crt`,
    },
    linux: {
      label: 'Linux',
      icon: <Terminal className="h-4 w-4" />,
      steps: `curl -o youeye-ca.crt https://${domain}/api/setup/ca-cert\nsudo cp youeye-ca.crt /usr/local/share/ca-certificates/\nsudo update-ca-certificates`,
    },
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(commands[os].steps);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="text-left space-y-3">
      <h3 className="text-sm font-semibold">{t('trustCert')}</h3>
      <p className="text-xs text-muted-foreground">{t('certHint')}</p>

      <div className="flex gap-1 rounded-lg border p-1 bg-muted/50">
        {(['windows', 'macos', 'linux'] as OS[]).map(key => (
          <button
            key={key}
            onClick={() => setOs(key)}
            className={`flex items-center gap-1.5 flex-1 justify-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              os === key ? 'bg-white shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {commands[key].icon}
            {commands[key].label}
          </button>
        ))}
      </div>

      <div className="relative">
        <pre className="rounded-lg bg-gray-950 text-gray-200 p-4 pr-12 text-xs leading-relaxed overflow-x-auto">
          {commands[os].steps}
        </pre>
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 p-1.5 rounded-md bg-white/10 hover:bg-white/20 transition-colors"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5 text-gray-400" />}
        </button>
      </div>

      <a
        href="/api/setup/ca-cert"
        download="youeye-ca.crt"
        className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
      >
        <Download className="h-4 w-4" />
        {t('downloadCert')}
      </a>
    </div>
  );
}

export default function SetupDnsExplainer({ domain, siteName, standalone = false }: Props) {
  const t = useTranslations('setup');
  const [dnsReady, setDnsReady] = useState(false);

  const checkConnectivity = useCallback(async () => {
    // Client-side connectivity check: verifies the user's device can reach
    // the configured domain over HTTPS. This tests BOTH DNS resolution AND
    // certificate trust in one shot — the user needs both to access their
    // server. The page instructs them on configuring DNS and installing the
    // CA certificate; once both are done, this check succeeds.
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      await fetch(`https://${domain}/api/ping`, {
        mode: 'no-cors',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      setDnsReady(true);
    } catch {
      // DNS not configured, cert not trusted, or server unreachable
    }
  }, [domain]);

  // Auto-check every 5 seconds
  useEffect(() => {
    if (dnsReady || !domain) return;
    checkConnectivity();
    const interval = setInterval(checkConnectivity, 5000);
    return () => clearInterval(interval);
  }, [domain, dnsReady, checkConnectivity]);

  const serverIp = typeof window !== 'undefined'
    ? window.location.hostname
    : 'your-server-ip';

  return (
    <div className={`w-full ${standalone ? 'max-w-xl' : 'max-w-lg'} mx-auto space-y-6`}>
      {/* Header */}
      <div className="text-center animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-5">
          <Globe className="h-8 w-8 text-primary" />
        </div>
        <h1 className="text-2xl font-bold mb-2">
          {standalone ? t('accessYourServer') : t('almostThere')}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t('configureDnsDesc', { domain })}
        </p>
      </div>

      {/* DNS Instructions */}
      <div className="rounded-xl border bg-white/80 p-5 space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-75">
        <h3 className="font-semibold text-sm">{t('dnsOption1Title')}</h3>
        <p className="text-sm text-muted-foreground">{t('dnsOption1Desc', { domain, ip: serverIp })}</p>

        <div className="rounded-lg bg-muted/50 border p-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t('dnsRecord')}</span>
            <span className="font-mono font-medium">{domain} &rarr; {serverIp}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t('wildcard')}</span>
            <span className="font-mono font-medium">*.{domain} &rarr; {serverIp}</span>
          </div>
        </div>

        <div className="border-t pt-4">
          <h3 className="font-semibold text-sm">{t('dnsOption2Title')}</h3>
          <p className="text-sm text-muted-foreground mt-1">
            {t('dnsOption2Desc', { ip: serverIp })}
          </p>
        </div>
      </div>

      {/* Go to server */}
      <div className="rounded-xl border bg-white/80 p-5 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-150">
        {dnsReady ? (
          <div className="flex items-center gap-3 mb-4">
            <CheckCircle2 className="h-6 w-6 text-green-500 animate-in zoom-in-50 duration-300" />
            <div>
              <p className="font-medium text-green-700">{t('dnsConfigured')}</p>
              <p className="text-xs text-muted-foreground">{t('dnsConfiguredDesc', { domain })}</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground mb-4">
            {t('readyWhenDone', { domain })}
          </p>
        )}

        <a
          href={`https://${domain}`}
          className={`inline-flex items-center gap-2 rounded-lg px-6 py-3 text-sm font-medium transition-colors w-full justify-center ${
            dnsReady
              ? 'bg-primary text-white hover:bg-primary/90'
              : 'bg-primary text-white hover:bg-primary/90'
          }`}
        >
          {t('goTo', { name: siteName })}
          <ExternalLink className="h-4 w-4" />
        </a>
      </div>

      {/* CA Cert */}
      <div className="rounded-xl border bg-white/80 p-5 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200">
        <CertCommands domain={domain} />
      </div>
    </div>
  );
}
