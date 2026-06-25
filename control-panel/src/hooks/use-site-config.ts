'use client';

import { useState, useEffect } from 'react';

interface SiteConfig {
  site_name: string;
  domain: string;
  subdomains: Record<string, string>;
  setup_completed: boolean;
}

const DEFAULT_CONFIG: SiteConfig = {
  site_name: 'YouEye',
  domain: '',
  subdomains: {},
  setup_completed: false,
};

/**
 * Client-side hook to fetch site config from /api/setup/config.
 * Returns site_name and other config values. Falls back to defaults.
 */
export function useSiteConfig() {
  const [config, setConfig] = useState<SiteConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    fetch('/api/setup/config')
      .then(r => r.ok ? r.json() : DEFAULT_CONFIG)
      .then(data => setConfig({ ...DEFAULT_CONFIG, ...data }))
      .catch(() => {});
  }, []);

  return config;
}
