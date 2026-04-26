'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Globe, ExternalLink, Download, Monitor, Apple, Terminal,
  Copy, Check, ChevronDown, Smartphone, ShieldCheck,
  ShieldAlert, Loader2, Lock, Upload,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { TlsChoice } from '@/components/setup/SetupServerName';

// ─── Types ───────────────────────────────────────────────────

interface Props {
  domain: string;
  siteName: string;
  standalone?: boolean;
  /** TLS choice from step 0 — when provided the choice screen is skipped */
  tlsChoice?: TlsChoice;
}

type Platform = 'windows' | 'macos' | 'linux' | 'ios' | 'android';
type AcmeStep = 'domain' | 'records' | 'verifying' | 'done';

interface DnsChallenge {
  domain: string;
  txtName: string;
  txtValue: string;
}

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

/** Check if a domain is local/private (LE won't work) */
function isLocalDomain(domain: string): boolean {
  return /\.(local|test|internal|lan|home|localhost|invalid|example)$/i.test(domain);
}

// ─── Connectivity hook (iframe + postMessage) ───────────────

function useConnectivityCheck(domain: string) {
  const [reachable, setReachable] = useState(false);
  const [checking, setChecking] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (!domain || reachable) return;

    let active = true;

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'ye-dns-ok' && active) {
        setReachable(true);
        setChecking(false);
      }
    };
    window.addEventListener('message', onMessage);

    const probe = () => {
      if (iframeRef.current?.parentNode) {
        iframeRef.current.parentNode.removeChild(iframeRef.current);
      }
      const iframe = document.createElement('iframe');
      iframe.style.cssText =
        'position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none';
      iframe.src = `https://${domain}/api/ping?verify=1&_t=${Date.now()}`;
      document.body.appendChild(iframe);
      iframeRef.current = iframe;
    };

    probe();
    const firstTimer = setTimeout(() => {
      if (active) setChecking(false);
    }, 3000);

    const interval = setInterval(probe, 5000);

    return () => {
      active = false;
      window.removeEventListener('message', onMessage);
      clearInterval(interval);
      clearTimeout(firstTimer);
      if (iframeRef.current?.parentNode) {
        iframeRef.current.parentNode.removeChild(iframeRef.current);
      }
    };
  }, [domain, reachable]);

  return { reachable, checking };
}

// ─── Status indicator ────────────────────────────────────────

