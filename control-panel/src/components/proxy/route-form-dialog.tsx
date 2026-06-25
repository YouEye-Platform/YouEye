'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  X,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ProxyRoute } from '@/lib/caddy/types';

interface RouteFormDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: { hostname?: string; path: string; upstream: string; port: number }) => Promise<void>;
  initialData?: ProxyRoute;
  isEditing?: boolean;
}

export function RouteFormDialog({ 
  open, 
  onClose, 
  onSubmit, 
  initialData,
  isEditing = false,
}: RouteFormDialogProps) {
  const [hostname, setHostname] = useState('');
  const [path, setPath] = useState('/*');
  const [upstream, setUpstream] = useState('');
  const [port, setPort] = useState('3000');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useTranslations('routeForm');
  const tc = useTranslations('common');

  useEffect(() => {
    if (open && initialData) {
      setHostname(initialData.hostname || '');
      setPath(initialData.path || '/*');
      setUpstream(initialData.upstream || '');
      setPort(String(initialData.port || 3000));
    } else if (open) {
      // Reset form for new route
      setHostname('');
      setPath('/*');
      setUpstream('');
      setPort('3000');
    }
    setError(null);
  }, [open, initialData]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!upstream.trim()) {
      setError(t('upstreamRequired'));
      return;
    }

    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setError(t('portRange'));
      return;
    }

    setLoading(true);
    try {
      await onSubmit({
        hostname: hostname.trim() || undefined,
        path: path.trim() || '/*',
        upstream: upstream.trim(),
        port: portNum,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save route');
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">
            {isEditing ? t('editRoute') : t('addRoute')}
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 p-0">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700 text-sm">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              {error}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="hostname">{t('hostname')}</Label>
            <Input
              id="hostname"
              placeholder="example.com"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
            />
            <p className="text-xs text-gray-500">
              {t('hostnameHint')}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="path">{t('path')}</Label>
            <Input
              id="path"
              placeholder="/*"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
            <p className="text-xs text-gray-500">
              {t('pathHint')}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="upstream">{t('upstream')}</Label>
            <Input
              id="upstream"
              placeholder="youeye-control"
              value={upstream}
              onChange={(e) => setUpstream(e.target.value)}
              required
            />
            <p className="text-xs text-gray-500">
              {t('upstreamHint')}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="port">{t('port')}</Label>
            <Input
              id="port"
              type="number"
              min="1"
              max="65535"
              placeholder="3000"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              required
            />
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              {tc('cancel')}
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('saving')}
                </>
              ) : (
                isEditing ? t('updateRoute') : t('addRoute')
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
