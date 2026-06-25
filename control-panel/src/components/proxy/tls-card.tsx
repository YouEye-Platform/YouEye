'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { 
  Shield,
  RefreshCw,
  Loader2,
  AlertCircle,
  Check,
  Plus,
  X,
} from 'lucide-react';
import { authenticatedFetch } from '@/lib/api-client';
import { useTranslations } from 'next-intl';

interface TLSCardProps {
  config: { mode: string; subjects: string[] } | null;
  onUpdate: () => void;
}

export function TLSCard({ config, onUpdate }: TLSCardProps) {
  const t = useTranslations('tlsCard');
  const tc = useTranslations('common');
  const [editing, setEditing] = useState(false);
  const [hosts, setHosts] = useState<string[]>([]);
  const [newHost, setNewHost] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleEdit = () => {
    setHosts(config?.subjects || []);
    setEditing(true);
    setError(null);
  };

  const handleCancel = () => {
    setEditing(false);
    setNewHost('');
    setError(null);
  };

  const handleAddHost = () => {
    const host = newHost.trim();
    if (host && !hosts.includes(host)) {
      setHosts([...hosts, host]);
      setNewHost('');
    }
  };

  const handleRemoveHost = (host: string) => {
    setHosts(hosts.filter(h => h !== host));
  };

  const handleSave = async () => {
    if (hosts.length === 0) {
      setError(t('atLeastOneHost'));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await authenticatedFetch('/api/caddy/tls', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update TLS');
      }

      setEditing(false);
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update TLS');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-100">
              <Shield className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <CardTitle className="text-lg">{t('title')}</CardTitle>
              <CardDescription>
                {t('description')}
              </CardDescription>
            </div>
          </div>
          {config?.mode && (
            <Badge variant="secondary">
              {config.mode === 'internal' ? t('selfSigned') : config.mode}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700 text-sm">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {!editing ? (
          <div className="space-y-4">
            <div>
              <Label className="text-sm text-gray-500">{t('validForHosts')}</Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {config?.subjects && config.subjects.length > 0 ? (
                  config.subjects.map((host) => (
                    <Badge key={host} variant="outline" className="font-mono">
                      {host}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-gray-500">{t('noHostsConfigured')}</span>
                )}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={handleEdit}>
              <RefreshCw className="h-4 w-4 mr-2" />
              {t('configureCert')}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <Label className="text-sm">{t('hostsLabel')}</Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {hosts.map((host) => (
                  <Badge key={host} variant="secondary" className="font-mono pr-1">
                    {host}
                    <button
                      onClick={() => handleRemoveHost(host)}
                      className="ml-1 hover:bg-gray-300 rounded p-0.5"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            </div>

            <div className="flex gap-2">
              <Input
                placeholder={t('addHostPlaceholder')}
                value={newHost}
                onChange={(e) => setNewHost(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddHost();
                  }
                }}
              />
              <Button type="button" variant="outline" onClick={handleAddHost}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            <p className="text-xs text-gray-500">
              {t('hostHint')}
            </p>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={handleCancel}>
                {tc('cancel')}
              </Button>
              <Button onClick={handleSave} disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {tc('loading')}
                  </>
                ) : (
                  <>
                    <Check className="h-4 w-4 mr-2" />
                    {tc('save')}
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
