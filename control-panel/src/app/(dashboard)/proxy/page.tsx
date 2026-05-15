'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { 
  RefreshCw, 
  Globe,
  Loader2,
  AlertCircle,
  Check,
  Shield,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { authenticatedFetch } from '@/lib/api-client';
import { ProxyStatusCard } from '@/components/proxy/proxy-status-card';
import { ContainerRoutingTable } from '@/components/proxy/container-routing-table';
import type { AppInstance } from '@/types/apps';

export default function ProxyPage() {
  const t = useTranslations('proxy');
  const tc = useTranslations('common');
  const [caddyStatus, setCaddyStatus] = useState<AppInstance | null>(null);
  const [domain, setDomain] = useState<string | null>(null);
  const [domainInput, setDomainInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingDomain, setSavingDomain] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const statusRes = await fetch('/api/apps/caddy/status');
      if (statusRes.ok) {
        const data = await statusRes.json();
        setCaddyStatus(data);

        if (data.status === 'running') {
          try {
            const domainRes = await fetch('/api/domain');
            if (domainRes.ok) {
              const domainData = await domainRes.json();
              setDomain(domainData.domain);
              if (domainData.domain) {
                setDomainInput(domainData.domain);
              }
            }
          } catch (e) {
            console.error('Failed to fetch domain config:', e);
          }
        }
      }
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleCaddyAction = async (action: 'start' | 'stop' | 'restart' | 'remove') => {
    setActionError(null);
    setActionSuccess(null);

    try {
      const response = await authenticatedFetch('/api/apps/caddy/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Action failed');
      }

      setActionSuccess(data.message || `Caddy ${action} successful`);
      
      setTimeout(() => {
        fetchData();
        setActionSuccess(null);
      }, 2000);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Action failed');
    }
  };

  const saveDomain = async () => {
    if (!domainInput.trim()) return;
    
    setSavingDomain(true);
    setActionError(null);
    setActionSuccess(null);

    try {
      const response = await authenticatedFetch('/api/domain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domainInput.trim() }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to set domain');
      }

      setDomain(domainInput.trim());
      setActionSuccess(data.message || 'Domain configured successfully!');
      
      setTimeout(() => {
        setActionSuccess(null);
      }, 3000);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to set domain');
    } finally {
      setSavingDomain(false);
    }
  };

  const isInstalled = caddyStatus?.status !== 'not-installed';
  const isRunning = caddyStatus?.status === 'running';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-gray-500">
            {t('description')}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={fetchData}
          disabled={loading}
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              {tc('loading')}
            </>
          ) : (
            <>
              <RefreshCw className="h-4 w-4 mr-2" />
              {tc('refresh')}
            </>
          )}
        </Button>
      </div>

      {/* Status Messages */}
      {actionError && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700">
          <AlertCircle className="h-4 w-4" />
          {actionError}
        </div>
      )}
      {actionSuccess && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-lg flex items-center gap-2 text-green-700">
          <Check className="h-4 w-4" />
          {actionSuccess}
        </div>
      )}

      {/* Not Deployed State */}
      {!loading && !isInstalled && (
        <Card>
          <CardContent className="py-12">
            <div className="text-center space-y-4">
              <div className="mx-auto w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center">
                <Globe className="h-6 w-6 text-gray-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold">{t('notDeployed')}</h3>
                <p className="text-gray-500 mt-1">
                  Caddy is deployed by Spine. Run <code className="bg-gray-100 px-1 rounded text-sm">spine deploy</code> to install all services.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Installed State */}
      {!loading && isInstalled && (
        <>
          <ProxyStatusCard
            status={caddyStatus}
            onAction={handleCaddyAction}
          />

          {isRunning && (
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Globe className="h-5 w-5 text-gray-600" />
                  <CardTitle className="text-lg">{t('domainConfig')}</CardTitle>
                </div>
                <CardDescription>
                  Set your domain name. TLS certificates will be auto-generated.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3">
                  <Input
                    value={domainInput}
                    onChange={(e) => setDomainInput(e.target.value)}
                    placeholder="example.com"
                    className="max-w-xs"
                    disabled={savingDomain}
                  />
                  <Button 
                    onClick={saveDomain}
                    disabled={savingDomain || !domainInput.trim()}
                  >
                    {savingDomain ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      t('setDomain')
                    )}
                  </Button>
                  {domain && (
                    <div className="flex items-center gap-2 text-sm text-green-600">
                      <Shield className="h-4 w-4" />
                      TLS Active
                    </div>
                  )}
                </div>
                {domain && (
                  <p className="text-sm text-gray-500 mt-2">
                    Current domain: <span className="font-medium">{domain}</span>
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {isRunning && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">{t('containerRouting')}</CardTitle>
                <CardDescription>
                  Assign subdomains to your containers and optionally expose them on LAN ports
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ContainerRoutingTable 
                  domain={domain}
                  onRouteChange={fetchData}
                />
              </CardContent>
            </Card>
          )}

          {!isRunning && (
            <Card>
              <CardContent className="py-8">
                <div className="text-center text-gray-500">
                  Start Caddy to configure domain routing
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
