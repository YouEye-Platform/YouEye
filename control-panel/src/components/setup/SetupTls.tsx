'use client';

import { useState } from 'react';
import {
  Lock, Check, Copy, Loader2, Upload, ShieldCheck,
  ChevronDown, ArrowRight,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { TlsChoice } from '@/components/setup/SetupServerName';

interface Props {
  domain: string;
  tlsChoice: TlsChoice;
  onComplete: () => void;
  onBack: () => void;
}

type AcmeStep = 'domain' | 'records' | 'verifying' | 'done';

interface DnsChallenge {
  domain: string;
  txtName: string;
  txtValue: string;
}

// ─── ACME flow ──────────────────────────────────────────────

function AcmeFlow({ domain, onComplete, t }: {
  domain: string;
  onComplete: () => void;
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
      <div className="space-y-4">
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
      <div className="space-y-4">
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
      <div className="flex items-center gap-3 py-4">
        <Loader2 className="h-5 w-5 animate-spin text-green-600" />
        <div>
          <h3 className="font-semibold text-sm">{t('acmeVerifying')}</h3>
          <p className="text-xs text-muted-foreground">{t('acmeVerifyingDesc')}</p>
        </div>
      </div>
    );
  }

  // Step: Done
  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-green-600" />
          <h3 className="font-semibold text-sm text-green-800 dark:text-green-300">{t('acmeDone')}</h3>
        </div>
        <p className="text-sm text-green-700 dark:text-green-400">{t('acmeDoneDesc')}</p>
      </div>

      <button
        onClick={onComplete}
        className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-primary text-white px-6 py-3 text-sm font-medium hover:bg-primary/90 transition-colors"
      >
        {t('continue')}
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}

// ─── Upload cert flow ───────────────────────────────────────

function UploadFlow({ onComplete, t }: {
  onComplete: () => void;
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
      <div className="space-y-4">
        <div className="rounded-xl border bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800 p-5 space-y-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-green-600" />
            <h3 className="font-semibold text-sm text-green-800 dark:text-green-300">{t('uploadCertDone')}</h3>
          </div>
          <p className="text-sm text-green-700 dark:text-green-400">{t('uploadCertDoneDesc')}</p>
        </div>
        <button
          onClick={onComplete}
          className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-primary text-white px-6 py-3 text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          {t('continue')}
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
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
          placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
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
          placeholder={"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"}
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
            placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
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

// ─── Main component ─────────────────────────────────────────

export default function SetupTls({ domain, tlsChoice, onComplete, onBack }: Props) {
  const t = useTranslations('setup');

  // Determine header icon/text based on choice
  const headerIcon = tlsChoice === 'letsencrypt'
    ? <Lock className="h-8 w-8 text-green-600" />
    : <Upload className="h-8 w-8 text-primary" />;

  const headerTitle = tlsChoice === 'letsencrypt'
    ? t('acmeTitle')
    : t('uploadCertTitle');

  return (
    <div className="w-full max-w-md mx-auto space-y-6">
      {/* Header */}
      <div className="text-center animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-5">
          {headerIcon}
        </div>
        <h1 className="text-2xl font-bold mb-2">{headerTitle}</h1>
      </div>

      {/* Flow content */}
      <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 delay-75">
        {tlsChoice === 'letsencrypt' && (
          <AcmeFlow domain={domain} onComplete={onComplete} t={t} />
        )}

        {tlsChoice === 'upload' && (
          <UploadFlow onComplete={onComplete} t={t} />
        )}
      </div>

      {/* Back link */}
      <div className="text-center">
        <button
          onClick={onBack}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('tlsBackToChoice')}
        </button>
      </div>
    </div>
  );
}
