'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Server,
  Box,
  Cog,
  Monitor,
  Database,
  ShieldCheck,
  Globe,
  Shield,
  LayoutDashboard,
  Package,
  ArrowLeft,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Circle,
  MinusCircle,
  Play,
  Square,
  RotateCcw,
  ArrowUpCircle,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { authenticatedFetch } from '@/lib/api-client';
import { useTranslations } from 'next-intl';
import type { UnifiedApp, UnifiedAppsResponse } from '@/app/api/apps/unified/route';
import type { UpdateEvent } from '@/lib/apps/updater';

// ─── Icon map ─────────────────────────────────────────────────────────────────

const ICON_MAP: Record<string, typeof Package> = {
  Server, Box, Cog, Monitor, Database, ShieldCheck, Globe, Shield, LayoutDashboard,
};

// ─── Status badge ─────────────────────────────────────────────────────────────

// Status labels are resolved dynamically via useTranslations
const STATUS_STYLES: Record<string, { labelKey: string; className: string; Icon: typeof CheckCircle2 }> = {
  running:        { labelKey: 'running',       className: 'bg-green-100 text-green-700 border-green-200',   Icon: CheckCircle2 },
  stopped:        { labelKey: 'stopped',       className: 'bg-gray-100 text-gray-600 border-gray-200',     Icon: Circle },
  partial:        { labelKey: 'partial',       className: 'bg-amber-100 text-amber-700 border-amber-200',  Icon: MinusCircle },
  'not-installed':{ labelKey: 'notInstalled', className: 'bg-gray-50 text-gray-400 border-gray-100',      Icon: Circle },
  'not-found':    { labelKey: 'notFound',     className: 'bg-gray-50 text-gray-400 border-gray-100',      Icon: Circle },
  unknown:        { labelKey: 'unknown',       className: 'bg-gray-100 text-gray-500 border-gray-200',     Icon: AlertCircle },
};

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations('appDetail');
  const config = STATUS_STYLES[status] ?? STATUS_STYLES.unknown;
  return (
    <Badge variant="outline" className={config.className}>
      <config.Icon className="h-3 w-3" />
      {t(config.labelKey as Parameters<typeof t>[0])}
    </Badge>
  );
}

// ─── Main Detail Page ─────────────────────────────────────────────────────────

