'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  HardDrive,
  Shield,
  Check,
  AlertCircle,
  Loader2,
  Download,
  FolderOpen,
  Clock,
  Calendar,
  Settings,
  History,
  RotateCcw,
  Play,
  Archive,
  Trash2,
  Save,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { authenticatedFetch } from '@/lib/api-client';

// ─── Types ──────────────────────────────────────────────────

interface BackupEvent {
  step: number;
  totalSteps: number;
  status: 'progress' | 'completed' | 'error';
  stage: string;
  message: string;
  detail?: string;
  progress?: number;
  archivePath?: string;
  archiveSize?: number;
}

interface BackupIndexEntry {
  timestamp: string;
  archive_path: string;
  archive_size: number;
  version: string;
}

interface BackupIndex {
  last_updated: string;
  core: BackupIndexEntry[];
  apps: Record<string, BackupIndexEntry[]>;
}

interface BackupScheduleConfig {
  enabled: boolean;
  target_path: string;
  schedule: {
    core: {
      frequency: string;
      retention: number;
      time: string;
      last_run?: string;
    };
    default_app: {
      frequency: string;
      retention: number;
    };
    overrides: Record<string, {
      frequency: string;
      retention: number;
    }>;
  };
}

interface InstalledApp {
  appId: string;
  type: string;
  subdomain?: string;
  installedVersion?: string;
}

// ─── Helpers ────────────────────────────────────────────────

const STAGE_LABELS: Record<string, string> = {
  'collect-configs': 'Collecting configuration',
  'dump-shared-postgres': 'Dumping shared databases',
  'dump-own-postgres': 'Dumping app databases',
  'spine-backup': 'Host-level backup operations',
  'freeze-containers': 'Freezing containers',
  'snapshot-containers': 'Creating snapshots',
  'export-volumes': 'Exporting volumes',
  'unfreeze-containers': 'Resuming containers',
  'cleanup-snapshots': 'Cleaning up snapshots',
  'archive': 'Creating archive',
  'encrypt': 'Encrypting archive',
  'write-target': 'Writing to target',
  'stop-containers': 'Stopping containers',
  'restart-containers': 'Restarting containers',
  'restore-secrets': 'Restoring secrets',
  'restore-database': 'Restoring database',
  'restore-app': 'Restoring application',
  'restore-volumes': 'Restoring volumes',
  'restore-core': 'Restoring core platform',
  'health-check': 'Health check',
  'completed': 'Completed',
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch {
    return ts;
  }
}

function timeAgo(ts: string): string {
  try {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  } catch {
    return '';
  }
}

// ─── Tab type ───────────────────────────────────────────────

type TabId = 'schedule' | 'history' | 'manual';

// ─── SSE stream reader ──────────────────────────────────────

function useSSEStream() {
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<BackupEvent[]>([]);
  const [currentEvent, setCurrentEvent] = useState<BackupEvent | null>(null);
  const [result, setResult] = useState<{ path: string; size: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setRunning(false);
    setEvents([]);
    setCurrentEvent(null);
    setResult(null);
    setError(null);
  }, []);

  const startStream = useCallback(async (url: string, body: Record<string, unknown>) => {
    reset();
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await authenticatedFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: 'Request failed' }));
        setError(data.error || `Request failed (${response.status})`);
        setRunning(false);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        setError('No response stream');
        setRunning(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event: BackupEvent = JSON.parse(line.slice(6));
              setEvents(prev => [...prev, event]);
              setCurrentEvent(event);

              if (event.status === 'completed' && event.archivePath) {
                setResult({ path: event.archivePath, size: event.archiveSize || 0 });
              }
              if (event.status === 'error') {
                setError(event.detail || event.message);
              }
            } catch {
              // Skip malformed SSE
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setError(String(err));
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [reset]);

  return { running, events, currentEvent, result, error, startStream, reset };
}

// ─── Progress display component ─────────────────────────────

