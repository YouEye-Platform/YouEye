'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, Download, Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * Offered on the setup surface when it is opened over plain HTTP (`http://youeye.local` or `http://<ip>`): how to
 * switch to HTTPS, why the browser warns about the box's own certificate, and how to trust it.
 */
export default function SetupSecureConnection() {
  const t = useTranslations('setup');
  const [httpsUrl, setHttpsUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  useEffect(() => {
    const { protocol, hostname, pathname, search } = window.location;
    if (protocol === 'http:') setHttpsUrl(`https://${hostname}${pathname}${search}`);
  }, []);

  // The root's SHA-256, to compare with the one on the box's screen before trusting it.
  useEffect(() => {
    if (!open || fingerprint) return;
    let active = true;
    fetch('/api/setup/ca-fingerprint', { cache: 'no-store' })
      .then(async response => (response.ok ? await response.json() as { sha256?: unknown } : null))
      .then(body => { if (active && typeof body?.sha256 === 'string') setFingerprint(body.sha256); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [open, fingerprint]);

  if (!httpsUrl) return null;

  const platforms = [
    { id: 'windows', name: t('secureConnectionOs_windows'), steps: t('secureConnectionSteps_windows') },
    { id: 'macos', name: t('secureConnectionOs_macos'), steps: t('secureConnectionSteps_macos') },
    { id: 'ios', name: t('secureConnectionOs_ios'), steps: t('secureConnectionSteps_ios') },
    { id: 'android', name: t('secureConnectionOs_android'), steps: t('secureConnectionSteps_android') },
    { id: 'linux', name: t('secureConnectionOs_linux'), steps: t('secureConnectionSteps_linux') },
    { id: 'firefox', name: t('secureConnectionOs_firefox'), steps: t('secureConnectionSteps_firefox') },
  ];

  return (
    <section className="w-full max-w-[420px] rounded-lg border bg-card p-4 text-sm shadow-sm">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 text-left font-medium"
      >
        <Lock className="h-4 w-4 shrink-0 text-primary" />
        <span className="flex-1">{t('secureConnectionTitle')}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-3 space-y-3 text-muted-foreground">
          <p>{t('secureConnectionWarning')}</p>
          <p>{t('secureConnectionTrust')}</p>
          <a
            href="/api/setup/ca-cert"
            download="youeye-ca.crt"
            className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 font-medium text-foreground transition-colors hover:bg-muted"
          >
            <Download className="h-4 w-4" />
            {t('downloadCert')}
          </a>
          {fingerprint && (
            <div className="space-y-1">
              <p>{t('secureConnectionFingerprint')}</p>
              <p className="text-xs">
                <span className="font-medium text-foreground">{t('secureConnectionFingerprintLabel')}</span>
                <code className="mt-1 block break-all font-mono text-foreground">{fingerprint}</code>
              </p>
            </div>
          )}
          <dl className="space-y-2">
            {platforms.map(platform => (
              <div key={platform.id}>
                <dt className="font-medium text-foreground">{platform.name}</dt>
                <dd>{platform.steps}</dd>
              </div>
            ))}
          </dl>
          <a
            href={httpsUrl}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Lock className="h-4 w-4" />
            {t('secureConnectionOpen')}
          </a>
        </div>
      )}
    </section>
  );
}
