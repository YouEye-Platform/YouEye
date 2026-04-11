'use client';

import {
  CheckCircle2,
  XCircle,
  Loader2,
  SkipForward,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { InstallEvent } from '@/lib/market/types';

interface InstallProgressProps {
  appName: string;
  events: InstallEvent[];
  done: boolean;
  onClose: () => void;
}

const STATUS_ICON: Record<string, typeof CheckCircle2> = {
  running: Loader2,
  success: CheckCircle2,
  error: XCircle,
  skipped: SkipForward,
};

const STATUS_COLOR: Record<string, string> = {
  running: 'text-blue-500',
  success: 'text-green-500',
  error: 'text-red-500',
  skipped: 'text-gray-400',
};

export function InstallProgress({ appName, events, done, onClose }: InstallProgressProps) {
  const t = useTranslations('market');
  const tc = useTranslations('common');
  const lastEvent = events[events.length - 1];
  const isError = lastEvent?.status === 'error' && done;
  const isSuccess = done && !isError;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">
            {done
              ? isError
                ? t('installFailed', { name: appName })
                : t('installSuccess', { name: appName })
              : t('installing')}
          </h2>
          {done && (
            <button
              onClick={onClose}
              className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        {/* Progress bar */}
        {lastEvent && lastEvent.totalSteps > 0 && (
          <div className="px-6 pt-4">
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 rounded-full ${
                  isError ? 'bg-red-500' : isSuccess ? 'bg-green-500' : 'bg-blue-500'
                }`}
                style={{
                  width: `${Math.round((lastEvent.step / lastEvent.totalSteps) * 100)}%`,
                }}
              />
            </div>
            <p className="text-xs text-gray-400 mt-1 text-right">
              {lastEvent.step} / {lastEvent.totalSteps}
            </p>
          </div>
        )}

        {/* Event list */}
        <div className="px-6 py-4 space-y-2 max-h-80 overflow-y-auto">
          {events.map((event, i) => {
            const Icon = STATUS_ICON[event.status] ?? Loader2;
            const color = STATUS_COLOR[event.status] ?? 'text-gray-400';

            return (
              <div key={i} className="flex items-start gap-3">
                <div className={`mt-0.5 shrink-0 ${color}`}>
                  {event.status === 'running' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Icon className="h-4 w-4" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm text-gray-700">{event.message}</p>
                  {event.detail && (
                    <p className="text-xs text-gray-400 mt-0.5 truncate">{event.detail}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        {done && (
          <div className="px-6 pb-4">
            <Button onClick={onClose} className="w-full" variant={isError ? 'outline' : 'default'}>
              {isError ? tc('close') : tc('confirm')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
