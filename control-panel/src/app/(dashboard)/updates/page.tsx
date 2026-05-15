'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  RefreshCw,
  Check,
  AlertCircle,
  Download,
  Server,
  Box,
  Monitor,
  Settings,
  Loader2,
  Container,
  AlertTriangle,
  ArrowUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { authenticatedFetch } from '@/lib/api-client';

interface ComponentUpdate {
  current: string;
  latest: string;
  available: boolean;
}

interface AppInfo {
  name: string;
  display_name: string;
  container_name: string;
  status: string;
  image_tag: string;
  available: boolean;
}

interface UpdatesData {
  checked_at: string;
  spine: ComponentUpdate;
  control: ComponentUpdate;
  ui?: ComponentUpdate;
  incus?: { current: string; upgradeable: boolean };
  system?: { upgradeable_count: number };
  apps?: AppInfo[];
}

interface PersistentStatus {
  component: string;
  status: string;
  progress: number;
  message: string;
  version_before: string | null;
  version_after: string | null;
  error: string | null;
  started_at: string | null;
  updated_at: string;
}

const componentInfo: Record<string, { name: string; description: string; icon: React.ComponentType<{ className?: string }> }> = {
  spine: { name: 'YE-Spine', description: 'System management service', icon: Settings },
  control: { name: 'Control Panel', description: 'Web management interface', icon: Monitor },
  ui: { name: 'YouEye UI', description: 'User dashboard', icon: Monitor },
  incus: { name: 'Incus', description: 'Container management', icon: Box },
  system: { name: 'System', description: 'Host OS packages', icon: Server },
};

const SELF_DESTRUCTIVE = new Set(['control']);

