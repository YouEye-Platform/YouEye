'use client';

import { useEffect, useRef } from 'react';
import { Loader2, CheckCircle2, XCircle, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';

type StepStatus = 'pending' | 'running' | 'done' | 'error';

interface SetupStep {
  id: string;
  label: string;
  status: StepStatus;
  message?: string;
}

interface Props {
  steps: SetupStep[];
  isComplete: boolean;
  isRestarting?: boolean;
  isChecking?: boolean;
  statusOnlyRetry?: boolean;
  error: string;
  onRetry: () => void;
  onComplete: () => void;
}

export default function SetupProvisioning({
  steps,
  isComplete,
  isRestarting = false,
  isChecking = false,
  statusOnlyRetry = false,
  error,
  onRetry,
  onComplete,
}: Props) {
  const t = useTranslations('setup');
  const hasCompleted = useRef(false);

  // Only the actual completion receipt initiates the connection readback.
  useEffect(() => {
    if (isComplete && !error && !hasCompleted.current) {
      hasCompleted.current = true;
      onComplete();
    }
  }, [isComplete, error, onComplete]);

  // Calculate progress
  const completedSteps = steps.filter(s => s.status === 'done').length;
  const totalSteps = steps.length;
  const progress = totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0;

  return (
    <div className="w-full max-w-md mx-auto text-center space-y-8">
      {/* Header */}
      <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
        <h1 className="text-2xl font-bold mb-2">{t('settingUpHome')}</h1>
      </div>

      {/* Spinner / Status */}
      <div className="flex flex-col items-center gap-6">
        <div role={error ? 'alert' : 'status'} className="flex items-center gap-2">
          {error ? <XCircle aria-hidden="true" className="h-5 w-5 shrink-0 text-destructive" />
            : isComplete && !isRestarting ? <CheckCircle2 aria-hidden="true" className="h-5 w-5 shrink-0 text-primary" />
              : <Loader2 aria-hidden="true" className="h-5 w-5 shrink-0 animate-spin motion-reduce:animate-none" />}
          {isComplete && !error ? (
            <p className="text-foreground font-medium">
              {isRestarting ? t('restartingServerInterface') : t('allDone')}
            </p>
          ) : error ? (
            <p className="text-destructive text-sm">{error}</p>
          ) : (
            <p className="text-muted-foreground text-sm">{isChecking ? t('checkingSetupStatus') : steps.find(step => step.status === 'running')?.label || t('settingUpHome')}</p>
          )}
        </div>

        {/* Progress bar */}
        <div className="w-full max-w-xs">
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out motion-reduce:transition-none ${
                error ? 'bg-destructive' : 'bg-primary'
              }`}
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            {completedSteps} / {totalSteps} {t('stepsComplete')}
          </p>
        </div>
        <ol className="w-full space-y-2 text-left text-sm">
          {steps.map(step => <li key={step.id} className="rounded-lg border bg-card px-3 py-2">
            <div className="flex items-center gap-2">
              {step.status === 'done' ? <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-primary" />
                : step.status === 'error' ? <XCircle aria-hidden="true" className="h-4 w-4 text-destructive" />
                  : step.status === 'running' ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <span aria-hidden="true" className="h-4 w-4 rounded-full border" />}
              <span>{step.label}</span><span className="sr-only">: {step.status}</span>
            </div>
            {step.message && <p className="mt-1 break-words text-xs text-muted-foreground">{step.message}</p>}
          </li>)}
        </ol>
      </div>

      {/* Error retry */}
      {error && (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
          <Button onClick={onRetry} variant="outline" className="gap-2">
            <RotateCw className="h-4 w-4" />
            {statusOnlyRetry ? t('checkSetupStatus') : t('tryAgain')}
          </Button>
        </div>
      )}
    </div>
  );
}
