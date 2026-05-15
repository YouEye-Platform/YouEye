'use client';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Pencil,
  Trash2,
  ArrowRight,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ProxyRoute } from '@/lib/caddy/types';

interface RouteListProps {
  routes: ProxyRoute[];
  onEdit: (route: ProxyRoute) => void;
  onDelete: (id: string) => void;
}

export function RouteList({ routes, onEdit, onDelete }: RouteListProps) {
  const t = useTranslations('routeList');
  return (
    <div className="space-y-2">
      {routes.map((route) => (
        <div
          key={route.id}
          className="flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <div className="flex items-center gap-4 flex-1 min-w-0">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm truncate">
                  {route.hostname || '*'}
                </span>
                <span className="text-gray-400 font-mono text-sm">
                  {route.path}
                </span>
              </div>
            </div>
            
            <ArrowRight className="h-4 w-4 text-gray-400 flex-shrink-0" />
            
            <div className="flex-1 min-w-0">
              <span className="font-mono text-sm truncate">
                {route.upstream}:{route.port}
              </span>
            </div>
            
            <Badge variant={route.enabled ? "default" : "secondary"} className="flex-shrink-0">
              {route.enabled ? t('active') : t('disabled')}
            </Badge>
          </div>
          
          <div className="flex gap-1 ml-4 flex-shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onEdit(route)}
              className="h-8 w-8 p-0"
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onDelete(route.id)}
              className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
