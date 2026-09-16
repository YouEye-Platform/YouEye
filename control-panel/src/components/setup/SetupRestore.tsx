'use client';

import { useState, useEffect, useRef } from 'react';
import { Loader2, CheckCircle2, XCircle, HardDrive, Lock, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type StepStatus = 'pending' | 'running' | 'done' | 'error';

interface RestoreStep {
  stage: string;
  message: string;
  status: StepStatus;
}

interface Props {
  onComplete: () => void;
  onBack: () => void;
}

interface RecoveryPoint {
  backupId: string;
  createdAt: string;
  apps: string[];
  mediaId?: string;
  driveName?: string;
}

export default function SetupRestore({ onComplete, onBack }: Props) {
  const [recoveryPoints, setRecoveryPoints] = useState<RecoveryPoint[]>([]);
  const [selectedBackupId, setSelectedBackupId] = useState('');
  const [selectedApps, setSelectedApps] = useState<string[]>([]);
  const [passphrase, setPassphrase] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [steps, setSteps] = useState<RestoreStep[]>([]);
  const [isComplete, setIsComplete] = useState(false);
  const [error, setError] = useState('');
  const hasCompleted = useRef(false);

  useEffect(() => {
    fetch('/api/setup/restore', { cache: 'no-store' })
      .then(response => response.ok ? response.json() : { recoveryPoints: [] })
      .then(body => {
        const points = Array.isArray(body.recoveryPoints) ? body.recoveryPoints as RecoveryPoint[] : [];
        setRecoveryPoints(points);
        if (points[0]) {
          setSelectedBackupId(points[0].backupId);
          setSelectedApps(points[0].apps);
        }
      })
      .catch(() => {});
  }, []);

  // Auto-advance on completion
  useEffect(() => {
    if (isComplete && !hasCompleted.current) {
      hasCompleted.current = true;
      const timer = setTimeout(onComplete, 2000);
      return () => clearTimeout(timer);
    }
  }, [isComplete, onComplete]);

  const selectedPoint = recoveryPoints.find(point => point.backupId === selectedBackupId);
  const canStart = Boolean(selectedPoint && passphrase.trim().length >= 12);

  const handleStartRestore = async () => {
    setRestoring(true);
    setError('');
    setSteps([]);
    setIsComplete(false);

    try {
      const csrfResponse = await fetch('/api/auth/csrf', { cache: 'no-store' });
      const csrfBody = await csrfResponse.json().catch(() => ({}));
      if (!csrfResponse.ok || typeof csrfBody.csrfToken !== 'string') throw new Error('Could not start a protected restore action.');
      const res = await fetch('/api/setup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfBody.csrfToken },
        body: JSON.stringify({
          mediaId: selectedPoint?.mediaId,
          backupId: selectedPoint?.backupId,
          appIds: selectedApps,
          passphrase: passphrase.trim(),
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Restore request failed (${res.status}): ${text || 'Unknown error'}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') {
            setIsComplete(true);
            continue;
          }
          try {
            const event = JSON.parse(data);
            if (event.stage && event.message) {
              setSteps(prev => {
                const existing = prev.find(s => s.stage === event.stage);
                const status: StepStatus =
                  event.status === 'completed' ? 'done' :
                  event.status === 'error' ? 'error' :
                  'running';
                if (existing) {
                  return prev.map(s =>
                    s.stage === event.stage
                      ? { ...s, message: event.message, status }
                      : s
                  );
                }
                return [...prev, { stage: event.stage, message: event.message, status }];
              });
            }
            if (event.complete) {
              setIsComplete(true);
            }
            if (event.error) {
              setError(event.error);
            }
          } catch {
            // Ignore malformed lines
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed');
    }
  };

  const completedSteps = steps.filter(s => s.status === 'done').length;
  const totalSteps = steps.length || 1;
  const progress = totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0;

  // Input form (before restore starts)
  if (!restoring) {
    return (
      <div className="w-full max-w-md mx-auto space-y-8">
        <div className="text-center animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-5">
            <HardDrive className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold mb-2">Restore from Backup</h1>
          <p className="text-muted-foreground text-sm">
            Restore the required YouEye configuration, then choose which applications to bring back.
          </p>
        </div>

        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-6 duration-500 delay-100">
          <div className="space-y-2">
            <Label htmlFor="recoveryPoint">Recovery point</Label>
            <select
              id="recoveryPoint"
              value={selectedBackupId}
              onChange={(event) => {
                const point = recoveryPoints.find(item => item.backupId === event.target.value);
                setSelectedBackupId(event.target.value);
                setSelectedApps(point?.apps ?? []);
              }}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {recoveryPoints.length === 0 && <option value="">No backup drive found</option>}
              {recoveryPoints.map(point => <option key={point.backupId} value={point.backupId}>{point.createdAt ? new Date(point.createdAt).toLocaleString() : point.backupId}{point.driveName ? ` — ${point.driveName}` : ''}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">YouEye configuration, accounts, and server identity are always restored.</p>
          </div>

          {selectedPoint && selectedPoint.apps.length > 0 && <fieldset className="space-y-2 rounded-lg border p-4">
            <legend className="px-1 text-sm font-medium">Applications</legend>
            {selectedPoint.apps.map(appId => <label key={appId} className="flex items-center gap-3 text-sm">
              <input type="checkbox" checked={selectedApps.includes(appId)} onChange={event => setSelectedApps(current => event.target.checked ? [...current, appId] : current.filter(item => item !== appId))} className="size-4 rounded border-input accent-primary" />
              <span>{appId}</span>
            </label>)}
          </fieldset>}

          <div className="space-y-2">
            <Label htmlFor="passphrase">Encryption passphrase</Label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="passphrase"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Enter passphrase"
                className="pl-10"
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between pt-4 animate-in fade-in slide-in-from-bottom-8 duration-500 delay-200">
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
          <Button onClick={handleStartRestore} disabled={!canStart}>
            Start Restore
          </Button>
        </div>
      </div>
    );
  }

  // Progress display (during/after restore)
  return (
    <div className="w-full max-w-md mx-auto text-center space-y-8">
      <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
        <h1 className="text-2xl font-bold mb-2">Restoring Your Platform</h1>
      </div>

      <div className="flex flex-col items-center gap-6 animate-in fade-in zoom-in-95 duration-500 delay-100">
        {isComplete ? (
          <div className="animate-in zoom-in-50 duration-300">
            <CheckCircle2 className="h-20 w-20 text-green-500" />
          </div>
        ) : error ? (
          <div className="animate-in zoom-in-50 duration-300">
            <XCircle className="h-20 w-20 text-red-500" />
          </div>
        ) : (
          <div className="relative">
            <div className="w-24 h-24 rounded-full border-4 border-muted animate-spin border-t-primary" />
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-sm font-bold text-foreground">{Math.round(progress)}%</span>
            </div>
          </div>
        )}

        <div className="h-8 flex items-center justify-center">
          {isComplete ? (
			<p className="text-green-600 font-medium animate-in fade-in duration-300">Restore complete. Sign in with a restored account…</p>
          ) : error ? (
            <p className="text-red-600 text-sm">{error}</p>
          ) : (
            <p className="text-muted-foreground text-sm">{steps.at(-1)?.message || 'Validating encrypted recovery point…'}</p>
          )}
        </div>

        {/* Progress bar */}
        <div className="w-full max-w-xs">
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out ${
                error ? 'bg-red-400' : isComplete ? 'bg-green-500' : 'bg-primary'
              }`}
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            {completedSteps} / {steps.length} steps complete
          </p>
        </div>

        {/* Step list */}
        {steps.length > 0 && (
          <div className="w-full text-left space-y-2 mt-4">
            {steps.map((s) => (
              <div key={s.stage} className="flex items-center gap-2 text-sm">
                {s.status === 'done' ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                ) : s.status === 'error' ? (
                  <XCircle className="h-4 w-4 text-red-500 shrink-0" />
                ) : (
                  <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                )}
                <span className={s.status === 'error' ? 'text-red-600' : 'text-foreground'}>
                  {s.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Error retry */}
      {error && (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
          <Button
            onClick={() => {
              setRestoring(false);
              setError('');
              setSteps([]);
              setIsComplete(false);
              hasCompleted.current = false;
            }}
            variant="outline"
            className="gap-2"
          >
            <RotateCw className="h-4 w-4" />
            Try Again
          </Button>
        </div>
      )}
    </div>
  );
}
