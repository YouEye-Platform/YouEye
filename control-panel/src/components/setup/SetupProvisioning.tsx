'use client';

import { useState, useEffect, useRef } from 'react';
import { Loader2, CheckCircle2, XCircle, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FUNNY_LOADING_MESSAGES } from '@/lib/wordart-presets';
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
  error: string;
  onRetry: () => void;
  onComplete: () => void;
}

export default function SetupProvisioning({ steps, isComplete, error, onRetry, onComplete }: Props) {
  const t = useTranslations('setup');
  const [funnyMessage, setFunnyMessage] = useState(FUNNY_LOADING_MESSAGES[0]);
  const [messageIndex, setMessageIndex] = useState(0);
  const hasCompleted = useRef(false);

  // Cycle funny messages every 2.5 seconds
  useEffect(() => {
    if (isComplete || error) return;
    const interval = setInterval(() => {
      setMessageIndex(prev => {
        const next = (prev + 1) % FUNNY_LOADING_MESSAGES.length;
        setFunnyMessage(FUNNY_LOADING_MESSAGES[next]);
        return next;
      });
    }, 2500);
    return () => clearInterval(interval);
  }, [isComplete, error]);

  // Auto-advance on completion
  useEffect(() => {
    if (isComplete && !hasCompleted.current) {
      hasCompleted.current = true;
      const timer = setTimeout(onComplete, 1500);
      return () => clearTimeout(timer);
    }
  }, [isComplete, onComplete]);

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

        {/* Funny message or status */}
        <div className="h-8 flex items-center justify-center">
          {isComplete ? (
            <p className="text-green-600 font-medium animate-in fade-in duration-300">{t('allDone')}</p>
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
            {completedSteps} / {totalSteps} {t('stepsComplete')}
          </p>
        </div>
      </div>

      {/* Error retry */}
      {error && (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
          <Button onClick={onRetry} variant="outline" className="gap-2">
            <RotateCw className="h-4 w-4" />
            {t('tryAgain')}
          </Button>
        </div>
      )}
    </div>
  );
}