export default function AppDetailPage() {
  const t = useTranslations('appDetail');
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [app, setApp] = useState<UnifiedApp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [controlLoading, setControlLoading] = useState<Record<string, boolean>>({});
  const [updateState, setUpdateState] = useState<{
    active: boolean;
    events: UpdateEvent[];
    progress: number;
    stage: string;
  }>({ active: false, events: [], progress: 0, stage: '' });
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const eventSourceRef = useRef<ReadableStreamDefaultReader | null>(null);

  const fetchApp = useCallback(async () => {
    try {
      const res = await fetch('/api/apps/unified');
      if (!res.ok) throw new Error('Failed to load');
      const data: UnifiedAppsResponse = await res.json();
      const found = data.apps.find((a) => a.id === id);
      if (!found) throw new Error('App not found');
      setApp(found);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchApp();
    const interval = setInterval(fetchApp, 10_000);
    return () => clearInterval(interval);
  }, [fetchApp]);

  // Container control (start/stop/restart)
  const handleControl = async (containerName: string, action: 'start' | 'stop' | 'restart') => {
    setControlLoading((prev) => ({ ...prev, [containerName]: true }));
    try {
      await authenticatedFetch(`/api/incus/1.0/instances/${containerName}/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, force: action === 'stop', timeout: 30 }),
      });
      // Wait a moment then refresh
      await new Promise((r) => setTimeout(r, 3000));
      await fetchApp();
    } catch (err) {
      console.error('Control error:', err);
    } finally {
      setControlLoading((prev) => ({ ...prev, [containerName]: false }));
    }
  };

  // Update via SSE
  const handleUpdate = async () => {
    if (!app) return;
    setUpdateState({ active: true, events: [], progress: 0, stage: 'starting' });

    try {
      const res = await authenticatedFetch(`/api/apps/${app.id}/update`, {
        method: 'POST',
      });

      if (!res.body) {
        setUpdateState((prev) => ({
          ...prev,
          active: false,
          stage: 'failed',
          events: [...prev.events, { stage: 'failed', message: 'No response body' }],
        }));
        return;
      }

      const reader = res.body.getReader();
      eventSourceRef.current = reader;
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event: UpdateEvent = JSON.parse(line.slice(6));
              setUpdateState((prev) => ({
                active: event.stage !== 'completed' && event.stage !== 'failed',
                events: [...prev.events, event],
                progress: event.progress ?? prev.progress,
                stage: event.stage,
              }));
            } catch {
              // ignore parse errors
            }
          }
        }
      }
    } catch (err) {
      setUpdateState((prev) => ({
        ...prev,
        active: false,
        stage: 'failed',
        events: [
          ...prev.events,
          { stage: 'failed' as const, message: err instanceof Error ? err.message : 'Update failed' },
        ],
      }));
    } finally {
      eventSourceRef.current = null;
      // Refresh app data
      await fetchApp();
    }
  };

  // Check for update (single app)
  const handleCheckUpdate = async () => {
    if (!app) return;
    setCheckingUpdate(true);
    try {
      await authenticatedFetch(`/api/apps/${app.id}/check-update`, { method: 'POST' });
      await fetchApp();
    } catch {
      // ignore
    } finally {
      setCheckingUpdate(false);
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (error || !app) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => router.push('/apps')}>
          <ArrowLeft className="h-4 w-4 mr-1" /> {t('back')}
        </Button>
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 flex items-center gap-2 text-red-600">
          <AlertCircle className="h-5 w-5" />
          <span>{error ?? t('appNotFound')}</span>
        </div>
      </div>
    );
  }

  const Icon = ICON_MAP[app.icon] ?? Package;
  const isSystem = app.category === 'system' && app.containers.length === 0;
  const hasContainers = app.containers.length > 0;

  return (
    <div className="space-y-6">
      {/* Back + Header */}
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="mb-3 -ml-2"
          onClick={() => router.push('/apps')}
        >
          <ArrowLeft className="h-4 w-4 mr-1" /> {t('apps')}
        </Button>

        <div className="flex items-center gap-4">
          <div className={`p-3 rounded-xl ${isSystem ? 'bg-gray-100' : 'bg-blue-50'}`}>
            <Icon className={`h-7 w-7 ${isSystem ? 'text-gray-500' : 'text-blue-600'}`} />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-gray-900">{app.displayName}</h1>
              <StatusBadge status={app.status} />
            </div>
            <p className="text-gray-500 mt-0.5">{app.description}</p>
          </div>
          {app.version && (
            <span className="text-sm text-gray-400 font-mono">v{app.version}</span>
          )}
        </div>
      </div>

      {/* Info row */}
      <div className="flex flex-wrap gap-3">
        <Badge variant="secondary" className="capitalize">{app.category}</Badge>
        <Badge variant="outline" className="font-mono text-xs">{app.type}</Badge>
        <Badge variant="outline" className="text-xs">
          {t('managedBy', { manager: app.updatedBy === 'spine' ? 'Spine' : 'Control Panel' })}
        </Badge>
      </div>

      {/* Containers Section */}
      {hasContainers && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('containers')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y">
              {app.containers.map((container) => {
                const isLoading = controlLoading[container.name];
                const isRunning = container.status === 'running';
                const isStopped = container.status === 'stopped';

                return (
                  <div
                    key={container.name}
                    className="flex items-center gap-4 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="flex-1 min-w-0">
                      <span className="font-mono text-sm text-gray-700">{container.name}</span>
                      {container.ip && (
                        <span className="ml-2 text-xs text-gray-400 font-mono">{container.ip}</span>
                      )}
                    </div>

                    <StatusBadge status={container.status} />

                    {container.canControl && (
                      <div className="flex items-center gap-1.5">
                        {isRunning && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 w-8 p-0"
                              onClick={() => handleControl(container.name, 'restart')}
                              disabled={isLoading}
                              title="Restart"
                            >
                              {isLoading ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RotateCcw className="h-3.5 w-3.5" />
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 w-8 p-0"
                              onClick={() => handleControl(container.name, 'stop')}
                              disabled={isLoading}
                              title="Stop"
                            >
                              <Square className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                        {isStopped && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 w-8 p-0"
                            onClick={() => handleControl(container.name, 'start')}
                            disabled={isLoading}
                            title="Start"
                          >
                            {isLoading ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Play className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        )}
                        {!container.canControl && (
                          <span className="text-xs text-gray-400">{t('systemManaged')}</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Updates Section */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{t('updates')}</CardTitle>
            {app.updatedBy === 'control-panel' && app.type !== 'system' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCheckUpdate}
                disabled={checkingUpdate}
              >
                {checkingUpdate ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5 mr-1" />
                )}
                {t('check')}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {app.updateAvailable ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-amber-600">
                <ArrowUpCircle className="h-5 w-5" />
                <span className="font-medium">{t('updateAvailable')}</span>
                {app.updateInfo && (
                  <span className="text-sm text-amber-500">{app.updateInfo}</span>
                )}
              </div>

              {/* Progress bar during update */}
              {updateState.active && (
                <div className="space-y-2">
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all duration-300"
                      style={{ width: `${updateState.progress}%` }}
                    />
                  </div>
                  <p className="text-sm text-gray-500">
                    {updateState.events[updateState.events.length - 1]?.message ?? 'Starting...'}
                  </p>
                </div>
              )}

              {/* Completed/failed state */}
              {!updateState.active && updateState.stage === 'completed' && (
                <div className="flex items-center gap-2 text-green-600">
                  <CheckCircle2 className="h-4 w-4" />
                  <span className="text-sm">Update completed</span>
                </div>
              )}
              {!updateState.active && updateState.stage === 'failed' && (
                <div className="flex items-center gap-2 text-red-600">
                  <AlertCircle className="h-4 w-4" />
                  <span className="text-sm">
                    {updateState.events[updateState.events.length - 1]?.error ?? 'Update failed'}
                  </span>
                </div>
              )}

              <Button
                size="sm"
                onClick={handleUpdate}
                disabled={updateState.active}
              >
                {updateState.active ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                ) : (
                  <ArrowUpCircle className="h-4 w-4 mr-1.5" />
                )}
                {t('updateNow')}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-gray-500">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              <span className="text-sm">
                {app.updatedBy === 'spine' ? t('upToDateSpine') : t('upToDate')}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Management Links */}
      {app.managementLinks && app.managementLinks.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('management')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {app.managementLinks.map((link) => (
                <Link key={link.href} href={link.href}>
                  <Button variant="outline" size="sm">
                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                    {link.label}
                  </Button>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
