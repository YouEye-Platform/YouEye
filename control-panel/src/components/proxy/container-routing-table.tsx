'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { 
  Loader2,
  Check,
  AlertCircle,
  Server,
  Globe,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { authenticatedFetch } from '@/lib/api-client';
import { useTranslations } from 'next-intl';

interface RoutableContainer {
  name: string;
  displayName: string;
  status: string;
  webPort: number;
  currentRoute?: {
    type: 'subdomain' | 'path';
    value: string;
    hostname?: string;
  };
  lanPort?: {
    enabled: boolean;
    hostPort: number;
  };
}

interface ContainerRoutingTableProps {
  domain: string | null;
  onRouteChange?: () => void;
}

interface ContainerRowState {
  subdomain: string;
  lanEnabled: boolean;
  lanHostPort: string;
  saving: boolean;
  savingLan: boolean;
  error?: string;
  success?: string;
}

export function ContainerRoutingTable({ domain, onRouteChange }: ContainerRoutingTableProps) {
  const t = useTranslations('containerRouting');
  const [containers, setContainers] = useState<RoutableContainer[]>([]);
  const [loading, setLoading] = useState(true);
  const [rowStates, setRowStates] = useState<Record<string, ContainerRowState>>({});

  const fetchContainers = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/containers');
      if (response.ok) {
        const data = await response.json();
        setContainers(data.containers || []);
        
        const states: Record<string, ContainerRowState> = {};
        for (const container of data.containers || []) {
          states[container.name] = {
            subdomain: container.currentRoute?.type === 'subdomain'
              ? container.currentRoute.value
              : '',
            lanEnabled: container.lanPort?.enabled ?? false,
            lanHostPort: container.lanPort?.hostPort?.toString() ?? '',
            saving: false,
            savingLan: false,
          };
        }
        setRowStates(states);
      }
    } catch (error) {
      console.error('Failed to fetch containers:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchContainers();
  }, [fetchContainers]);

  const updateRowState = (containerName: string, updates: Partial<ContainerRowState>) => {
    setRowStates(prev => ({
      ...prev,
      [containerName]: { ...prev[containerName], ...updates },
    }));
  };

  const saveRoute = async (container: RoutableContainer) => {
    const state = rowStates[container.name];
    if (!state) return;

    updateRowState(container.name, { saving: true, error: undefined, success: undefined });

    try {
      const routeType = state.subdomain.trim() ? 'subdomain' : 'none';
      const response = await authenticatedFetch(`/api/containers/${container.name}/route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          routeType,
          routeValue: state.subdomain.trim(),
          port: container.webPort,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to save route');

      updateRowState(container.name, { saving: false, success: data.message });
      setTimeout(() => updateRowState(container.name, { success: undefined }), 3000);
      onRouteChange?.();
    } catch (error) {
      updateRowState(container.name, {
        saving: false,
        error: error instanceof Error ? error.message : 'Failed to save route',
      });
    }
  };

  const toggleLanPort = async (container: RoutableContainer) => {
    const state = rowStates[container.name];
    if (!state) return;

    const enabling = !state.lanEnabled;
    const hostPort = parseInt(state.lanHostPort, 10);

    if (enabling && (!hostPort || hostPort < 1 || hostPort > 65535)) {
      updateRowState(container.name, { error: t('validPort') });
      return;
    }

    // Optimistically update the checkbox state immediately
    updateRowState(container.name, { savingLan: true, lanEnabled: enabling, error: undefined, success: undefined });

    try {
      const response = await authenticatedFetch(`/api/containers/${container.name}/lan-port`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabling, hostPort }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to toggle LAN port');

      updateRowState(container.name, {
        savingLan: false,
        success: data.message,
      });
      setTimeout(() => updateRowState(container.name, { success: undefined }), 3000);
    } catch (error) {
      // Revert optimistic update on failure
      updateRowState(container.name, {
        savingLan: false,
        lanEnabled: !enabling,
        error: error instanceof Error ? error.message : 'Failed to toggle LAN port',
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (containers.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        <Server className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>{t('noContainers')}</p>
        <p className="text-sm mt-1">{t('installHint')}</p>
      </div>
    );
  }

  if (!domain) {
    return (
      <div className="text-center py-8 text-gray-500">
        <Globe className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>{t('setDomainHint')}</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b text-left text-sm text-gray-500">
            <th className="pb-3 font-medium">{t('container')}</th>
            <th className="pb-3 font-medium">{t('status')}</th>
            <th className="pb-3 font-medium">{t('subdomain')}</th>
            <th className="pb-3 font-medium">{t('lanPort')}</th>
            <th className="pb-3 font-medium w-24"></th>
          </tr>
        </thead>
        <tbody>
          {containers.map((container) => {
            const state = rowStates[container.name] || {
              subdomain: '', lanEnabled: false, lanHostPort: '', saving: false, savingLan: false,
            };
            const isRunning = container.status === 'running';
            
            return (
              <tr key={container.name} className="border-b last:border-0">
                <td className="py-3">
                  <div className="font-medium">{container.displayName}</div>
                  <div className="text-xs text-gray-500">{container.name}</div>
                </td>
                <td className="py-3">
                  <span className={cn(
                    "inline-flex items-center gap-1.5 text-sm",
                    isRunning ? "text-green-600" : "text-gray-400"
                  )}>
                    <span className={cn(
                      "w-2 h-2 rounded-full",
                      isRunning ? "bg-green-500" : "bg-gray-300"
                    )} />
                    {container.status}
                  </span>
                </td>
                <td className="py-3">
                  <div className="flex items-center gap-1">
                    <Input
                      value={state.subdomain}
                      onChange={(e) => updateRowState(container.name, {
                        subdomain: e.target.value,
                        error: undefined,
                        success: undefined,
                      })}
                      placeholder="control"
                      className="w-24"
                      disabled={state.saving}
                    />
                    <span className="text-sm text-gray-500">.{domain}</span>
                  </div>
                </td>
                <td className="py-3">
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={state.lanEnabled}
                        onChange={() => toggleLanPort(container)}
                        disabled={state.savingLan || (!state.lanEnabled && !state.lanHostPort)}
                        className="rounded"
                      />
                      <span className="text-sm text-gray-600">{t('expose')}</span>
                    </label>
                    <Input
                      type="number"
                      value={state.lanHostPort}
                      onChange={(e) => updateRowState(container.name, {
                        lanHostPort: e.target.value,
                        error: undefined,
                      })}
                      placeholder="8080"
                      className="w-20"
                      disabled={state.savingLan}
                      min={1} max={65535}
                    />
                    {state.savingLan && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
                  </div>
                </td>
                <td className="py-3">
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => saveRoute(container)}
                      disabled={state.saving}
                    >
                      {state.saving ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        t('save')
                      )}
                    </Button>
                    {state.success && <Check className="h-4 w-4 text-green-500" />}
                    {state.error && (
                      <span className="text-red-500 text-xs" title={state.error}>
                        <AlertCircle className="h-4 w-4" />
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-xs text-gray-500 mt-4">
        {t('subdomainHint', { domain })}
      </p>
    </div>
  );
}
