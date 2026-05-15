'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  Globe,
  Play,
  Square,
  RotateCcw,
  Trash2,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AppInstance } from '@/types/apps';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

interface ProxyStatusCardProps {
  status: AppInstance | null;
  onAction: (action: 'start' | 'stop' | 'restart' | 'remove') => Promise<void>;
}

export function ProxyStatusCard({ status, onAction }: ProxyStatusCardProps) {
  const t = useTranslations('proxyStatus');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleAction = async (action: 'start' | 'stop' | 'restart' | 'remove') => {
    setActionLoading(action);
    try {
      await onAction(action);
    } finally {
      setActionLoading(null);
    }
  };

  const isRunning = status?.status === 'running';
  const isStopped = status?.status === 'stopped';

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={cn(
              "p-2 rounded-lg",
              isRunning ? "bg-green-100" : "bg-gray-100"
            )}>
              <Globe className={cn(
                "h-5 w-5",
                isRunning ? "text-green-600" : "text-gray-600"
              )} />
            </div>
            <div>
              <CardTitle className="text-lg">Caddy</CardTitle>
              <CardDescription>{status?.manifest.description}</CardDescription>
            </div>
          </div>
          <Badge variant={isRunning ? "default" : "secondary"} className={cn(
            isRunning && "bg-green-100 text-green-700 hover:bg-green-100"
          )}>
            {status?.status || 'Unknown'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="text-sm text-gray-500">
            {status?.containerStatus?.ipv4 && (
              <span>IP: {status.containerStatus.ipv4}</span>
            )}
          </div>
          <div className="flex gap-2">
            {isStopped && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleAction('start')}
                disabled={!!actionLoading}
              >
                {actionLoading === 'start' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Play className="h-4 w-4 mr-1" />
                    {t('start')}
                  </>
                )}
              </Button>
            )}
            {isRunning && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleAction('restart')}
                  disabled={!!actionLoading}
                >
                  {actionLoading === 'restart' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <RotateCcw className="h-4 w-4 mr-1" />
                      {t('restart')}
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleAction('stop')}
                  disabled={!!actionLoading}
                >
                  {actionLoading === 'stop' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <Square className="h-4 w-4 mr-1" />
                      {t('stop')}
                    </>
                  )}
                </Button>
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleAction('remove')}
              disabled={!!actionLoading}
              className="text-red-600 hover:text-red-700 hover:bg-red-50"
            >
              {actionLoading === 'remove' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Trash2 className="h-4 w-4 mr-1" />
                  {t('remove')}
                </>
              )}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
