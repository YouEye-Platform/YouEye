'use client';

import {
  Search,
  MessageCircle,
  BookOpen,
  StickyNote,
  Camera,
  Film,
  CloudSun,
  Languages,
  CheckCircle2,
  Circle,
  MinusCircle,
  AlertCircle,
  Loader2,
  ExternalLink,
  Package,
  BellRing,
  Shield,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import type { MarketApp, AppStatusInfo, InstallEvent } from '@/lib/market/types';

const ICON_MAP: Record<string, typeof Search> = {
  search: Search,
  'message-circle': MessageCircle,
  'book-open': BookOpen,
  'sticky-note': StickyNote,
  camera: Camera,
  film: Film,
  'cloud-sun': CloudSun,
  languages: Languages,
  package: Package,
  'bell-ring': BellRing,
};

const STATUS_CONFIG: Record<
  string,
  { label: string; className: string; Icon: typeof CheckCircle2 }
> = {
  running: {
    label: 'Running',
    className: 'bg-green-100 text-green-700 border-green-200',
    Icon: CheckCircle2,
  },
  stopped: {
    label: 'Stopped',
    className: 'bg-gray-100 text-gray-600 border-gray-200',
    Icon: Circle,
  },
  partial: {
    label: 'Partial',
    className: 'bg-amber-100 text-amber-700 border-amber-200',
    Icon: MinusCircle,
  },
  installing: {
    label: 'Installing',
    className: 'bg-blue-100 text-blue-600 border-blue-200',
    Icon: Loader2,
  },
  error: {
    label: 'Error',
    className: 'bg-red-100 text-red-600 border-red-200',
    Icon: AlertCircle,
  },
  'not-installed': {
    label: 'Not Installed',
    className: 'bg-gray-50 text-gray-400 border-gray-100',
    Icon: Circle,
  },
};

interface AppCardProps {
  app: MarketApp;
  status?: AppStatusInfo;
  installProgress?: { events: InstallEvent[]; done: boolean };
}

export function AppCard({ app, status, installProgress }: AppCardProps) {
  const t = useTranslations('market');
  const FallbackIcon = ICON_MAP[app.icon] ?? Package;
  const appStatus = status?.status ?? 'not-installed';
  const statusCfg = STATUS_CONFIG[appStatus] ?? STATUS_CONFIG['not-installed'];
  const StatusIcon = statusCfg.Icon;

  return (
    <Link href={`/market/${app.id}`} className="block">
      <div
        className="rounded-xl border border-gray-200 bg-white p-5 flex flex-col gap-3 hover:shadow-md transition-all cursor-pointer"
        data-app-id={app.id}
      >
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-blue-50 flex items-center justify-center">
              {app.iconUrl ? (
                <Image
                  src={app.iconUrl}
                  alt={app.name}
                  width={24}
                  height={24}
                  className="h-6 w-6 object-contain"
                  unoptimized
                />
              ) : (
                <FallbackIcon className="h-6 w-6 text-blue-600" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h3 className="font-semibold text-gray-900">{app.name}</h3>
                {app.type === 'native' && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600 border border-indigo-100">
                    <Shield className="h-2.5 w-2.5" />
                    YouEye
                  </span>
                )}
              </div>
              <span className="text-xs text-gray-400 capitalize">{app.category}</span>
            </div>
          </div>
          <Badge variant="outline" className={statusCfg.className}>
            {appStatus === 'installing' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <StatusIcon className="h-3 w-3" />
            )}
            {statusCfg.label}
          </Badge>
        </div>

        {/* Description (truncated to 2 lines) */}
        <p className="text-sm text-gray-600 leading-relaxed line-clamp-2">{app.description}</p>

        {/* Tags */}
        <div className="flex flex-wrap gap-1.5">
          {app.tags.map((tag) => (
            <span
              key={tag}
              className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500"
            >
              {tag}
            </span>
          ))}
        </div>

        {/* URL if installed */}
        {status?.url && (
          <span
            className="text-sm text-blue-600 flex items-center gap-1"
          >
            {status.url}
            <ExternalLink className="h-3 w-3" />
          </span>
        )}

        {/* Install progress bar (when installing) */}
        {installProgress && !installProgress.done && installProgress.events.length > 0 && (
          <div className="mt-auto pt-2 border-t border-gray-100">
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-500"
                style={{
                  width: `${Math.round(
                    (installProgress.events[installProgress.events.length - 1].step /
                      installProgress.events[installProgress.events.length - 1].totalSteps) *
                      100
                  )}%`,
                }}
              />
            </div>
            <p className="text-xs text-gray-400 mt-1 truncate">
              {installProgress.events[installProgress.events.length - 1]?.message}
            </p>
          </div>
        )}
      </div>
    </Link>
  );
}
