'use client';

import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import SetupDnsExplainer from '@/components/setup/SetupDnsExplainer';
import type { TlsChoice } from '@/components/setup/SetupServerName';

interface SetupConfig {
  site_name: string;
  domain: string;
  setup_completed: boolean;
  tls_choice?: TlsChoice;
  extra?: { tls_choice?: TlsChoice };
}

function isTlsChoice(value: string | null | undefined): value is TlsChoice {
  return value === 'youeye-names' || value === 'byo-provider' || value === 'letsencrypt' || value === 'selfsigned' || value === 'upload';
}

/**
 * Post-setup landing page — shown when accessing via IP after setup is complete.
 * Displays DNS configuration instructions and a connectivity checker.
 */
export default function SetupCompletePage() {
  const [config, setConfig] = useState<SetupConfig | null>(null);
  const [tlsChoice, setTlsChoice] = useState<TlsChoice | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);

  useEffect(() => {
    const queryChoice = new URLSearchParams(window.location.search).get('tls');
    fetch('/api/setup/config')
      .then(res => res.json())
      .then((data: SetupConfig) => {
        setConfig(data);
        setTlsChoice(
          isTlsChoice(queryChoice)
            ? queryChoice
            : isTlsChoice(data.tls_choice)
              ? data.tls_choice
              : isTlsChoice(data.extra?.tls_choice)
                ? data.extra.tls_choice
                : undefined
        );
        setLoading(false);
      })
      .catch(() => {
        setTlsChoice(isTlsChoice(queryChoice) ? queryChoice : undefined);
        setLoading(false);
      });
  }, []);

  async function continueToServer() {
    setContinuing(true);
    setContinueError(null);
    try {
      const csrfResponse = await fetch('/api/auth/csrf', { cache: 'no-store' });
      const { csrfToken } = await csrfResponse.json();
      if (!csrfToken) throw new Error('Sign in as the appliance owner to continue.');
      const response = await fetch('/api/appliance/handoff', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not continue to the server.');

      const form = document.createElement('form');
      form.method = 'POST';
      form.action = body.action;
      const code = document.createElement('input');
      code.type = 'hidden';
      code.name = 'code';
      code.value = body.code;
      form.appendChild(code);
      document.body.appendChild(form);
      form.submit();
    } catch (error) {
      setContinueError(error instanceof Error ? error.message : 'Could not continue to the server.');
      setContinuing(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <SetupDnsExplainer
      domain={config?.domain || ''}
      siteName={config?.site_name || 'YouEye'}
      tlsChoice={tlsChoice}
      standalone
      onContinue={continueToServer}
      continuing={continuing}
      continueError={continueError}
    />
  );
}
