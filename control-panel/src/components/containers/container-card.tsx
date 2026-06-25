'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Play, Square, RotateCw, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ContainerInfo, SessionPayload, NetworkAddress } from '@/types';
import { formatRelativeTime } from '@/lib/utils/format';

interface ContainerCardProps {
  container: ContainerInfo;
  session: SessionPayload;
  onAction: (name: string, action: 'start' | 'stop' | 'restart') => Promise<void>;
  actionLoading: string | null;
}

export function ContainerCard({ container, session, onAction, actionLoading }: ContainerCardProps) {
  const t = useTranslations('containers');
  const isRunning = container.status === 'Running';
  const isThisLoading = actionLoading === container.name;
  
  // Find the primary IPv4 address
  const ipv4 = container.state?.network?.eth0?.addresses?.find(
    (addr: NetworkAddress) => addr.family === 'inet'
  )?.address || 'N/A';

  return (
    <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors">
      <div className="flex items-center gap-4">
        <div className="flex flex-col">
          <span className="font-medium text-gray-900">{container.name}</span>
          <span className="text-sm text-gray-500">
            {ipv4 !== 'N/A' ? ipv4 : t('noIp')}
          </span>
        </div>
      </div>
      
      <div className="flex items-center gap-3">
        <Badge 
          variant={isRunning ? 'default' : 'secondary'}
          className={isRunning 
            ? 'bg-green-100 text-green-700 hover:bg-green-100' 
            : 'bg-gray-100 text-gray-600 hover:bg-gray-100'
          }
        >
          {container.status}
        </Badge>
        
        <div className="flex items-center gap-1">
          {!isRunning ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onAction(container.name, 'start')}
              disabled={isThisLoading}
              className="h-8 w-8 p-0 text-green-600 hover:text-green-700 hover:bg-green-50"
              title={t('startContainer')}
            >
              {isThisLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onAction(container.name, 'stop')}
                disabled={isThisLoading}
                className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                title={t('stopContainer')}
              >
                {isThisLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Square className="h-4 w-4" />
                )}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onAction(container.name, 'restart')}
                disabled={isThisLoading}
                className="h-8 w-8 p-0 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                title={t('restartContainer')}
              >
                <RotateCw className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