function StatusIndicator({ reachable, checking, domain, t }: {
  reachable: boolean;
  checking: boolean;
  domain: string;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="rounded-xl border bg-card p-5 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 h-5 w-5 rounded-full flex-shrink-0 transition-colors duration-500 ${
          reachable ? 'bg-green-500' : 'bg-gray-300 animate-pulse'
        }`} />
        <div>
          <p className="font-medium text-sm">{t('statusConnection')}</p>
          <p className="text-xs text-muted-foreground">
            {checking && !reachable
              ? t('statusChecking')
              : reachable
                ? t('statusReachable', { domain })
                : t('statusNotReachable', { domain })}
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
    <div className="rounded-xl border bg-card p-5 space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-75">
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
                ? 'bg-background shadow-sm text-foreground'
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

// ─── Certificate step (self-signed) ─────────────────────────

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

  const isApple = platform === 'ios' || platform === 'macos';
  const profilePlatform = platform === 'ios' || platform === 'macos' ? platform : null;
  const certPlatform = platform === 'windows' || platform === 'android' ? platform : null;

  return (
    <div className="rounded-xl border bg-card p-5 space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-150">
      <h3 className="font-semibold text-sm">{t('step2Title')}</h3>
      <p className="text-sm text-muted-foreground">{t('step2Desc')}</p>

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

      {platform === 'ios' && (
        <p className="text-xs text-amber-700 bg-amber-50 rounded-lg p-3 dark:bg-amber-950/30 dark:text-amber-200">
          {t('iosExtraStep')}
        </p>
      )}

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

// ─── Let's Encrypt ACME flow ─────────────────────────────────

function AcmeFlow({ domain, t }: {
  domain: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const [acmeStep, setAcmeStep] = useState<AcmeStep>('domain');
  const [acmeDomain, setAcmeDomain] = useState(domain);
  const [includeWildcard, setIncludeWildcard] = useState(true);
  const [orderId, setOrderId] = useState('');
  const [challenges, setChallenges] = useState<DnsChallenge[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const copyText = (text: string, idx: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(idx);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const handleStartOrder = async () => {
    if (!acmeDomain.trim()) {
      setError(t('acmeDomainRequired'));
      return;
    }
    setLoading(true);
    setError('');
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
          domain: acmeDomain.trim(),
          includeWildcard,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start order');

      setOrderId(data.orderId);
      setChallenges(data.challenges);
      setAcmeStep('records');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start ACME order');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    setLoading(true);
    setError('');
    setAcmeStep('verifying');
    try {
      const csrfRes = await fetch('/api/auth/csrf');
      const { csrfToken } = await csrfRes.json();

      const res = await fetch('/api/tls/acme', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ orderId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed');

      setAcmeStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ACME verification failed');
      setAcmeStep('records');
    } finally {
      setLoading(false);
    }
  };

  // Step: Enter domain
  if (acmeStep === 'domain') {
    return (
      <div className="rounded-xl border bg-card p-5 space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-green-600" />
          <h3 className="font-semibold text-sm">{t('acmeTitle')}</h3>
        </div>
        <p className="text-sm text-muted-foreground">{t('acmeDesc')}</p>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">
            {t('acmeDomainLabel')}
          </label>
          <input
            type="text"
            value={acmeDomain}
            onChange={(e) => setAcmeDomain(e.target.value)}
            placeholder="example.com"
            className="w-full px-3 py-2 rounded-lg border text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={includeWildcard}
            onChange={(e) => setIncludeWildcard(e.target.checked)}
            className="rounded"
          />
          {t('acmeWildcard')}
        </label>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 dark:bg-red-950/30 dark:text-red-400">{error}</p>
        )}

        <button
          onClick={handleStartOrder}
          disabled={loading || !acmeDomain.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-green-600 text-white px-5 py-2.5 text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
          {t('acmeStartOrder')}
        </button>
      </div>
    );
  }

  // Step: Show DNS TXT records
  if (acmeStep === 'records') {
    return (
      <div className="rounded-xl border bg-card p-5 space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-green-600" />
          <h3 className="font-semibold text-sm">{t('acmeRecordsTitle')}</h3>
        </div>
        <p className="text-sm text-muted-foreground">{t('acmeRecordsDesc')}</p>

        <div className="space-y-3">
          {challenges.map((challenge, i) => (
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

        {error && (
          <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 dark:bg-red-950/30 dark:text-red-400">{error}</p>
        )}

        <button
          onClick={handleVerify}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg bg-green-600 text-white px-5 py-2.5 text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          {t('acmeVerify')}
        </button>
      </div>
    );
  }

  // Step: Verifying
  if (acmeStep === 'verifying') {
    return (
      <div className="rounded-xl border bg-card p-5 space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-green-600" />
          <div>
            <h3 className="font-semibold text-sm">{t('acmeVerifying')}</h3>
            <p className="text-xs text-muted-foreground">{t('acmeVerifyingDesc')}</p>
          </div>
        </div>
      </div>
    );
  }

  // Step: Done
  return (
    <div className="rounded-xl border bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800 p-5 space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-green-600" />
        <h3 className="font-semibold text-sm text-green-800 dark:text-green-300">{t('acmeDone')}</h3>
      </div>
      <p className="text-sm text-green-700 dark:text-green-400">{t('acmeDoneDesc')}</p>
    </div>
  );
}

// ─── Upload certificate flow ────────────────────────────────

function UploadCertFlow({ t }: {
  t: ReturnType<typeof useTranslations>;
}) {
  const [certPem, setCertPem] = useState('');
  const [keyPem, setKeyPem] = useState('');
  const [chainPem, setChainPem] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [showChain, setShowChain] = useState(false);

  const readFile = (e: React.ChangeEvent<HTMLInputElement>, setter: (v: string) => void) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setter(reader.result as string);
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleUpload = async () => {
    if (!certPem.trim() || !keyPem.trim()) return;
    setLoading(true);
    setError('');
    try {
      const csrfRes = await fetch('/api/auth/csrf');
      const { csrfToken } = await csrfRes.json();

      const res = await fetch('/api/tls/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          certificate: certPem.trim(),
          privateKey: keyPem.trim(),
          chain: chainPem.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <div className="rounded-xl border bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800 p-5 space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-green-600" />
          <h3 className="font-semibold text-sm text-green-800 dark:text-green-300">{t('uploadCertDone')}</h3>
        </div>
        <p className="text-sm text-green-700 dark:text-green-400">{t('uploadCertDoneDesc')}</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-5 space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center gap-2">
        <Upload className="h-4 w-4 text-primary" />
        <h3 className="font-semibold text-sm">{t('uploadCertTitle')}</h3>
      </div>
      <p className="text-sm text-muted-foreground">{t('uploadCertDesc')}</p>

      {/* Certificate */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium">{t('uploadCertLabel')}</label>
          <label className="text-xs text-primary cursor-pointer hover:underline">
            {t('uploadCertBrowse')}
            <input type="file" className="hidden" accept=".pem,.crt,.cer" onChange={e => readFile(e, setCertPem)} />
          </label>
        </div>
        <textarea
          value={certPem}
          onChange={e => setCertPem(e.target.value)}
          placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
          className="w-full h-24 px-3 py-2 rounded-lg border text-xs font-mono bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
        />
      </div>

      {/* Private key */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium">{t('uploadKeyLabel')}</label>
          <label className="text-xs text-primary cursor-pointer hover:underline">
            {t('uploadCertBrowse')}
            <input type="file" className="hidden" accept=".pem,.key" onChange={e => readFile(e, setKeyPem)} />
          </label>
        </div>
        <textarea
          value={keyPem}
          onChange={e => setKeyPem(e.target.value)}
          placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
          className="w-full h-24 px-3 py-2 rounded-lg border text-xs font-mono bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
        />
      </div>

      {/* Chain (optional) */}
      <button
        type="button"
        onClick={() => setShowChain(!showChain)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showChain ? 'rotate-180' : ''}`} />
        {t('uploadChainOptional')}
      </button>

      {showChain && (
        <div className="space-y-1.5 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium">{t('uploadChainLabel')}</label>
            <label className="text-xs text-primary cursor-pointer hover:underline">
              {t('uploadCertBrowse')}
              <input type="file" className="hidden" accept=".pem,.crt" onChange={e => readFile(e, setChainPem)} />
            </label>
          </div>
          <textarea
            value={chainPem}
            onChange={e => setChainPem(e.target.value)}
            placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
            className="w-full h-20 px-3 py-2 rounded-lg border text-xs font-mono bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
          />
        </div>
      )}

      {error && (
        <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 dark:bg-red-950/30 dark:text-red-400">{error}</p>
      )}

      <button
        onClick={handleUpload}
        disabled={loading || !certPem.trim() || !keyPem.trim()}
        className="inline-flex items-center gap-2 rounded-lg bg-primary text-white px-5 py-2.5 text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        {t('uploadCertApply')}
      </button>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────

