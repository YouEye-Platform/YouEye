'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { StatsCard } from '@/components/dashboard/stats-card';
import { SystemInfo } from '@/components/dashboard/system-info';
import { ContainerList } from '@/components/containers/container-list';
import { Box, Cpu, HardDrive, Activity, AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { authenticatedFetch } from '@/lib/api-client';
import type { ContainerInfo, ServerInfo, SessionPayload } from '@/types';

interface ServiceHealthCompact {
  name: string;
  slug: string;
  status: 'running' | 'stopped' | 'error' | 'degraded' | 'unknown';
}

const HEALTH_DOT_COLORS: Record<string, string> = {
  running: 'bg-green-500',
  stopped: 'bg-red-500',
  error: 'bg-red-500',
  degraded: 'bg-yellow-500',
  unknown: 'bg-gray-400',
};

export default function DashboardPage() {
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [serviceHealth, setServiceHealth] = useState<ServiceHealthCompact[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch session
      const sessionRes = await fetch('/api/auth/session');
      if (sessionRes.ok) {
        const sessionData = await sessionRes.json();
        setSession(sessionData.user);
      }

      // Fetch containers
      const containersRes = await fetch('/api/incus/1.0/instances?recursion=2');
      if (containersRes.ok) {
        const containersData = await containersRes.json();
        if (containersData.metadata) {
          const containerList: ContainerInfo[] = containersData.metadata.map((c: any) => ({
            name: c.name,
            status: c.status,
            type: c.type,
            state: c.state,
          }));
          setContainers(containerList);
        }
      }

      // Fetch server info
      const serverRes = await fetch('/api/incus/1.0');
      if (serverRes.ok) {
        const serverData = await serverRes.json();
        if (serverData.metadata?.environment) {
          const env = serverData.metadata.environment;
          setServerInfo({
            server_name: serverData.metadata.config?.['core.name'] || 'Incus Server',
            server_version: env.server_version || 'Unknown',
            os_name: env.os_name || 'Unknown',
            os_version: env.os_version || 'Unknown',
            kernel_version: env.kernel_version || 'Unknown',
          });
        }
      }
      // Fetch service health for compact dots
      try {
        const healthRes = await fetch('/api/health/services');
        if (healthRes.ok) {
          const healthData: ServiceHealthCompact[] = await healthRes.json();
          setServiceHealth(healthData);
        }
      } catch {
        // Health data is supplementary — don't block dashboard
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

  const handleContainerAction = async (name: string, action: 'start' | 'stop' | 'restart') => {
    setActionLoading(name);
    try {
      const response = await authenticatedFetch(`/api/incus/1.0/instances/${name}/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Action failed');
      }
      
      // Wait a bit for the operation to complete
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Refresh the data
      await fetchData();
    } catch (error) {
      console.error('Container action failed:', error);
    } finally {
      setActionLoading(null);
    }
  };

  const t = useTranslations('dashboard');
  const tc = useTranslations('common');
  const runningCount = containers.filter(c => c.status === 'Running').length;
  const stoppedCount = containers.filter(c => c.status === 'Stopped').length;

  const unhealthyServices = serviceHealth.filter(
    s => s.status === 'stopped' || s.status === 'error' || s.status === 'degraded'
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        <p className="text-gray-500 mt-1">{t('subtitle')}</p>
      </div>

      {/* Service health dots */}
      {serviceHealth.length > 0 && (
        <Link href="/health" className="flex items-center gap-4 p-3 rounded-lg border bg-white hover:bg-gray-50 transition-colors">
          <span className="text-sm font-medium text-gray-700">{t('serviceHealth')}</span>
          <div className="flex items-center gap-2">
            {serviceHealth.map(s => (
              <div key={s.slug} className="flex items-center gap-1.5" title={`${s.name}: ${s.status}`}>
                <span className={`w-2.5 h-2.5 rounded-full ${HEALTH_DOT_COLORS[s.status] || 'bg-gray-400'}`} />
                <span className="text-xs text-gray-500">{s.name}</span>
              </div>
            ))}
          </div>
        </Link>
      )}

      {/* Degraded service banner */}
      {unhealthyServices.length > 0 && (
        <Link href="/health" className="flex items-center gap-3 p-3 rounded-lg border border-amber-200 bg-amber-50 hover:bg-amber-100 transition-colors">
          <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
          <span className="text-sm text-amber-800">
            {t('servicesDegraded', { names: unhealthyServices.map(s => s.name).join(', ') })}
          </span>
        </Link>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title={t('totalContainers')}
          value={containers.length}
          icon={Box}
          description={t('allInstances')}
          iconColor="text-blue-600"
          iconBgColor="bg-blue-100"
        />
        <StatsCard
          title={t('running')}
          value={runningCount}
          icon={Activity}
          description={t('activeInstances')}
          iconColor="text-green-600"
          iconBgColor="bg-green-100"
        />
        <StatsCard
          title={t('stopped')}
          value={stoppedCount}
          icon={Cpu}
          description={t('inactiveInstances')}
          iconColor="text-gray-600"
          iconBgColor="bg-gray-100"
        />
        <StatsCard
          title={t('server')}
          value={serverInfo?.server_version || tc('na')}
          icon={HardDrive}
          description={t('incusVersion')}
          iconColor="text-purple-600"
          iconBgColor="bg-purple-100"
        />
      </div>

      {/* System Info */}
      {serverInfo && <SystemInfo serverInfo={serverInfo} />}

      {/* Containers */}
      {session && (
        <ContainerList
          containers={containers}
          session={session}
          loading={loading}
          onRefresh={fetchData}
          onAction={handleContainerAction}
          actionLoading={actionLoading}
        />
      )}
    </div>
  );
}