export default function UpdatesPage() {
  const t = useTranslations('settings.updates');
  const [updates, setUpdates] = useState<UpdatesData | null>(null);
  const [checking, setChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [persistentStatuses, setPersistentStatuses] = useState<Map<string, PersistentStatus>>(new Map());
  const [confirmComponent, setConfirmComponent] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkForUpdates = useCallback(async () => {
    setChecking(true);
    try {
      const response = await fetch('/api/updates');
      if (!response.ok) throw new Error('Failed to check updates');
      const data = await response.json();
      setUpdates(data);
      setLastChecked(new Date().toLocaleTimeString());
    } catch (error) {
      console.error('Failed to check updates:', error);
    } finally {
      setChecking(false);
    }
  }, []);

  const fetchStatuses = useCallback(async () => {
    try {
      const response = await fetch('/api/updates/status');
      if (!response.ok) return;
      const data = await response.json();
      const map = new Map<string, PersistentStatus>();
      for (const s of data.statuses || []) {
        map.set(s.component, s);
      }
      setPersistentStatuses(map);
    } catch {
      // Ignore — status fetch is best-effort
    }
  }, []);

  useEffect(() => {
    checkForUpdates();
    fetchStatuses();
  }, [checkForUpdates, fetchStatuses]);

  // Poll for status updates when any update is in progress
  useEffect(() => {
    const hasActive = Array.from(persistentStatuses.values()).some(
      s => !['idle', 'completed', 'failed'].includes(s.status)
    );

    if (hasActive && !pollingRef.current) {
      pollingRef.current = setInterval(fetchStatuses, 2000);
    } else if (!hasActive && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
      // Refresh version info after updates complete
      checkForUpdates();
    }

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [persistentStatuses, fetchStatuses, checkForUpdates]);

  const triggerUpdate = async (component: string) => {
    // For self-destructive updates, show confirmation first
    if (SELF_DESTRUCTIVE.has(component) && confirmComponent !== component) {
      setConfirmComponent(component);
      return;
    }
    setConfirmComponent(null);

    try {
      const response = await authenticatedFetch(`/api/updates/${component}`, {
        method: 'POST',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Update failed');
      }

      // Start polling for status
      fetchStatuses();
      if (!pollingRef.current) {
        pollingRef.current = setInterval(fetchStatuses, 2000);
      }
    } catch (error) {
      console.error(`Update ${component} failed:`, error);
    }
  };

  const renderInlineProgress = (component: string) => {
    const ps = persistentStatuses.get(component);
    if (!ps || ps.status === 'idle') return null;

    const isActive = !['completed', 'failed'].includes(ps.status);
    const isCompleted = ps.status === 'completed';
    const isFailed = ps.status === 'failed';

    return (
      <div className="mt-3 space-y-2">
        <div className="flex items-center gap-2 text-sm">
          {isActive && <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />}
          {isCompleted && <Check className="h-3.5 w-3.5 text-green-600" />}
          {isFailed && <AlertCircle className="h-3.5 w-3.5 text-red-600" />}
          <span className={cn(
            isActive && "text-blue-700",
            isCompleted && "text-green-700",
            isFailed && "text-red-700",
          )}>
            {ps.message}
          </span>
        </div>
        {isActive && (
          <Progress value={ps.progress} className="h-2" />
        )}
        {isCompleted && ps.version_after && (
          <div className="text-sm text-green-600 font-medium">
            Updated to v{ps.version_after}
          </div>
        )}
        {isFailed && ps.error && (
          <div className="text-sm text-red-600">{ps.error}</div>
        )}
      </div>
    );
  };

  const renderComponentCard = (key: string, data?: ComponentUpdate) => {
    const info = componentInfo[key];
    if (!info) return null;
    const Icon = info.icon;
    const ps = persistentStatuses.get(key);
    const isUpdating = ps && !['idle', 'completed', 'failed'].includes(ps.status);
    const hasUpdate = data?.available ?? false;
    const current = data?.current ?? 'Unknown';
    const latest = data?.latest ?? 'Unknown';

    return (
      <Card key={key} className={cn(
        "transition-all",
        hasUpdate && "border-amber-200 bg-amber-50/30"
      )}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={cn("p-2 rounded-lg", hasUpdate ? "bg-amber-100" : "bg-gray-100")}>
                <Icon className={cn("h-5 w-5", hasUpdate ? "text-amber-600" : "text-gray-600")} />
              </div>
              <div>
                <CardTitle className="text-lg">{info.name}</CardTitle>
                <CardDescription>{info.description}</CardDescription>
              </div>
            </div>
            {hasUpdate ? (
              <div className="flex items-center gap-1 text-amber-600 text-sm font-medium">
                <AlertCircle className="h-4 w-4" /> Update Available
              </div>
            ) : (
              <div className="flex items-center gap-1 text-green-600 text-sm font-medium">
                <Check className="h-4 w-4" /> Up to date
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <div className="text-sm">
                <span className="text-gray-500">Current:</span>{' '}
                <span className="font-mono font-medium">{current}</span>
              </div>
              {hasUpdate && (
                <div className="text-sm">
                  <span className="text-gray-500">Latest:</span>{' '}
                  <span className="font-mono font-medium text-amber-600">{latest}</span>
                </div>
              )}
            </div>
            <Button
              variant={hasUpdate ? "default" : "outline"}
              size="sm"
              onClick={() => triggerUpdate(key)}
              disabled={!!isUpdating || (!hasUpdate && key !== 'system')}
            >
              {isUpdating ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Updating...</>
              ) : (
                <><Download className="h-4 w-4 mr-2" /> {hasUpdate ? 'Update' : 'Up to date'}</>
              )}
            </Button>
          </div>

          {/* Confirmation dialog for self-destructive updates */}
          {confirmComponent === key && (
            <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
                <div className="space-y-2">
                  <p className="text-sm text-amber-800 font-medium">
                    This will restart {info.name}. The page may become temporarily unavailable.
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="destructive" onClick={() => triggerUpdate(key)}>
                      Continue Update
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setConfirmComponent(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {renderInlineProgress(key)}
        </CardContent>
      </Card>
    );
  };

  const renderIncusCard = () => {
    const info = componentInfo.incus;
    const Icon = info.icon;
    const incus = updates?.incus;
    const hasUpdate = incus?.upgradeable ?? false;
    const ps = persistentStatuses.get('incus');
    const isUpdating = ps && !['idle', 'completed', 'failed'].includes(ps.status);

    return (
      <Card className={cn("transition-all", hasUpdate && "border-amber-200 bg-amber-50/30")}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={cn("p-2 rounded-lg", hasUpdate ? "bg-amber-100" : "bg-gray-100")}>
                <Icon className={cn("h-5 w-5", hasUpdate ? "text-amber-600" : "text-gray-600")} />
              </div>
              <div>
                <CardTitle className="text-lg">{info.name}</CardTitle>
                <CardDescription>{info.description}</CardDescription>
              </div>
            </div>
            {hasUpdate ? (
              <div className="flex items-center gap-1 text-amber-600 text-sm font-medium">
                <AlertCircle className="h-4 w-4" /> Update Available
              </div>
            ) : (
              <div className="flex items-center gap-1 text-green-600 text-sm font-medium">
                <Check className="h-4 w-4" /> Up to date
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="text-sm">
              <span className="text-gray-500">Version:</span>{' '}
              <span className="font-mono font-medium">{incus?.current ?? 'Unknown'}</span>
            </div>
            <Button variant={hasUpdate ? "default" : "outline"} size="sm" onClick={() => triggerUpdate('incus')} disabled={!!isUpdating || !hasUpdate}>
              {isUpdating ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Updating...</> : <><Download className="h-4 w-4 mr-2" /> {hasUpdate ? 'Update' : 'Up to date'}</>}
            </Button>
          </div>
          {renderInlineProgress('incus')}
        </CardContent>
      </Card>
    );
  };

  const renderSystemCard = () => {
    const info = componentInfo.system;
    const Icon = info.icon;
    const sys = updates?.system;
    const count = sys?.upgradeable_count ?? 0;
    const hasUpdate = count > 0;
    const ps = persistentStatuses.get('system');
    const isUpdating = ps && !['idle', 'completed', 'failed'].includes(ps.status);

    return (
      <Card className={cn("transition-all", hasUpdate && "border-amber-200 bg-amber-50/30")}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={cn("p-2 rounded-lg", hasUpdate ? "bg-amber-100" : "bg-gray-100")}>
                <Icon className={cn("h-5 w-5", hasUpdate ? "text-amber-600" : "text-gray-600")} />
              </div>
              <div>
                <CardTitle className="text-lg">{info.name}</CardTitle>
                <CardDescription>{info.description}</CardDescription>
              </div>
            </div>
            {hasUpdate ? (
              <div className="flex items-center gap-1 text-amber-600 text-sm font-medium">
                <AlertCircle className="h-4 w-4" /> {count} package{count !== 1 ? 's' : ''} upgradeable
              </div>
            ) : (
              <div className="flex items-center gap-1 text-green-600 text-sm font-medium">
                <Check className="h-4 w-4" /> Up to date
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-500">{count} packages can be upgraded</div>
            <Button variant={hasUpdate ? "default" : "outline"} size="sm" onClick={() => triggerUpdate('system')} disabled={!!isUpdating}>
              {isUpdating ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Updating...</> : <><Download className="h-4 w-4 mr-2" /> {hasUpdate ? 'Update All' : 'Check & Update'}</>}
            </Button>
          </div>
          {renderInlineProgress('system')}
        </CardContent>
      </Card>
    );
  };

  const renderAppCard = (app: AppInfo) => {
    const key = app.name;
    const isRunning = app.status === 'running';
    const ps = persistentStatuses.get(key);
    const isUpdating = ps && !['idle', 'completed', 'failed'].includes(ps.status);

    return (
      <Card key={key} className="transition-all">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-100">
                <Container className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <CardTitle className="text-lg">{app.display_name}</CardTitle>
                <CardDescription className="font-mono text-xs">{app.container_name}</CardDescription>
              </div>
            </div>
            <span className={cn(
              "inline-flex items-center gap-1.5 text-sm font-medium",
              isRunning ? "text-green-600" : "text-gray-400"
            )}>
              <span className={cn("w-2 h-2 rounded-full", isRunning ? "bg-green-500" : "bg-gray-300")} />
              {app.status}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-500 font-mono truncate max-w-[200px]" title={app.image_tag || 'unknown'}>
              {app.image_tag || 'latest'}
            </div>
            <Button variant="outline" size="sm" onClick={() => triggerUpdate(key)} disabled={!!isUpdating || !isRunning}>
              {isUpdating ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Rebuilding...</> : <><RefreshCw className="h-4 w-4 mr-2" /> Rebuild</>}
            </Button>
          </div>
          {renderInlineProgress(key)}
        </CardContent>
      </Card>
    );
  };

  // Compute which components have updates and sort them to the top
  const updatableComponents: string[] = [];
  const upToDateComponents: string[] = [];

  if (updates?.spine?.available) updatableComponents.push('spine');
  else upToDateComponents.push('spine');

  if (updates?.control?.available) updatableComponents.push('control');
  else upToDateComponents.push('control');

  if (updates?.ui?.available) updatableComponents.push('ui');
  // ui might not exist in the response yet

  if (updates?.incus?.upgradeable) updatableComponents.push('incus');
  else upToDateComponents.push('incus');

  if ((updates?.system?.upgradeable_count ?? 0) > 0) updatableComponents.push('system');
  else upToDateComponents.push('system');

  const totalUpdates = updatableComponents.length;

  const renderByKey = (key: string) => {
    switch (key) {
      case 'spine': return renderComponentCard('spine', updates?.spine);
      case 'control': return renderComponentCard('control', updates?.control);
      case 'ui': return updates?.ui ? renderComponentCard('ui', updates.ui) : null;
      case 'incus': return renderIncusCard();
      case 'system': return renderSystemCard();
      default: return null;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-gray-500">
            {t('manageComponents')}
            {lastChecked && <span className="ml-2 text-sm">· Last checked: {lastChecked}</span>}
          </p>
        </div>
        <Button variant="outline" onClick={checkForUpdates} disabled={checking}>
          {checking ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('checking')}</> : <><RefreshCw className="h-4 w-4 mr-2" /> {t('checkForUpdates')}</>}
        </Button>
      </div>

      {/* Updates Available Section */}
      {totalUpdates > 0 && (
        <>
          <div className="flex items-center gap-2 text-amber-700 font-semibold">
            <ArrowUp className="h-5 w-5" />
            Updates Available ({totalUpdates})
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {updatableComponents.map(key => (
              <div key={key}>{renderByKey(key)}</div>
            ))}
          </div>
        </>
      )}

      {/* Up to Date Components */}
      {upToDateComponents.length > 0 && (
        <>
          <h2 className="text-lg font-semibold text-gray-900 pt-2">Components</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {upToDateComponents.map(key => (
              <div key={key}>{renderByKey(key)}</div>
            ))}
          </div>
        </>
      )}

      {/* App Containers */}
      {updates?.apps && updates.apps.length > 0 && (
        <>
          <h2 className="text-lg font-semibold text-gray-900 pt-2">App Containers</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {updates.apps.map(app => renderAppCard(app))}
          </div>
        </>
      )}

      {/* Info */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">Update Information</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-gray-600 space-y-2">
          <p><strong>Spine:</strong> Downloads from GitHub releases. The API service restarts automatically.</p>
          <p><strong>Control Panel:</strong> A snapshot is created before updating for rollback. This page will briefly become unavailable during the update.</p>
          <p><strong>Incus:</strong> Updates via system package manager (apt).</p>
          <p><strong>System:</strong> Runs apt upgrade on the host. May require reboot for kernel updates.</p>
          <p><strong>App Containers:</strong> Rebuild pulls the latest OCI image. A snapshot is taken before rebuild for rollback.</p>
        </CardContent>
      </Card>
    </div>
  );
}