function ProgressDisplay({
  events,
  currentEvent,
  result,
  error,
}: {
  events: BackupEvent[];
  currentEvent: BackupEvent | null;
  result: { path: string; size: number } | null;
  error: string | null;
}) {
  const progress = currentEvent?.progress || 0;
  const isCompleted = currentEvent?.status === 'completed';
  const isError = currentEvent?.status === 'error' || !!error;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {isCompleted ? (
            <Check className="h-5 w-5 text-green-500" />
          ) : isError ? (
            <AlertCircle className="h-5 w-5 text-destructive" />
          ) : (
            <Loader2 className="h-5 w-5 animate-spin" />
          )}
          {isCompleted ? 'Complete' : isError ? 'Failed' : 'In Progress'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Progress
          value={progress}
          className={cn(
            'h-3',
            isError && 'bg-destructive/20',
            isCompleted && 'bg-green-500/20'
          )}
        />

        <div className="space-y-1">
          {events
            .filter((e, i, arr) => i === arr.findLastIndex(ev => ev.stage === e.stage))
            .map((event, idx) => (
              <div
                key={`${event.stage}-${idx}`}
                className={cn(
                  'flex items-center gap-2 text-sm py-1 px-2 rounded',
                  event.status === 'completed' && 'text-green-600',
                  event.status === 'error' && 'text-destructive',
                  event === currentEvent && event.status === 'progress' && 'bg-accent'
                )}
              >
                {event.status === 'completed' ? (
                  <Check className="h-3 w-3 flex-shrink-0" />
                ) : event.status === 'error' ? (
                  <AlertCircle className="h-3 w-3 flex-shrink-0" />
                ) : event === currentEvent ? (
                  <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />
                ) : (
                  <Check className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                )}
                <span>{STAGE_LABELS[event.stage] || event.stage}</span>
                <span className="text-xs text-muted-foreground ml-auto">
                  {event.message}
                </span>
              </div>
            ))}
        </div>

        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {result && (
          <div className="rounded-md bg-green-50 dark:bg-green-950/20 p-4 space-y-2">
            <p className="font-medium text-green-700 dark:text-green-400">
              Archive saved successfully
            </p>
            <div className="text-sm space-y-1">
              <p>
                <span className="text-muted-foreground">Path:</span>{' '}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">{result.path}</code>
              </p>
              <p>
                <span className="text-muted-foreground">Size:</span> {formatBytes(result.size)}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Schedule Tab ───────────────────────────────────────────

function ScheduleTab({
  config,
  setConfig,
  apps,
  onSave,
  saving,
}: {
  config: BackupScheduleConfig;
  setConfig: (c: BackupScheduleConfig) => void;
  apps: InstalledApp[];
  onSave: () => void;
  saving: boolean;
}) {
  const updateSchedule = (path: string, value: unknown) => {
    const next = { ...config, schedule: { ...config.schedule } };
    const parts = path.split('.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let obj: any = next.schedule;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof obj[parts[i]] === 'object' && obj[parts[i]] !== null) {
        obj[parts[i]] = { ...obj[parts[i]] };
      }
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
    setConfig(next);
  };

  const getAppFrequency = (appId: string) => {
    return config.schedule.overrides[appId]?.frequency || config.schedule.default_app.frequency;
  };

  const getAppRetention = (appId: string) => {
    return config.schedule.overrides[appId]?.retention || config.schedule.default_app.retention;
  };

  const setAppOverride = (appId: string, field: 'frequency' | 'retention', value: string | number) => {
    const next = { ...config, schedule: { ...config.schedule, overrides: { ...config.schedule.overrides } } };
    if (!next.schedule.overrides[appId]) {
      next.schedule.overrides[appId] = {
        frequency: config.schedule.default_app.frequency,
        retention: config.schedule.default_app.retention,
      };
    }
    next.schedule.overrides[appId] = { ...next.schedule.overrides[appId], [field]: value };
    setConfig(next);
  };

  return (
    <div className="space-y-6">
      {/* Backup target */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FolderOpen className="h-4 w-4" />
            Backup Target
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Label className="w-32">Enabled</Label>
            <Button
              variant={config.enabled ? 'default' : 'outline'}
              size="sm"
              onClick={() => setConfig({ ...config, enabled: !config.enabled })}
            >
              {config.enabled ? 'On' : 'Off'}
            </Button>
          </div>
          <div className="space-y-2">
            <Label>Target Path</Label>
            <Input
              value={config.target_path}
              onChange={e => setConfig({ ...config, target_path: e.target.value })}
              placeholder="/mnt/backup"
            />
            <p className="text-xs text-muted-foreground">
              Directory where backups will be stored. USB drives are typically at /mnt/.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Core schedule */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4" />
            Core Platform Backup
          </CardTitle>
          <CardDescription>
            System configuration, users, SSO, DNS, and certificates. Always backed up.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Frequency</Label>
              <Select
                value={config.schedule.core.frequency}
                onValueChange={v => updateSchedule('core.frequency', v)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Keep</Label>
              <Input
                type="number"
                min={1}
                max={365}
                value={config.schedule.core.retention}
                onChange={e => updateSchedule('core.retention', parseInt(e.target.value) || 7)}
              />
            </div>
            <div className="space-y-2">
              <Label>Time</Label>
              <Input
                type="time"
                value={config.schedule.core.time}
                onChange={e => updateSchedule('core.time', e.target.value)}
              />
            </div>
          </div>
          {config.schedule.core.last_run && (
            <p className="text-xs text-muted-foreground mt-2">
              Last backup: {timeAgo(config.schedule.core.last_run)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Per-app schedule */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Archive className="h-4 w-4" />
            App Backups
          </CardTitle>
          <CardDescription>
            Per-app backup frequency. Set to &quot;Never&quot; for stateless apps.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Default */}
          <div className="flex items-center gap-4 pb-3 border-b">
            <span className="text-sm font-medium w-40">Default (new apps)</span>
            <div className="flex-1 grid grid-cols-2 gap-3">
              <Select
                value={config.schedule.default_app.frequency}
                onValueChange={v => updateSchedule('default_app.frequency', v)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="never">Never</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Keep</span>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={config.schedule.default_app.retention}
                  onChange={e => updateSchedule('default_app.retention', parseInt(e.target.value) || 7)}
                  className="w-20"
                />
              </div>
            </div>
          </div>

          {/* Per-app overrides */}
          {apps.map(app => (
            <div key={app.appId} className="flex items-center gap-4">
              <div className="w-40">
                <span className="text-sm">{app.appId}</span>
                {app.subdomain && (
                  <span className="text-xs text-muted-foreground ml-1">({app.subdomain})</span>
                )}
              </div>
              <div className="flex-1 grid grid-cols-2 gap-3">
                <Select
                  value={getAppFrequency(app.appId)}
                  onValueChange={v => setAppOverride(app.appId, 'frequency', v)}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="never">Never</SelectItem>
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Keep</span>
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    value={getAppRetention(app.appId)}
                    onChange={e => setAppOverride(app.appId, 'retention', parseInt(e.target.value) || 7)}
                    className="w-20"
                  />
                </div>
              </div>
            </div>
          ))}

          {apps.length === 0 && (
            <p className="text-sm text-muted-foreground">No apps installed yet.</p>
          )}
        </CardContent>
      </Card>

      {/* Passphrase */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4" />
            Encryption
          </CardTitle>
          <CardDescription>
            All backups are encrypted with AES-256. Set a passphrase you will need for restore.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label>Backup Passphrase</Label>
            <Input
              type="password"
              placeholder="Set or change passphrase (min 8 characters)"
              id="schedule-passphrase"
            />
            <p className="text-xs text-muted-foreground">
              Leave empty to keep the existing passphrase. You will need this to restore.
            </p>
          </div>
        </CardContent>
      </Card>

      <Button onClick={onSave} disabled={saving} className="w-full">
        {saving ? (
          <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving...</>
        ) : (
          <><Save className="mr-2 h-4 w-4" />Save Backup Configuration</>
        )}
      </Button>
    </div>
  );
}

// ─── History Tab ────────────────────────────────────────────

function HistoryTab({
  index,
  onRestore,
  restoreStream,
}: {
  index: BackupIndex | null;
  onRestore: (type: 'app' | 'core', appId: string, entry: BackupIndexEntry) => void;
  restoreStream: ReturnType<typeof useSSEStream>;
}) {
  if (!index) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <History className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p>No backups found. Configure a backup schedule or run a manual backup.</p>
        </CardContent>
      </Card>
    );
  }

  const allApps = Object.keys(index.apps || {});

  return (
    <div className="space-y-6">
      {/* Restore progress */}
      {(restoreStream.running || restoreStream.currentEvent) && (
        <ProgressDisplay
          events={restoreStream.events}
          currentEvent={restoreStream.currentEvent}
          result={restoreStream.result}
          error={restoreStream.error}
        />
      )}

      {/* Core backups */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4" />
            Core Platform Backups
          </CardTitle>
        </CardHeader>
        <CardContent>
          {(index.core?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No core backups yet.</p>
          ) : (
            <div className="space-y-2">
              {index.core.map((entry, i) => (
                <div key={i} className="flex items-center gap-3 text-sm py-2 px-3 rounded border">
                  <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span className="flex-1">{formatTimestamp(entry.timestamp)}</span>
                  <Badge variant="outline">{formatBytes(entry.archive_size)}</Badge>
                  {entry.version && <Badge variant="secondary">v{entry.version}</Badge>}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onRestore('core', '', entry)}
                    disabled={restoreStream.running}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    Restore
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-app backups */}
      {allApps.map(appId => (
        <Card key={appId}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Archive className="h-4 w-4" />
              {appId}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {(index.apps[appId] || []).map((entry, i) => (
                <div key={i} className="flex items-center gap-3 text-sm py-2 px-3 rounded border">
                  <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span className="flex-1">{formatTimestamp(entry.timestamp)}</span>
                  <Badge variant="outline">{formatBytes(entry.archive_size)}</Badge>
                  {entry.version && <Badge variant="secondary">v{entry.version}</Badge>}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onRestore('app', appId, entry)}
                    disabled={restoreStream.running}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    Restore
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── Manual Tab ─────────────────────────────────────────────

function ManualTab({
  apps,
  backupStream,
  restoreStream,
}: {
  apps: InstalledApp[];
  backupStream: ReturnType<typeof useSSEStream>;
  restoreStream: ReturnType<typeof useSSEStream>;
}) {
  const [targetPath, setTargetPath] = useState('/mnt/backup');
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [restorePath, setRestorePath] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [restoreAppId, setRestoreAppId] = useState('');

  const canBackup =
    targetPath.trim().length > 0 &&
    passphrase.length >= 8 &&
    passphrase === confirmPassphrase &&
    !backupStream.running;

  const startFullBackup = () => {
    backupStream.startStream('/api/backup/run', {
      targetPath: targetPath.trim(),
      passphrase,
    });
  };

  const startAppBackup = (appId: string) => {
    backupStream.startStream(`/api/backup/app/${appId}`, {
      targetPath: targetPath.trim(),
      passphrase,
    });
  };

  const startCoreBackup = () => {
    backupStream.startStream('/api/backup/core', {
      targetPath: targetPath.trim(),
      passphrase,
    });
  };

  const startAppRestore = () => {
    if (!restoreAppId || !restorePath || restorePassphrase.length < 8) return;
    restoreStream.startStream('/api/restore/app', {
      appId: restoreAppId,
      archivePath: restorePath.trim(),
      passphrase: restorePassphrase,
    });
  };

  return (
    <div className="space-y-6">
      {/* Progress displays */}
      {(backupStream.running || backupStream.currentEvent) && (
        <ProgressDisplay
          events={backupStream.events}
          currentEvent={backupStream.currentEvent}
          result={backupStream.result}
          error={backupStream.error}
        />
      )}
      {(restoreStream.running || restoreStream.currentEvent) && (
        <ProgressDisplay
          events={restoreStream.events}
          currentEvent={restoreStream.currentEvent}
          result={restoreStream.result}
          error={restoreStream.error}
        />
      )}

      {/* Manual backup */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Download className="h-4 w-4" />
            Manual Backup
          </CardTitle>
          <CardDescription>
            Run a one-off backup immediately.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Target Path</Label>
              <Input
                value={targetPath}
                onChange={e => setTargetPath(e.target.value)}
                placeholder="/mnt/backup"
                disabled={backupStream.running}
              />
            </div>
            <div className="space-y-2">
              <Label>Passphrase</Label>
              <Input
                type="password"
                value={passphrase}
                onChange={e => setPassphrase(e.target.value)}
                placeholder="Min 8 characters"
                disabled={backupStream.running}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Confirm Passphrase</Label>
            <Input
              type="password"
              value={confirmPassphrase}
              onChange={e => setConfirmPassphrase(e.target.value)}
              placeholder="Confirm passphrase"
              disabled={backupStream.running}
            />
            {confirmPassphrase && passphrase !== confirmPassphrase && (
              <p className="text-xs text-destructive">Passphrases do not match</p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={startFullBackup} disabled={!canBackup} variant="default">
              <Download className="mr-2 h-4 w-4" />
              Full Backup
            </Button>
            <Button onClick={startCoreBackup} disabled={!canBackup} variant="outline">
              <Shield className="mr-2 h-4 w-4" />
              Core Only
            </Button>
            {apps.map(app => (
              <Button
                key={app.appId}
                onClick={() => startAppBackup(app.appId)}
                disabled={!canBackup}
                variant="outline"
                size="sm"
              >
                <Play className="mr-1 h-3 w-3" />
                {app.appId}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Manual restore */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <RotateCcw className="h-4 w-4" />
            Restore from Archive
          </CardTitle>
          <CardDescription>
            Restore a specific app from an encrypted backup archive.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>App to Restore</Label>
              <Select value={restoreAppId} onValueChange={setRestoreAppId}>
                <SelectTrigger><SelectValue placeholder="Select app" /></SelectTrigger>
                <SelectContent>
                  {apps.map(app => (
                    <SelectItem key={app.appId} value={app.appId}>{app.appId}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Archive Path</Label>
              <Input
                value={restorePath}
                onChange={e => setRestorePath(e.target.value)}
                placeholder="/mnt/backup/youeye/apps/wiki/wiki-20260414.tar.enc"
                disabled={restoreStream.running}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Passphrase</Label>
            <Input
              type="password"
              value={restorePassphrase}
              onChange={e => setRestorePassphrase(e.target.value)}
              placeholder="Archive passphrase"
              disabled={restoreStream.running}
            />
          </div>
          <Button
            onClick={startAppRestore}
            disabled={!restoreAppId || !restorePath || restorePassphrase.length < 8 || restoreStream.running}
            variant="destructive"
          >
            {restoreStream.running ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Restoring...</>
            ) : (
              <><RotateCcw className="mr-2 h-4 w-4" />Restore App</>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────

export default function BackupPage() {
  const [activeTab, setActiveTab] = useState<TabId>('schedule');
  const [config, setConfig] = useState<BackupScheduleConfig>({
    enabled: false,
    target_path: '/mnt/backup',
    schedule: {
      core: { frequency: 'daily', retention: 7, time: '03:00' },
      default_app: { frequency: 'daily', retention: 7 },
      overrides: {},
    },
  });
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [index, setIndex] = useState<BackupIndex | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const backupStream = useSSEStream();
  const restoreStream = useSSEStream();

  const fetchData = useCallback(async () => {
    try {
      const [configRes, listRes, appsRes] = await Promise.allSettled([
        authenticatedFetch('/api/backup/config').then(r => r.ok ? r.json() : null),
        authenticatedFetch('/api/backup/list').then(r => r.ok ? r.json() : null),
        authenticatedFetch('/api/market/installed').then(r => r.ok ? r.json() : null),
      ]);

      if (configRes.status === 'fulfilled' && configRes.value) {
        setConfig(configRes.value);
      }
      if (listRes.status === 'fulfilled' && listRes.value) {
        setIndex(listRes.value);
      }
      if (appsRes.status === 'fulfilled' && appsRes.value) {
        setApps(Array.isArray(appsRes.value) ? appsRes.value : appsRes.value.apps || []);
      }
    } catch {
      // Will show defaults
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const saveConfig = async () => {
    setSaving(true);
    try {
      const passphraseEl = document.getElementById('schedule-passphrase') as HTMLInputElement;
      const passphrase = passphraseEl?.value || '';

      await authenticatedFetch('/api/backup/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...config,
          passphrase: passphrase.length >= 8 ? passphrase : undefined,
        }),
      });

      if (passphraseEl) passphraseEl.value = '';
    } catch {
      // Could add error toast here
    } finally {
      setSaving(false);
    }
  };

  const handleRestore = (type: 'app' | 'core', appId: string, entry: BackupIndexEntry) => {
    const passphrase = prompt('Enter backup passphrase to restore:');
    if (!passphrase || passphrase.length < 8) return;

    if (type === 'app') {
      restoreStream.startStream('/api/restore/app', {
        appId,
        archivePath: entry.archive_path,
        passphrase,
      });
    } else {
      restoreStream.startStream('/api/restore/full', {
        backupPath: entry.archive_path,
        passphrase,
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: 'schedule', label: 'Schedule', icon: <Settings className="h-4 w-4" /> },
    { id: 'history', label: 'History', icon: <History className="h-4 w-4" /> },
    { id: 'manual', label: 'Manual', icon: <Play className="h-4 w-4" /> },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Backup & Restore</h1>
        <p className="text-muted-foreground">
          Manage scheduled backups, view history, and restore apps or the full platform.
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors',
              activeTab === tab.id
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'schedule' && (
        <ScheduleTab
          config={config}
          setConfig={setConfig}
          apps={apps}
          onSave={saveConfig}
          saving={saving}
        />
      )}
      {activeTab === 'history' && (
        <HistoryTab
          index={index}
          onRestore={handleRestore}
          restoreStream={restoreStream}
        />
      )}
      {activeTab === 'manual' && (
        <ManualTab
          apps={apps}
          backupStream={backupStream}
          restoreStream={restoreStream}
        />
      )}
    </div>
  );
}
