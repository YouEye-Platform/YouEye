'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { 
  Package, 
  Globe2, 
  Loader2,
  Play,
  Square,
  RotateCcw,
  ExternalLink,
  AlertCircle,
  CheckCircle2,
  Circle,
  Database,
  Shield,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useTranslations } from 'next-intl';
import type { AppInstance, AppStatus } from '@/types/apps';

interface AppWithStatus extends AppInstance {
  loading?: boolean;
}

const APP_ICONS: Record<string, typeof Package> = {
  pihole: Globe2,
  caddy: Globe2,
  postgres: Database,
  authentik: Shield,
};

const STATUS_CONFIG: Record<AppStatus, { icon: typeof CheckCircle2; color: string; label: string }> = {
  running: { icon: CheckCircle2, color: 'text-green-500', label: 'Running' },
  stopped: { icon: Circle, color: 'text-gray-400', label: 'Stopped' },
  error: { icon: AlertCircle, color: 'text-red-500', label: 'Error' },
  'not-installed': { icon: Circle, color: 'text-gray-300', label: 'Not Deployed' },
};

export default function AppsLegacyPage() {
  const t = useTranslations('appsLegacy');
  const [apps, setApps] = useState<AppWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);

  const fetchApps = useCallback(async () => {
    try {
      const tokenRes = await fetch('/api/auth/csrf');
      if (tokenRes.ok) {
        const tokenData = await tokenRes.json();
        setCsrfToken(tokenData.csrfToken);
      }

      const appsRes = await fetch('/api/apps');
      if (!appsRes.ok) throw new Error('Failed to fetch apps');
      const data = await appsRes.json();

      const appsWithStatus = await Promise.all(
        data.apps.map(async (manifest: AppWithStatus['manifest']) => {
          const statusRes = await fetch(`/api/apps/${manifest.name}/status`);
          if (statusRes.ok) {
            return await statusRes.json();
          }
          return { manifest, status: 'error' as AppStatus };
        })
      );

      setApps(appsWithStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch apps');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  const handleControl = async (appName: string, action: 'start' | 'stop' | 'restart') => {
    if (!csrfToken) return;

    setApps(prev => prev.map(app => 
      app.manifest.name === appName ? { ...app, loading: true } : app
    ));

    try {
      const res = await fetch(`/api/apps/${appName}/control`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ action }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to control app');
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
      await fetchApps();
    } catch (err) {
      console.error('Control error:', err);
      setApps(prev => prev.map(app => 
        app.manifest.name === appName ? { ...app, loading: false } : app
      ));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (error) {
    return (
      <Card className="border-red-200 bg-red-50">
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 text-red-600">
            <AlertCircle className="h-5 w-5" />
            <span>{error}</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const MANAGE_PAGES: Record<string, string> = {
    pihole: '/apps/pihole',
    caddy: '/proxy',
    postgres: '/apps/postgres',
    authentik: '/apps/authentik',
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        <p className="text-gray-500 mt-1">{t('description')} <Link href="/apps" className="text-blue-500 hover:underline">Apps</Link></p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {apps.map((app) => {
          const Icon = APP_ICONS[app.manifest.name] || Package;
          const status = STATUS_CONFIG[app.status];
          const StatusIcon = status.icon;
          const managePage = MANAGE_PAGES[app.manifest.name];

          return (
            <Card key={app.manifest.name} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-blue-100 rounded-lg">
                      <Icon className="h-5 w-5 text-blue-600" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">{app.manifest.displayName}</CardTitle>
                      <div className={`flex items-center gap-1 text-sm ${status.color}`}>
                        <StatusIcon className="h-4 w-4" />
                        {status.label}
                      </div>
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <CardDescription className="mb-3">
                  {app.manifest.description}
                </CardDescription>
                {app.containerStatus?.ipv4 && (
                  <p className="text-xs text-gray-400 mb-3 font-mono">{app.containerStatus.ipv4}</p>
                )}
                <div className="flex items-center gap-2">
                  {managePage && app.status === 'running' && (
                    <Link href={managePage}>
                      <Button size="sm" variant="default">
                        <ExternalLink className="h-4 w-4 mr-1" />
                        {t('manage')}
                      </Button>
                    </Link>
                  )}
                  {app.status === 'running' && (
                    <>
                      <Button 
                        size="sm" 
                        variant="outline"
                        onClick={() => handleControl(app.manifest.name, 'restart')}
                        disabled={app.loading}
                      >
                        {app.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                      </Button>
                      <Button 
                        size="sm" 
                        variant="outline"
                        onClick={() => handleControl(app.manifest.name, 'stop')}
                        disabled={app.loading}
                      >
                        <Square className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                  {app.status === 'stopped' && (
                    <Button 
                      size="sm" 
                      variant="outline"
                      onClick={() => handleControl(app.manifest.name, 'start')}
                      disabled={app.loading}
                    >
                      {app.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    </Button>
                  )}
                  {app.status === 'not-installed' && (
                    <p className="text-sm text-gray-400">{t('notDeployedHint')}</p>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
