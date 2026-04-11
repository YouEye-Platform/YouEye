'use client';

import { useTranslations } from 'next-intl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Server, Cpu, HardDrive } from 'lucide-react';
import type { ServerInfo } from '@/types';

interface SystemInfoProps {
  serverInfo: ServerInfo | null;
}

export function SystemInfo({ serverInfo }: SystemInfoProps) {
  const t = useTranslations('dashboard.systemInfo');

  if (!serverInfo) {
    return (
      <Card className="bg-white border-gray-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-gray-900">{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-gray-500 text-sm">{t('loading')}</p>
        </CardContent>
      </Card>
    );
  }

  const items = [
    { icon: Server, label: t('serverName'), value: serverInfo.server_name },
    { icon: Server, label: t('incusVersion'), value: serverInfo.server_version },
    { icon: HardDrive, label: t('operatingSystem'), value: `${serverInfo.os_name} ${serverInfo.os_version}` },
    { icon: Cpu, label: t('kernel'), value: serverInfo.kernel_version },
  ];

  return (
    <Card className="bg-white border-gray-200 shadow-sm">
      <CardHeader>
        <CardTitle className="text-gray-900">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-4">
          {items.map((item, index) => (
            <div key={index} className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-gray-100">
                <item.icon className="h-4 w-4 text-gray-600" />
              </div>
              <div>
                <dt className="text-xs text-gray-500">{item.label}</dt>
                <dd className="text-sm font-medium text-gray-900">{item.value}</dd>
              </div>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
