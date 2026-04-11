'use client';

import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import SetupDnsExplainer from '@/components/setup/SetupDnsExplainer';

interface SetupConfig {
  site_name: string;
  domain: string;
  setup_completed: boolean;
}

/**
 * Post-setup landing page — shown when accessing via IP after setup is complete.
 * Displays DNS configuration instructions and a connectivity checker.
 */
export default function SetupCompletePage() {
  const [config, setConfig] = useState<SetupConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/setup/config')
      .then(res => res.json())
      .then((data: SetupConfig) => {
        setConfig(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

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
      standalone
    />
  );
}
