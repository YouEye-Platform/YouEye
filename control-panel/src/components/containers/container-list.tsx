'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ContainerCard } from './container-card';
import { Box, RefreshCw, Loader2 } from 'lucide-react';
import type { ContainerInfo, SessionPayload } from '@/types';

interface ContainerListProps {
  containers: ContainerInfo[];
  session: SessionPayload;
  loading: boolean;
  onRefresh: () => void;
  onAction: (name: string, action: 'start' | 'stop' | 'restart') => Promise<void>;
  actionLoading: string | null;
}

export function ContainerList({ 
  containers, 
  session, 
  loading, 
  onRefresh, 
  onAction,
  actionLoading 
}: ContainerListProps) {
  const t = useTranslations('dashboard.containers');
  const tc = useTranslations('common');
  return (
    <Card className="bg-white border-gray-200 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-gray-900">{t('title')}</CardTitle>
          <CardDescription className="text-gray-500">
            {t('manage')}
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
          className="border-gray-300 text-gray-700 hover:bg-gray-100"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          {tc('refresh')}
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
          </div>
        ) : containers.length === 0 ? (
          <div className="text-center py-12">
            <Box className="h-12 w-12 mx-auto mb-4 text-gray-300" />
            <p className="text-gray-500 font-medium">{t('noContainers')}</p>
            <p className="text-sm text-gray-400 mt-1">
              {t('createHint')}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {containers.map((container) => (
              <ContainerCard
                key={container.name}
                container={container}
                session={session}
                onAction={onAction}
                actionLoading={actionLoading}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
