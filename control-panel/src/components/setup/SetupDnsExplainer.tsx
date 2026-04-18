'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Globe, ExternalLink, Download, Monitor, Apple, Terminal,
  Copy, Check, ChevronDown, Smartphone, ShieldCheck,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

// ─── Types ───────────────────────────────────────────────────

interface Props {
  domain: string;
  siteName: string;
  standalone?: boolean;
}

type Platform = 'windows' | 'macos' | 'linux' | 'ios' | 'android';

// ─── Platform detection ──────────────────────────────────────

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'windows';
  const ua = navigator.userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (/android/.test(ua)) return 'android';
  if (/mac/.test(ua)) return 'macos';
  if (/linux/.test(ua)) return 'linux';
  return 'windows';
}

// ─── Connectivity hook (timing heuristic) ────────────────────

function useConnectivityCheck(domain: string) {
  const [dnsReady, setDnsReady] = useState(false);
  const [certReady, setCertReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const timingsRef = useRef<number[]>([]);

  const check = useCallback(async () => {
    if (!domain) return;
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      await fetch(`https://${domain}/api/ping`, {
        mode: 'no-cors',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      setDnsReady(true);
      setCertReady(true);
      setChecking(false);
    } catch {
      const elapsed = Date.now() - start;
      timingsRef.current.push(elapsed);
      if (timingsRef.current.length > 3) timingsRef.current.shift();

      const sorted = [...timingsRef.current].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];

      if (median >= 1500) {
        setDnsReady(true);
        setCertReady(false);
      } else {
        setDnsReady(false);
        setCertReady(false);
      }
    }
  }, [domain]);

  useEffect(() => {
    if (certReady) return;
    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, [domain, certReady, check]);

  return { dnsReady, certReady, checking };
}

// ─── Status indicators ──────────────────────────────────────

function StatusIndicators({ dnsReady, certReady, checking, domain, t }: {
  dnsReady: boolean;
  certReady: boolean;
  checking: boolean;
  domain: string;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="rounded-xl border bg-white/80 p-5 space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 h-5 w-5 rounded-full flex-shrink-0 transition-colors duration-500 ${
          dnsReady ? 'bg-green-500' : 'bg-gray-300 animate-pulse'
        }`} />
        <div>
          <p className="font-medium text-sm">{t('statusDns')}</p>
          <p className="text-xs text-muted-foreground">
            {checking && !dnsReady
              ? t('statusChecking')
              : dnsReady
                ? t('statusDnsOk', { domain })
                : t('statusDnsNotReady', { domain })}
          </p>
        </div>
      </div>

      <div className="flex items-start gap-3">
        <div className={`mt-0.5 h-5 w-5 rounded-full flex-shrink-0 transition-colors duration-500 ${
          certReady ? 'bg-green-500' : 'bg-gray-300 animate-pulse'
        }`} />
        <div>
          <p className="font-medium text-sm">{t('statusCert')}</p>
          <p className="text-xs text-muted-foreground">
            {checking && !certReady
              ? t('statusChecking')
              : certReady
                ? t('statusCertOk')
                : t('statusCertNotReady')}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── DNS step ────────────────────────────────────────────────

function DnsStep({ serverIp, platform, t }: {
  serverIp: string;
  platform: Platform;
  t: ReturnType<typeof useTranslations>;
}) {
  const [activeTab, setActiveTab] = useState<Platform>(platform);
  const [copied, setCopied] = useState(false);

  const tabs: { key: Platform; label: string; icon: React.ReactNode }[] = [
    { key: 'windows', label: 'Windows', icon: <Monitor className="h-3.5 w-3.5" /> },
    { key: 'macos', label: 'macOS', icon: <Apple className="h-3.5 w-3.5" /> },
    { key: 'linux', label: 'Linux', icon: <Terminal className="h-3.5 w-3.5" /> },
    { key: 'ios', label: 'iOS', icon: <Smartphone className="h-3.5 w-3.5" /> },
    { key: 'android', label: 'Android', icon: <Smartphone className="h-3.5 w-3.5" /> },
  ];

  const commands: Record<Platform, { steps: string; note?: string }> = {
    windows: {
      steps: `netsh interface ip set dns "Wi-Fi" static ${serverIp}\nipconfig /flushdns`,
      note: t('dnsNoteWindows'),
    },
    macos: {
      steps: `sudo networksetup -setdnsservers Wi-Fi ${serverIp}`,
      note: t('dnsNoteMacos'),
    },
    linux: {
      steps: `sudo resolvectl dns $(ip route show default | awk '{print $5}') ${serverIp}`,
    },
    ios: {
      steps: '',
      note: t('dnsInstructions_ios', { ip: serverIp }),
    },
    android: {
      steps: '',
      note: t('dnsInstructions_android', { ip: serverIp }),
    },
  };

  const current = commands[activeTab];

  const handleCopy = () => {
    if (!current.steps) return;
    navigator.clipboard.writeText(current.steps);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-xl border bg-white/80 p-5 space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-75">
      <h3 className="font-semibold text-sm">{t('step1Title')}</h3>
      <p className="text-sm text-muted-foreground">{t('step1Desc', { ip: serverIp })}</p>

      {/* Platform tabs */}
      <div className="flex gap-1 rounded-lg border p-1 bg-muted/50 flex-wrap">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1 flex-1 min-w-[60px] justify-center rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
              activeTab === tab.key
                ? 'bg-white shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.icon}
            <span className="hidden sm:inline">{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Terminal commands or instructions */}
      {current.steps ? (
        <div className="relative">
          <pre className="rounded-lg bg-gray-950 text-gray-200 p-4 pr-12 text-xs leading-relaxed overflow-x-auto">
            {current.steps}
          </pre>
          <button
            onClick={handleCopy}
            className="absolute top-2 right-2 p-1.5 rounded-md bg-white/10 hover:bg-white/20 transition-colors"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5 text-gray-400" />}
          </button>
        </div>
      ) : null}

      {current.note && (
        <p className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-3">{current.note}</p>
      )}

      {/* Alternative: router DNS */}
      <div className="border-t pt-4">
        <p className="text-xs text-muted-foreground">
          {t('step1Alt', { ip: serverIp })}
        </p>
      </div>
    </div>
  );
}

// ─── Certificate step ────────────────────────────────────────

function CertStep({ serverIp, platform, t }: {
  serverIp: string;
  platform: Platform;
  t: ReturnType<typeof useTranslations>;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [copied, setCopied] = useState(false);

  const certCommands: Record<'windows' | 'macos' | 'linux', string> = {
    windows: `curl.exe -k -o youeye-ca.crt https://${serverIp}/api/setup/ca-cert\ncertutil -addstore -f "ROOT" youeye-ca.crt`,
    macos: `curl -k -o youeye-ca.crt https://${serverIp}/api/setup/ca-cert\nsudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain youeye-ca.crt`,
    linux: `curl -k -o youeye-ca.crt https://${serverIp}/api/setup/ca-cert\nsudo cp youeye-ca.crt /usr/local/share/ca-certificates/\nsudo update-ca-certificates`,
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Determine which download to show prominently
  const isApple = platform === 'ios' || platform === 'macos';
  const profilePlatform = platform === 'ios' || platform === 'macos' ? platform : null;
  const certPlatform = platform === 'windows' || platform === 'android' ? platform : null;

  return (
    <div className="rounded-xl border bg-white/80 p-5 space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-150">
      <h3 className="font-semibold text-sm">{t('step2Title')}</h3>
      <p className="text-sm text-muted-foreground">{t('step2Desc')}</p>

      {/* Primary download button */}
      {isApple && (
        <a
          href={`/api/setup/profile?platform=${profilePlatform}`}
          download
          className="inline-flex items-center gap-2 rounded-lg bg-primary text-white px-5 py-2.5 text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <Download className="h-4 w-4" />
          {t('downloadProfile')}
        </a>
      )}

      {certPlatform && (
        <a
          href={`/api/setup/profile?platform=${certPlatform}`}
          download
          className="inline-flex items-center gap-2 rounded-lg bg-primary text-white px-5 py-2.5 text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <Download className="h-4 w-4" />
          {t('downloadCertFile')}
        </a>
      )}

      {platform === 'linux' && (
        <a
          href="/api/setup/ca-cert"
          download="youeye-ca.crt"
          className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
        >
          <Download className="h-4 w-4" />
          {t('downloadCert')}
        </a>
      )}

      {/* iOS extra step */}
      {platform === 'ios' && (
        <p className="text-xs text-amber-700 bg-amber-50 rounded-lg p-3">
          {t('iosExtraStep')}
        </p>
      )}

      {/* Advanced: terminal commands (collapsed by default) */}
      {(platform === 'windows' || platform === 'macos' || platform === 'linux') && (
        <div className="border-t pt-3">
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
            {t('advancedTerminal')}
          </button>

          {showAdvanced && (
            <div className="mt-3 relative">
              <pre className="rounded-lg bg-gray-950 text-gray-200 p-4 pr-12 text-xs leading-relaxed overflow-x-auto">
                {certCommands[platform as 'windows' | 'macos' | 'linux']}
              </pre>
              <button
                onClick={() => handleCopy(certCommands[platform as 'windows' | 'macos' | 'linux'])}
                className="absolute top-2 right-2 p-1.5 rounded-md bg-white/10 hover:bg-white/20 transition-colors"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5 text-gray-400" />}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────

export default function SetupDnsExplainer({ domain, siteName, standalone = false }: Props) {
  const t = useTranslations('setup');
  const [platform, setPlatform] = useState<Platform>('windows');
  const { dnsReady, certReady, checking } = useConnectivityCheck(domain);

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  const serverIp = typeof window !== 'undefined' ? window.location.hostname : 'your-server-ip';
  const allReady = dnsReady && certReady;

  return (
    <div className={`w-full ${standalone ? 'max-w-xl' : 'max-w-lg'} mx-auto space-y-5`}>
      {/* Header */}
      <div className="text-center animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-5">
          {allReady
            ? <ShieldCheck className="h-8 w-8 text-green-500" />
            : <Globe className="h-8 w-8 text-primary" />}
        </div>
        <h1 className="text-2xl font-bold mb-2">
          {allReady ? t('allSet') : standalone ? t('accessYourServer') : t('almostThere')}
        </h1>
        <p className="text-muted-foreground text-sm">
          {allReady
            ? t('allSetDesc')
            : t('configureDnsDesc', { domain })}
        </p>
      </div>

      {/* Status indicators */}
      <StatusIndicators
        dnsReady={dnsReady}
        certReady={certReady}
        checking={checking}
        domain={domain}
        t={t}
      />

      {/* Step 1: DNS — hide when DNS ready */}
      {!dnsReady && (
        <DnsStep serverIp={serverIp} platform={platform} t={t} />
      )}

      {/* Step 2: Certificate — show when DNS ready but cert not, or always if neither ready */}
      {!certReady && (
        <CertStep serverIp={serverIp} platform={platform} t={t} />
      )}

      {/* Go to server */}
      <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200">
        <a
          href={`https://${domain}`}
          className={`inline-flex items-center gap-2 rounded-lg px-6 py-3 text-sm font-medium transition-all w-full justify-center ${
            allReady
              ? 'bg-primary text-white hover:bg-primary/90 shadow-lg shadow-primary/25'
              : 'bg-muted text-muted-foreground hover:bg-muted/80'
          }`}
        >
          {t('goTo', { name: siteName })}
          <ExternalLink className="h-4 w-4" />
        </a>
      </div>
    </div>
  );
}
