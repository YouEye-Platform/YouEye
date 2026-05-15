'use client';

import { useState, useEffect, useRef } from 'react';
import { Loader2, CheckCircle2, XCircle, FolderOpen, Lock, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FUNNY_LOADING_MESSAGES } from '@/lib/wordart-presets';

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

export default function SetupRestore({ onComplete, onBack }: Props) {
  const [backupPath, setBackupPath] = useState('/mnt/backup');
  const [passphrase, setPassphrase] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [steps, setSteps] = useState<RestoreStep[]>([]);
  const [isComplete, setIsComplete] = useState(false);
  const [error, setError] = useState('');
  const [funnyMessage, setFunnyMessage] = useState(FUNNY_LOADING_MESSAGES[0]);
  const [messageIndex, setMessageIndex] = useState(0);
  const hasCompleted = useRef(false);

  // Cycle funny messages during restore
  useEffect(() => {
    if (!restoring || isComplete || error) return;
    const interval = setInterval(() => {
      setMessageIndex(prev => {
        const next = (prev + 1) % FUNNY_LOADING_MESSAGES.length;
        setFunnyMessage(FUNNY_LOADING_MESSAGES[next]);
        return next;
      });
    }, 2500);
    return () => clearInterval(interval);
  }, [restoring, isComplete, error]);

  // Auto-advance on completion
  useEffect(() => {
    if (isComplete && !hasCompleted.current) {
      hasCompleted.current = true;
      const timer = setTimeout(onComplete, 2000);
      return () => clearTimeout(timer);
    }
  }, [isComplete, onComplete]);

  const canStart = backupPath.trim().length > 0 && passphrase.trim().length > 0;

  const handleStartRestore = async () => {
    setRestoring(true);
    setError('');
    setSteps([]);
    setIsComplete(false);

    try {
      const res = await fetch('/api/setup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          backupPath: backupPath.trim(),
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
            <FolderOpen className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold mb-2">Restore from Backup</h1>
          <p className="text-muted-foreground text-sm">
            Provide the path to your backup archive and the encryption passphrase used when the backup was created.
          </p>
        </div>

        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-6 duration-500 delay-100">
          <div className="space-y-2">
            <Label htmlFor="backupPath">Backup path</Label>
            <Input
              id="backupPath"
              value={backupPath}
              onChange={(e) => setBackupPath(e.target.value)}
              placeholder="/mnt/backup"
            />
            <p className="text-xs text-muted-foreground">
              Full path to the backup directory or archive file on this server.
            </p>
          </div>

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
            <p className="text-green-600 font-medium animate-in fade-in duration-300">Restore complete! Redirecting...</p>
          ) : error ? (
            <p className="text-red-600 text-sm">{error}</p>
          ) : (
            <p
              key={messageIndex}
              className="text-muted-foreground text-sm animate-in fade-in slide-in-from-bottom-2 duration-300"
            >
              {funnyMessage}
            </p>
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
