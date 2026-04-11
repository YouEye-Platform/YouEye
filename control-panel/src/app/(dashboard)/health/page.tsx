'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  RefreshCw, Activity, Shield, Globe, Database, Server,
  RotateCcw, Clock, Cpu, MemoryStick, AlertTriangle,
} from 'lucide-react';
import { authenticatedFetch } from '@/lib/api-client';

type ServiceStatus = 'running' | 'stopped' | 'error' | 'degraded' | 'unknown';

interface ServiceHealth {
  name: string;
  slug: string;
  status: ServiceStatus;
  uptime: string;
  version: string;
  lastCheck: string;
  cpu: number;
  cpuPercent: number;
  memory: number;
  restartable: boolean;
}

const SERVICE_ICONS: Record<string, typeof Activity> = {
  authentik: Shield,
  pihole: Globe,
  caddy: Globe,
  postgres: Database,
  spine: Server,
};

const STATUS_COLORS: Record<ServiceStatus, { bg: string; text: string; dot: string }> = {
  running: { bg: 'bg-green-50', text: 'text-green-700', dot: 'bg-green-500' },
  stopped: { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500' },
  error: { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500' },
  degraded: { bg: 'bg-yellow-50', text: 'text-yellow-700', dot: 'bg-yellow-500' },
  unknown: { bg: 'bg-gray-50', text: 'text-gray-500', dot: 'bg-gray-400' },
};

function StatusBadge({ status }: { status: ServiceStatus }) {
  const colors = STATUS_COLORS[status];
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${colors.bg} ${colors.text}`}>
      <span className={`w-2 h-2 rounded-full ${colors.dot}`} />
      {label}
    </span>
  );
}

function MemoryBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            pct > 80 ? 'bg-red-500' : pct > 60 ? 'bg-yellow-500' : 'bg-blue-500'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-gray-500 tabular-nums w-16 text-right">{value} MB</span>
    </div>
  );
}

export default function HealthPage() {
  const t = useTranslations('health');
  const tc = useTranslations('common');
  const [services, setServices] = useState<ServiceHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [restartingSlug, setRestartingSlug] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      setError('');
      const res = await fetch('/api/health/services');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data: ServiceHealth[] = await res.json();
      setServices(data);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load health data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 30000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  const handleRestart = async (slug: string) => {
    setRestartingSlug(slug);
    try {
      const res = await authenticatedFetch(`/api/health/services/${slug}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Restart failed');
      }
      // Wait briefly then refresh
      await new Promise(r => setTimeout(r, 2000));
      await fetchHealth();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restart failed');
    } finally {
      setRestartingSlug(null);
    }
  };

  const degradedOrStopped = services.filter(
    s => s.status === 'degraded' || s.status === 'stopped' || s.status === 'error'
  );

  // Find max memory for scaling bars
  const maxMemory = Math.max(...services.map(s => s.memory), 512);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-gray-500 mt-1">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-xs text-gray-400">
              {t('lastUpdated')}: {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={fetchHealth}
            disabled={loading}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            {tc('refresh')}
          </Button>
        </div>
      </div>

      {/* Alert banner for degraded services */}
      {degradedOrStopped.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            {t('servicesDown', { count: degradedOrStopped.length })}:{' '}
            {degradedOrStopped.map(s => s.name).join(', ')}
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Service cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {services.map(service => {
          const Icon = SERVICE_ICONS[service.slug] || Activity;
          const isRestarting = restartingSlug === service.slug;

          return (
            <Card key={service.slug} className="relative">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${
                      service.status === 'running' ? 'bg-blue-100' : 'bg-gray-100'
                    }`}>
                      <Icon className={`h-5 w-5 ${
                        service.status === 'running' ? 'text-blue-600' : 'text-gray-400'
                      }`} />
                    </div>
                    <div>
                      <CardTitle className="text-base">{service.name}</CardTitle>
                      {service.version && (
                        <p className="text-xs text-gray-400">v{service.version}</p>
                      )}
                    </div>
                  </div>
                  <StatusBadge status={service.status} />
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Uptime */}
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <Clock className="h-4 w-4 text-gray-400" />
                  <span>{t('uptime')}: {service.uptime}</span>
                </div>

                {/* CPU */}
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <Cpu className="h-4 w-4 text-gray-400" />
                  <span>
                    CPU:{' '}
                    {service.cpuPercent === -2
                      ? 'N/A'
                      : service.cpuPercent === -1
                        ? '—'
                        : `${service.cpuPercent}%`}
                  </span>
                </div>

                {/* Memory */}
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <MemoryStick className="h-4 w-4 text-gray-400" />
                    <span>{t('memory')}</span>
                  </div>
                  <MemoryBar value={service.memory} max={maxMemory} />
                </div>

                {/* Restart button */}
                {service.restartable && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full mt-2"
                    onClick={() => handleRestart(service.slug)}
                    disabled={isRestarting}
                  >
                    <RotateCcw className={`h-4 w-4 mr-2 ${isRestarting ? 'animate-spin' : ''}`} />
                    {isRestarting ? t('restarting') : service.status === 'stopped' ? t('start') : t('restart')}
                  </Button>
                )}

                {/* PostgreSQL warning */}
                {service.slug === 'postgres' && service.status === 'running' && (
                  <p className="text-xs text-amber-600 mt-1">
                    {t('postgresWarning')}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Auto-refresh indicator */}
      <p className="text-xs text-gray-400 text-center">
        {t('autoRefresh')}
      </p>
    </div>
  );
}
