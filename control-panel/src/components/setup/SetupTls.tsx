'use client';

import { useState } from 'react';
import {
  Loader2, Upload, ShieldCheck,
  ChevronDown, ArrowRight,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

interface Props {
  domain: string;
  onComplete: () => void;
  onBack: () => void;
}

// ─── Upload cert flow ───────────────────────────────────────
// ACME (Let's Encrypt) flow is now inline in SetupServerName.
// This component only handles the certificate upload flow.

export default function SetupTls({ domain, onComplete, onBack }: Props) {
  const t = useTranslations('setup');
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
      <div className="w-full max-w-md mx-auto space-y-6">
        <div className="text-center animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-5">
            <Upload className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold mb-2">{t('uploadCertTitle')}</h1>
        </div>
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
    <div className="w-full max-w-md mx-auto space-y-6">
      {/* Header */}
      <div className="text-center animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-5">
          <Upload className="h-8 w-8 text-primary" />
        </div>
        <h1 className="text-2xl font-bold mb-2">{t('uploadCertTitle')}</h1>
      </div>

      <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 delay-75 space-y-4">
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
