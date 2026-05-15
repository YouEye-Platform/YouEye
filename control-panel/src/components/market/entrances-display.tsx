'use client';

import { Globe, Server, Lock, Unlock, EyeOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface Entrance {
  name: string;
  path: string;
  port: number;
  container?: string;
  protocol?: 'http' | 'tcp';
  authLevel?: 'private' | 'public' | 'internal' | 'none';
  stripPath?: boolean;
}

interface EntrancesDisplayProps {
  entrances: Entrance[];
  subdomain?: string;
  domain?: string;
}

const AUTH_BADGE: Record<string, { label: string; className: string; Icon: typeof Lock }> = {
  private: { label: 'SSO Required', className: 'bg-green-50 text-green-700 border-green-200', Icon: Lock },
  public: { label: 'Public', className: 'bg-amber-50 text-amber-700 border-amber-200', Icon: Unlock },
  internal: { label: 'Internal Only', className: 'bg-gray-50 text-gray-500 border-gray-200', Icon: EyeOff },
  none: { label: 'No Auth', className: 'bg-gray-50 text-gray-400 border-gray-100', Icon: Unlock },
};

export function EntrancesDisplay({ entrances, subdomain, domain }: EntrancesDisplayProps) {
  if (!entrances.length) return null;

  const baseUrl = subdomain && domain ? `https://${subdomain}.${domain}` : null;

  return (
    <div className="mt-5 pt-4 border-t border-gray-100">
      <div className="flex items-center gap-2 mb-3">
        <Server className="h-4 w-4 text-gray-400" />
        <p className="text-xs text-gray-400 uppercase tracking-wide font-medium">
          Access Points
        </p>
      </div>
      <div className="space-y-2.5">
        {entrances.map((entrance) => {
          const auth = AUTH_BADGE[entrance.authLevel ?? 'private'] ?? AUTH_BADGE.private;
          const AuthIcon = auth.Icon;
          const fullUrl = baseUrl
            ? `${baseUrl}${entrance.path === '/' ? '' : entrance.path}`
            : null;

          return (
            <div
              key={entrance.name}
              className="flex items-center gap-3 p-2.5 rounded-lg bg-gray-50 border border-gray-100"
            >
              <Globe className="h-4 w-4 text-gray-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-700 capitalize">
                    {entrance.name}
                  </span>
                  <span className="text-xs text-gray-400 font-mono">
                    {entrance.path}
                  </span>
                </div>
                {fullUrl && (
                  <p className="text-xs text-gray-400 truncate font-mono">{fullUrl}</p>
                )}
              </div>
              <Badge variant="outline" className={`shrink-0 text-[10px] ${auth.className}`}>
                <AuthIcon className="h-2.5 w-2.5" />
                {auth.label}
              </Badge>
            </div>
          );
        })}
      </div>
    </div>
  );
}
