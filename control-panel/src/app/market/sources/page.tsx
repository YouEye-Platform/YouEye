'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Check, ChevronLeft, Loader2, Plus, Store, Trash2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { InstallFromUrlDialog } from '@/components/market/install-from-url-dialog';
import { authenticatedFetch } from '@/lib/api-client';

interface MarketSourceConfig {
  id: string;
  name: string;
  repo_url: string;
  branch: string;
  resolved_commit?: string;
  resolved_at?: string;
  refresh_error?: string;
  enabled: boolean;
  priority: number;
  trust: 'official' | 'community' | 'custom';
}

export default function MarketSourcesPage() {
  const [sources, setSources] = useState<MarketSourceConfig[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [domain, setDomain] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [showInstall, setShowInstall] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const [srcRes, catRes, domRes] = await Promise.all([
        fetch('/api/market/source'),
        fetch('/api/market/catalog'),
        fetch('/api/domain'),
      ]);
      if (srcRes.ok) {
        const d = await srcRes.json();
        setSources(d.sources?.length ? d.sources : d.source ? [d.source] : []);
      } else {
        console.error('[Market sources] source load failed', srcRes.status);
        setError('Couldn’t load sources.');
      }
      if (catRes.ok) {
        const d = await catRes.json();
        const c: Record<string, number> = {};
        for (const a of d.apps || []) {
          const k = a.sourceId || a.sourceName || 'market';
          c[k] = (c[k] || 0) + 1;
        }
        setCounts(c);
      }
      if (domRes.ok) {
        const d = await domRes.json();
        setDomain(d.domain || '');
      }
    } catch (e) {
      console.error('[Market sources] load failed', e);
      setError('Couldn’t load sources.');
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const persist = useCallback(
    async (next: MarketSourceConfig[]) => {
      setSaving(true);
      setError('');
      try {
        const normalized = next
          .map((s, i) => ({
            ...s,
            id: s.id?.trim() || `source-${i + 1}`,
            name: s.name?.trim() || `Market ${i + 1}`,
            repo_url: s.repo_url?.trim(),
            priority: Number.isFinite(Number(s.priority)) ? Number(s.priority) : i,
          }))
          .filter((s) => s.repo_url);
        const res = await authenticatedFetch('/api/market/source', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active_sources: normalized }),
        });
        if (!res.ok) throw new Error('save failed');
        const d = await res.json();
        setSources(d.sources?.length ? d.sources : normalized);
      } catch (e) {
        console.error('[Market sources] save failed', e);
        setError('Couldn’t save changes.');
        load(); // revert to the server's truth
      } finally {
        setSaving(false);
      }
    },
    [load],
  );

  const toggle = (index: number, enabled: boolean) => {
    const next = sources.map((s, i) => (i === index ? { ...s, enabled } : s));
    setSources(next);
    persist(next);
  };

  const remove = (index: number) => {
    const next = sources.filter((_, i) => i !== index);
    setSources(next);
    persist(next);
  };

  const addSource = () => {
    if (!newUrl.trim()) return;
    const next: MarketSourceConfig[] = [
      ...sources,
      {
        id: `custom-${sources.length + 1}`,
        name: newName.trim() || 'Custom Market',
        repo_url: newUrl.trim(),
        branch: 'main',
        enabled: true,
        priority: sources.length,
        trust: 'custom',
      },
    ];
    setSources(next);
    persist(next);
    setNewName('');
    setNewUrl('');
    setAdding(false);
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-7 w-7 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1040px] space-y-6 px-1 pb-16">
      <Link href="/market" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ChevronLeft className="h-4 w-4" /> Market
      </Link>
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          Sources <Badge variant="secondary" className="text-[11px]">Admin</Badge>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">Where the Market finds apps</p>
      </div>

      {error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive">{error}</div>}

      {/* Connected sources */}
      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center justify-between px-[18px] py-3">
          <h2 className="text-[15px] font-semibold">Connected sources</h2>
          <Button size="sm" className="h-8" onClick={() => setAdding((v) => !v)}>
            <Plus className="h-3.5 w-3.5" /> Add source
          </Button>
        </div>

        {adding && (
          <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-[18px] py-3">
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name (optional)" className="h-9 w-44" />
            <Input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="https://…/Market" className="h-9 min-w-[220px] flex-1" />
            <Button size="sm" className="h-9" disabled={!newUrl.trim() || saving} onClick={addSource}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Add
            </Button>
            <Button size="sm" variant="ghost" className="h-9" onClick={() => { setAdding(false); setNewName(''); setNewUrl(''); }}>
              Cancel
            </Button>
          </div>
        )}

        {sources.length === 0 ? (
          <div className="border-t py-10 text-center text-sm text-muted-foreground">No sources configured.</div>
        ) : (
          sources.map((s, i) => {
            const count = counts[s.id] ?? counts[s.name] ?? null;
            const official = s.trust === 'official';
            return (
              <div key={`${s.id}-${i}`} className={`flex items-center gap-3 border-t px-[18px] py-3 ${s.enabled ? '' : 'opacity-60'}`}>
                <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${official ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                  <Store className="size-[18px]" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{s.name}</span>
                    {official && <Badge variant="secondary" className="bg-primary/10 text-[10px] text-primary">Verified</Badge>}
                  </div>
                  <div className="truncate text-[12.5px] text-muted-foreground">
                    {s.repo_url}
                    {count != null ? ` · ${count} app${count === 1 ? '' : 's'}` : ''}
                    {s.enabled ? '' : ' · disabled'}
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    Channel {s.branch || 'main'}
                    {s.resolved_commit ? ` · resolved ${s.resolved_commit.slice(0, 12)}` : ' · not resolved yet'}
                  </div>
                  {s.refresh_error && <div className="truncate text-[11px] text-destructive">Last refresh failed: {s.refresh_error}</div>}
                </div>
                <Switch checked={s.enabled} disabled={saving} onCheckedChange={(v) => toggle(i, v)} aria-label={`Enable ${s.name}`} />
                <button
                  type="button"
                  onClick={() => remove(i)}
                  disabled={saving}
                  className="text-muted-foreground/50 transition-colors hover:text-destructive disabled:opacity-50"
                  aria-label={`Remove ${s.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          })
        )}
      </section>

      {/* Install from address */}
      <section className="rounded-xl border bg-card p-[22px]">
        <h2 className="text-[15px] font-semibold">Install from address</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Have a link to an app manifest? Install it directly. Only do this for sources you trust.
        </p>
        <div className="mt-4">
          <Button variant="outline" size="sm" className="h-9" onClick={() => setShowInstall(true)}>
            Install from address
          </Button>
        </div>
      </section>

      {showInstall && (
        <InstallFromUrlDialog
          domain={domain}
          onClose={() => setShowInstall(false)}
          onInstallComplete={() => {
            setShowInstall(false);
            load();
          }}
        />
      )}
    </div>
  );
}