export default function SetupDnsExplainer({ domain, siteName, standalone = false, tlsChoice }: Props) {
  const t = useTranslations('setup');
  const [platform, setPlatform] = useState<Platform>('windows');
  const { reachable, checking } = useConnectivityCheck(domain);

  // Resolve effective path: if tlsChoice was passed from step 0, use it directly
  const effectivePath = tlsChoice ?? 'selfsigned';

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  const serverIp = typeof window !== 'undefined' ? window.location.hostname : 'your-server-ip';

  return (
    <div className={`w-full ${standalone ? 'max-w-xl' : 'max-w-lg'} mx-auto space-y-5`}>
      {/* Header */}
      <div className="text-center animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-5">
          {reachable
            ? <ShieldCheck className="h-8 w-8 text-green-500" />
            : <Globe className="h-8 w-8 text-primary" />}
        </div>
        <h1 className="text-2xl font-bold mb-2">
          {reachable ? t('allSet') : standalone ? t('accessYourServer') : t('almostThere')}
        </h1>
        <p className="text-muted-foreground text-sm">
          {reachable
            ? t('allSetDesc')
            : t('configureDnsDesc', { domain })}
        </p>
      </div>

      {/* ── Let's Encrypt ACME flow ── */}
      {effectivePath === 'letsencrypt' && !reachable && (
        <AcmeFlow domain={domain} t={t} />
      )}

      {/* ── Self-signed CA flow ── */}
      {effectivePath === 'selfsigned' && !reachable && (
        <>
          <StatusIndicator reachable={reachable} checking={checking} domain={domain} t={t} />
          <DnsStep serverIp={serverIp} platform={platform} t={t} />
          <CertStep serverIp={serverIp} platform={platform} t={t} />
        </>
      )}

      {/* ── Upload custom cert flow ── */}
      {effectivePath === 'upload' && !reachable && (
        <>
          <UploadCertFlow t={t} />
          <StatusIndicator reachable={reachable} checking={checking} domain={domain} t={t} />
          <DnsStep serverIp={serverIp} platform={platform} t={t} />
        </>
      )}

      {/* Status indicator for LE path */}
      {effectivePath === 'letsencrypt' && (
        <StatusIndicator reachable={reachable} checking={checking} domain={domain} t={t} />
      )}

      {/* When reachable and was LE path — no cert install needed */}
      {reachable && effectivePath === 'letsencrypt' && (
        <div className="rounded-xl border bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800 p-5 space-y-2 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-green-600" />
            <p className="font-medium text-sm text-green-800 dark:text-green-300">{t('acmeNoCertInstall')}</p>
          </div>
          <p className="text-xs text-green-700 dark:text-green-400">{t('acmeNoCertInstallDesc')}</p>
        </div>
      )}

      {/* Go to server */}
      <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200">
        <a
          href={`https://${domain}`}
          className={`inline-flex items-center gap-2 rounded-lg px-6 py-3 text-sm font-medium transition-all w-full justify-center ${
            reachable
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
