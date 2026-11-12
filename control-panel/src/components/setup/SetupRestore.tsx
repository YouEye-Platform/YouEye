'use client';

import {useLocale} from "next-intl";


import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useState, useEffect, useRef } from 'react';
import { Loader2, CheckCircle2, XCircle, HardDrive, Lock, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { recoverableRestoreSelection, waitForSetupRestoreStatus, type SetupRestoreSelection } from './restore-status';
import { randomBrowserUUID } from '@/lib/browser-random';

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
  const locale = useLocale();

  const translateInterface = useInterfaceTranslations("interface");
  const recoveryText = useInterfaceTranslations("setupRestoreRecovery");
  const translationRef = useRef({ translateInterface, recoveryText });
  translationRef.current = { translateInterface, recoveryText };

  const [recoveryPoints, setRecoveryPoints] = useState<RecoveryPoint[]>([]);
  const [selectedKey, setSelectedKey] = useState('');
  const [selectedApps, setSelectedApps] = useState<string[]>([]);
  const [passphrase, setPassphrase] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [steps, setSteps] = useState<RestoreStep[]>([]);
  const [isComplete, setIsComplete] = useState(false);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState<'resume' | 'finalize' | null>(null);
  const retainedSelection = useRef<SetupRestoreSelection | null>(null);
  const [checking, setChecking] = useState(false);
  const hasCompleted = useRef(false);
  const operationId = useRef<string | null>(null);
  const submitting = useRef(false);

  const checkRestoreStatus = async (id: string, attempts?: number) => {
    setError('');
    setChecking(true);
    try {
      const status = await waitForSetupRestoreStatus(id, { attempts });
      if (status.status === 'completed') {
        sessionStorage.removeItem('youeye-setup-restore-operation');
        setIsComplete(true);
        setPassphrase('');
      } else {
        const selected = recoverableRestoreSelection(status, id);
        retainedSelection.current = selected;
        setRecovery(selected ? status.recovery as 'resume' | 'finalize' : null);
        if (selected) {
          setSelectedKey(JSON.stringify([selected.mediaId, selected.backupId]));
          setSelectedApps(selected.appIds);
          setRestoring(false);
        }
        setError(translationRef.current.recoveryText(selected ? 'canResume' : 'needsReconciliation'));
      }
    } catch (err) {
      setError(translationRef.current.translateInterface("m367bc30f5104"));
      setRecovery(null);
    } finally { setChecking(false); }
  };

  useEffect(() => {
    const pending = sessionStorage.getItem('youeye-setup-restore-operation');
    if (pending && /^[0-9a-f-]{36}$/.test(pending)) {
      operationId.current = pending;
      setRestoring(true);
      void checkRestoreStatus(pending);
    }
    fetch('/api/setup/restore', { cache: 'no-store' })
      .then(response => response.ok ? response.json() : { recoveryPoints: [] })
      .then(body => {
        const points = Array.isArray(body.recoveryPoints) ? body.recoveryPoints as RecoveryPoint[] : [];
        setRecoveryPoints(points);
        if (points[0] && !operationId.current) {
          setSelectedKey(JSON.stringify([points[0].mediaId, points[0].backupId]));
          setSelectedApps(points[0].apps);
        }
      })
      .catch(() => {});
  }, []);

  // Auto-advance on completion
  useEffect(() => {
    if (isComplete && !hasCompleted.current) {
      const timer = setTimeout(() => {
        hasCompleted.current = true;
        onComplete();
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [isComplete, onComplete]);

  const choices = [...recoveryPoints];
  if (retainedSelection.current && !choices.some(point => point.mediaId === retainedSelection.current!.mediaId && point.backupId === retainedSelection.current!.backupId)) {
    choices.push({ ...retainedSelection.current, apps: retainedSelection.current.appIds, createdAt: '' });
  }
  const selectedPoint = choices.find(point => JSON.stringify([point.mediaId, point.backupId]) === selectedKey);
  const canStart = Boolean(selectedPoint && passphrase.trim().length >= 12);

  const handleStartRestore = async () => {
    if (submitting.current || (operationId.current !== null && recovery === null)) return;
    submitting.current = true;
    setRestoring(true);
    setError('');
    setSteps([]);
    setIsComplete(false);
    const resuming = recovery !== null;
    const selection = resuming ? retainedSelection.current : selectedPoint
      ? { mediaId: selectedPoint.mediaId, backupId: selectedPoint.backupId, appIds: selectedApps } : null;
    if (!selection || (resuming && !operationId.current)) {
      setRestoring(false);
      setError(recoveryText('needsReconciliation'));
      submitting.current = false;
      return;
    }
    let submitted = false;

    try {
      const csrfResponse = await fetch('/api/auth/csrf', { cache: 'no-store' });
      const csrfBody = await csrfResponse.json().catch(() => ({}));
      if (!csrfResponse.ok || typeof csrfBody.csrfToken !== 'string') throw new Error(translateInterface("ma40ce2df5560"));
      const id = resuming ? operationId.current! : operationId.current ?? randomBrowserUUID();
      operationId.current = id;
      sessionStorage.setItem('youeye-setup-restore-operation', id);
      submitted = true;
      const res = await fetch('/api/setup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfBody.csrfToken },
        body: JSON.stringify({
          operationId: id,
          action: resuming ? 'resume' : 'start',
          ...selection,
          passphrase: passphrase.trim(),
        }),
      });

      if (!res.ok) {
        // The operation identity remains retained even when admission rejects
        // or a response is lost. Only its status can authorize the next step.
        // A rejected admission may have no receipt. Observe once and retain
        // the identity for explicit reconciliation instead of polling a
        // nonexistent operation for the full restore window.
        await checkRestoreStatus(id, 1);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error(translateInterface("mfc992827aa0d"));

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
              // Durable terminal status below is authoritative.
            }
            if (event.error) {
              setError(event.error);
            }
          } catch {
            // Ignore malformed lines
          }
        }
      }
      await checkRestoreStatus(id);
    } catch (err) {
      if (submitted && operationId.current) await checkRestoreStatus(operationId.current);
      else {
        setError(translateInterface("mb8476ceedfdd"));
        setRecovery(resuming ? recovery : null);
        setRestoring(false);
      }
    } finally {
      submitting.current = false;
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
          <h1 className="text-2xl font-bold mb-2">{translateInterface("mbbeffac3e6f3")}</h1>
          <p className="text-muted-foreground text-sm">
            {recovery ? recoveryText('boundSelection') : translateInterface("mc3b19020e587")}</p>
        </div>

        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-6 duration-500 delay-100">
          <div className="space-y-2">
            <Label htmlFor="recoveryPoint">{translateInterface("mf62ce57b485b")}</Label>
            <select
              id="recoveryPoint"
              value={selectedKey}
              disabled={recovery !== null || checking}
              onChange={(event) => {
                const point = choices.find(item => JSON.stringify([item.mediaId, item.backupId]) === event.target.value);
                setSelectedKey(event.target.value);
                setSelectedApps(point?.apps ?? []);
              }}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {choices.length === 0 && <option value="">{translateInterface("m79c8a214bc8e")}</option>}
              {choices.map(point => <option key={JSON.stringify([point.mediaId, point.backupId])} value={JSON.stringify([point.mediaId, point.backupId])}>{point.createdAt ? new Date(point.createdAt).toLocaleString(locale) : point.backupId}{point.driveName ? ` — ${point.driveName}` : ''}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">{translateInterface("m95e51ec4b042")}</p>
          </div>

          {selectedPoint && selectedPoint.apps.length > 0 && <fieldset className="space-y-2 rounded-lg border p-4">
            <legend className="px-1 text-sm font-medium">{translateInterface("m98e33b0f3104")}</legend>
            {selectedPoint.apps.map(appId => <label key={appId} className="flex items-center gap-3 text-sm">
              <input type="checkbox" checked={selectedApps.includes(appId)} disabled={recovery !== null || checking} onChange={event => setSelectedApps(current => event.target.checked ? [...current, appId] : current.filter(item => item !== appId))} className="size-4 rounded border-input accent-primary" />
              <span>{appId}</span>
            </label>)}
          </fieldset>}

          <div className="space-y-2">
            <Label htmlFor="passphrase">{translateInterface("m8549ab8f37d7")}</Label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="passphrase"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={translateInterface("m2c5da8e37482")}
                className="pl-10"
              />
            </div>
          </div>
        </div>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center justify-between pt-4 animate-in fade-in slide-in-from-bottom-8 duration-500 delay-200">
          <Button variant="ghost" onClick={onBack} disabled={operationId.current !== null}>
            {translateInterface("m76900f1bfd16")}</Button>
          <Button onClick={handleStartRestore} disabled={!canStart || checking}>
            {recovery ? recoveryText(recovery === 'finalize' ? 'finish' : 'resume') : translateInterface("me91ee8913c7c")}</Button>
        </div>
      </div>
    );
  }

  // Progress display (during/after restore)
  return (
    <div className="w-full max-w-md mx-auto text-center space-y-8">
      <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
        <h1 className="text-2xl font-bold mb-2">{translateInterface("m1e5b2cdade84")}</h1>
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

        <div className="min-h-8 flex items-center justify-center" role="status" aria-live="polite">
          {isComplete ? (
			<p className="text-green-600 font-medium animate-in fade-in duration-300">{translateInterface("m615e618f33d1")}</p>
          ) : error ? (
            <p className="text-red-600 text-sm">{error}</p>
          ) : (
            <p className="text-muted-foreground text-sm">{steps.at(-1)?.message || translateInterface("m01bee24a83ff")}</p>
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
            {completedSteps} / {steps.length} {" "}{translateInterface("ma14cafb98459")}</p>
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
              if (operationId.current && !checking) void checkRestoreStatus(operationId.current);
            }}
            variant="outline"
            disabled={checking}
            className="gap-2"
          >
            <RotateCw className="h-4 w-4" />
            {translateInterface("m113bb90da3d4")}
          </Button>
        </div>
      )}
    </div>
  );
}
