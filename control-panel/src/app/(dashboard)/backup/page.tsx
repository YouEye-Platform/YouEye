'use client';

import { useState, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  HardDrive,
  Shield,
  Check,
  AlertCircle,
  Loader2,
  Download,
  FolderOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { authenticatedFetch } from '@/lib/api-client';

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

const STAGE_LABELS: Record<string, string> = {
  'collect-configs': 'Collecting configuration',
  'dump-shared-postgres': 'Dumping shared databases',
  'dump-own-postgres': 'Dumping app databases',
  'spine-backup': 'Host-level backup operations',
  'stop-containers': 'Stopping containers',
  'export-volumes': 'Exporting volumes',
  'archive': 'Creating archive',
  'encrypt': 'Encrypting archive',
  'write-target': 'Writing to target',
  'restart-containers': 'Restarting containers',
  'completed': 'Completed',
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export default function BackupPage() {
  const [targetPath, setTargetPath] = useState('/mnt/backup');
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<BackupEvent[]>([]);
  const [currentEvent, setCurrentEvent] = useState<BackupEvent | null>(null);
  const [result, setResult] = useState<{ path: string; size: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const canStart =
    targetPath.trim().length > 0 &&
    passphrase.length >= 8 &&
    passphrase === confirmPassphrase &&
    !running;

  async function startBackup() {
    setRunning(true);
    setEvents([]);
    setCurrentEvent(null);
    setResult(null);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await authenticatedFetch('/api/backup/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath: targetPath.trim(), passphrase }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const data = await response.json();
        setError(data.error || 'Backup request failed');
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
                setResult({
                  path: event.archivePath,
                  size: event.archiveSize || 0,
                });
              }

              if (event.status === 'error') {
                setError(event.detail || event.message);
              }
            } catch {
              // Skip malformed SSE lines
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
  }

  const progress = currentEvent?.progress || 0;
  const isCompleted = currentEvent?.status === 'completed';
  const isError = currentEvent?.status === 'error' || !!error;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Backup</h1>
        <p className="text-muted-foreground">
          Create an encrypted backup of your YouEye platform.
        </p>
      </div>

      {/* Configuration Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5" />
            Backup Configuration
          </CardTitle>
          <CardDescription>
            Configure the backup target and encryption settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="targetPath" className="flex items-center gap-2">
              <FolderOpen className="h-4 w-4" />
              Target Path
            </Label>
            <Input
              id="targetPath"
              value={targetPath}
              onChange={e => setTargetPath(e.target.value)}
              placeholder="/mnt/backup"
              disabled={running}
            />
            <p className="text-xs text-muted-foreground">
              Directory on the host where the encrypted archive will be saved.
              USB drives are typically mounted at /mnt/.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="passphrase" className="flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Encryption Passphrase
            </Label>
            <Input
              id="passphrase"
              type="password"
              value={passphrase}
              onChange={e => setPassphrase(e.target.value)}
              placeholder="Enter passphrase (min 8 characters)"
              disabled={running}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmPassphrase">Confirm Passphrase</Label>
            <Input
              id="confirmPassphrase"
              type="password"
              value={confirmPassphrase}
              onChange={e => setConfirmPassphrase(e.target.value)}
              placeholder="Confirm passphrase"
              disabled={running}
            />
            {confirmPassphrase && passphrase !== confirmPassphrase && (
              <p className="text-xs text-destructive">Passphrases do not match</p>
            )}
          </div>

          <Button
            onClick={startBackup}
            disabled={!canStart}
            className="w-full"
          >
            {running ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Backup in progress...
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                Start Backup
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Progress Card — shown during/after backup */}
      {(running || isCompleted || isError) && (
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
              {isCompleted
                ? 'Backup Complete'
                : isError
                  ? 'Backup Failed'
                  : 'Backup in Progress'}
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

            {/* Stage list */}
            <div className="space-y-1">
              {events
                .filter((e, i, arr) => {
                  // Deduplicate by stage — show latest event per stage
                  const lastIdx = arr.findLastIndex(ev => ev.stage === e.stage);
                  return i === lastIdx;
                })
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

            {/* Error detail */}
            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}

            {/* Result */}
            {result && (
              <div className="rounded-md bg-green-50 dark:bg-green-950/20 p-4 space-y-2">
                <p className="font-medium text-green-700 dark:text-green-400">
                  Archive saved successfully
                </p>
                <div className="text-sm space-y-1">
                  <p>
                    <span className="text-muted-foreground">Path:</span>{' '}
                    <code className="text-xs bg-muted px-1 py-0.5 rounded">
                      {result.path}
                    </code>
                  </p>
                  <p>
                    <span className="text-muted-foreground">Size:</span>{' '}
                    {formatBytes(result.size)}
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
