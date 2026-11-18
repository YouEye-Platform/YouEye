'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';

interface NamesStatus {
  stage: string;
  fqdn: string | null;
  error: string | null;
}

/** The certificate the YouEye Names job is getting while the owner continues setup. */
export default function SetupNamesStatus({ fqdn }: { fqdn: string }) {
  const t = useTranslations('setup.namesCertificate');
  const [status, setStatus] = useState<NamesStatus | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch('/api/setup/names/status', { cache: 'no-store' });
        if (response.ok) {
          const body = await response.json() as NamesStatus;
          if (!active) return;
          setStatus(body);
          if (body.stage === 'ready') return;
        }
      } catch {
        // A Control Panel restart is brief; keep polling.
      }
      if (active) timer = setTimeout(poll, 4_000);
    };
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, []);

  if (!status || status.stage === 'none' || status.fqdn !== fqdn) return null;
  const ready = status.stage === 'ready';
  const Icon = ready ? CheckCircle2 : status.error ? AlertTriangle : Loader2;
  return (
    <p role="status" className="mx-auto flex max-w-xl items-center justify-center gap-2 text-sm text-muted-foreground">
      <Icon aria-hidden="true" className={`h-4 w-4 shrink-0 ${ready ? 'text-primary' : status.error ? 'text-amber-600' : 'animate-spin motion-reduce:animate-none'}`} />
      <span>{ready ? t('ready', { fqdn }) : status.error ? t('problem', { fqdn }) : t('waiting', { fqdn })}</span>
    </p>
  );
}
