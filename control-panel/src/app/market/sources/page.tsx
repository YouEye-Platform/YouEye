'use client';

import { useTranslations as useInterfaceTranslations, useLocale } from "next-intl";
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Check, ChevronLeft, Loader2, Plus, RefreshCw, Store, Trash2, TriangleAlert, X } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { InstallFromUrlDialog } from '@/components/market/install-from-url-dialog';
import { MarketPreview, type MarketPreviewData } from '@/components/market/market-preview';
import { authenticatedFetch } from '@/lib/api-client';

interface MarketSourceConfig {
  id: string;
  name: string;
  kind: 'official' | 'url';
  /** The address of a custom market; empty for the official Market. */
  url: string;
  /** Where the box's copy of the market was read from (the official Market's follows the box's channel). */
  address?: string | null;
  /** What the market says about itself and its accepted state. */
  market?: {
    name: string; publisher: string; homepage?: string; commit?: string; sequence_date: string;
    apps: number; native?: number;
  } | null;
  refreshed_at?: string | null;
  checked_at?: string | null;
  refresh_error?: string;
  enabled: boolean;
  priority: number;
  /** Set by the Control Panel when the owner accepted this custom source; without it its apps are not installed. */
  accepted_at?: string;
}

/** A source this box had before markets were read by address (a Git repository); it was removed. */
interface RemovedSource {
  id: string;
  name: string;
  address: string;
  branch?: string;
}

export default function MarketSourcesPage() {
  const translateInterface = useInterfaceTranslations("interface");
  const locale = useLocale();

  const [sources, setSources] = useState<MarketSourceConfig[]>([]);
  const [removedSources, setRemovedSources] = useState<RemovedSource[]>([]);
  const [domain, setDomain] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [acceptRisk, setAcceptRisk] = useState(false);
  // What the address is, read before anything is added (POST /api/market/add/preview writes nothing).
  const [preview, setPreview] = useState<MarketPreviewData | null>(null);
  const [checking, setChecking] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [acceptTick, setAcceptTick] = useState(false);
  const [showInstall, setShowInstall] = useState(false);

  const applyListing = useCallback((data: { sources?: unknown; removed_sources?: unknown }) => {
    if (Array.isArray(data.sources)) setSources(data.sources as MarketSourceConfig[]);
    if (Array.isArray(data.removed_sources)) setRemovedSources(data.removed_sources as RemovedSource[]);
  }, []);

  const load = useCallback(async () => {
    setError('');
    try {
      const [srcRes, domRes] = await Promise.all([fetch('/api/market/source'), fetch('/api/domain')]);
      if (srcRes.ok) {
        applyListing(await srcRes.json());
      } else {
        console.error('[Market sources] source load failed', srcRes.status);
        setError(translateInterface("mc496d50c849a"));
      }
      if (domRes.ok) {
        const d = await domRes.json();
        setDomain(d.domain || '');
      }
    } catch (e) {
      console.error('[Market sources] load failed', e);
      setError(translateInterface("mc496d50c849a"));
    }
  }, [applyListing, translateInterface]);

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
            id: s.id,
            name: s.name?.trim() || `Market ${i + 1}`,
            url: s.url?.trim(),
            enabled: s.enabled,
            priority: Number.isFinite(Number(s.priority)) ? Number(s.priority) : i,
          }))
          // The official Market has no stored address but is always kept.
          .filter((s) => s.url || s.id === 'official');
        const res = await authenticatedFetch('/api/market/source', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active_sources: normalized }),
        });
        if (!res.ok) throw new Error(translateInterface("m802f2bef7c23"));
        applyListing(await res.json());
      } catch (e) {
        console.error('[Market sources] save failed', e);
        setError(translateInterface("m3a1797265a2e"));
        load(); // revert to the server's truth
      } finally {
        setSaving(false);
      }
    },
    [applyListing, load, translateInterface],
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

  const resetAdding = () => {
    setAdding(false);
    setNewName('');
    setNewUrl('');
    setAcceptRisk(false);
    setPreview(null);
  };

  // First what the address is: the market's own name, publisher and apps. Nothing is added yet.
  const checkAddress = async () => {
    if (!newUrl.trim()) return;
    setChecking(true);
    setError('');
    setPreview(null);
    setAcceptRisk(false);
    try {
      const res = await authenticatedFetch(`/api/market/add/preview?market=${encodeURIComponent(newUrl.trim())}`, { method: 'POST', cache: 'no-store' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.kind !== 'market') throw new Error(typeof d.error === 'string' ? d.error : translateInterface("m5adf64deb21d"));
      setPreview(d as MarketPreviewData);
    } catch (e) {
      setError(e instanceof Error ? e.message : translateInterface("m5adf64deb21d"));
    } finally {
      setChecking(false);
    }
  };

  // Adding is its own request: the server records the owner's consent (the tick) and accepts the source.
  const addSource = async () => {
    if (!preview || preview.already_added || !acceptRisk) return;
    setSaving(true);
    setError('');
    try {
      const res = await authenticatedFetch('/api/market/source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Without a name, the source is called by its host.
        body: JSON.stringify({ url: preview.address, name: newName.trim() || undefined, acceptRisk: true }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof d.error === 'string' ? d.error : translateInterface("m3a1797265a2e"));
      applyListing(d);
      resetAdding();
    } catch (e) {
      console.error('[Market sources] add failed', e);
      setError(e instanceof Error ? e.message : translateInterface("m3a1797265a2e"));
    } finally {
      setSaving(false);
    }
  };

  // Ask one market again now and wait for its answer.
  const refreshSource = async (id: string) => {
    setRefreshing(id);
    setError('');
    try {
      const res = await authenticatedFetch('/api/market/source/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof d.error === 'string' ? d.error : translateInterface("m5adf64deb21d"));
      applyListing(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : translateInterface("m5adf64deb21d"));
    } finally {
      setRefreshing(null);
    }
  };

  // Accepting a custom market that was added before consent existed: the same warning and tick as adding one.
  const acceptSource = async (id: string) => {
    if (!acceptTick) return;
    setSaving(true);
    setError('');
    try {
      const res = await authenticatedFetch('/api/market/source/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof d.error === 'string' ? d.error : translateInterface("m3a1797265a2e"));
      setAccepting(null);
      setAcceptTick(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : translateInterface("m3a1797265a2e"));
    } finally {
      setSaving(false);
    }
  };

  const dismissRemoved = async () => {
    try {
      const res = await authenticatedFetch('/api/market/source', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dismiss_removed_sources: true }),
      });
      if (!res.ok) throw new Error(translateInterface("m802f2bef7c23"));
      applyListing(await res.json());
    } catch {
      setError(translateInterface("m3a1797265a2e"));
    }
  };

  const when = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
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
        <ChevronLeft className="h-4 w-4" /> {" "}{translateInterface("m5238d9bd03d5")}</Link>
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          {translateInterface("mcaf85b0888d7")}<Badge variant="secondary" className="text-[11px]">{translateInterface("mc1c224b03cd9")}</Badge>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{translateInterface("mb4b934fc5615")}</p>
      </div>

      {error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive">{error}</div>}

      {removedSources.length > 0 && (
        <div role="status" className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1">
            <p>
              {translateInterface("m126d081e8216", {
                sources: removedSources.map((source) => source.name).join(', '),
              })}
            </p>
            <ul className="mt-1 space-y-0.5">
              {removedSources.map((source) => (
                <li key={`${source.id}-${source.address}`} className="truncate font-mono text-[11.5px] text-muted-foreground" title={source.address}>
                  {source.address}{source.branch ? ` (${source.branch})` : ''}
                </li>
              ))}
            </ul>
          </div>
          <Button size="sm" variant="ghost" className="h-8" onClick={dismissRemoved}>
            <X className="h-3.5 w-3.5" /> {" "}{translateInterface("m48845bff334a")}</Button>
        </div>
      )}

      {/* Connected sources */}
      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center justify-between px-[18px] py-3">
          <h2 className="text-[15px] font-semibold">{translateInterface("mb807ad0945e7")}</h2>
          <Button size="sm" className="h-8" onClick={() => (adding ? resetAdding() : setAdding(true))}>
            <Plus className="h-3.5 w-3.5" /> {" "}{translateInterface("m6ea6c9ec2a76")}</Button>
        </div>

        {adding && (
          <div className="space-y-3 border-t bg-muted/30 px-[18px] py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={translateInterface("me09b37bcc4f3")} className="h-9 w-44" />
              <Input
                value={newUrl}
                onChange={(e) => { setNewUrl(e.target.value); setPreview(null); setAcceptRisk(false); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && newUrl.trim()) void checkAddress(); }}
                placeholder="https://…/Market"
                aria-label={translateInterface("m9fbf7adce0d1")}
                className="h-9 min-w-[220px] flex-1 font-mono"
              />
              <Button size="sm" variant="outline" className="h-9" disabled={!newUrl.trim() || checking} onClick={checkAddress}>
                {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{translateInterface("m2b0ebbd9991d")}</Button>
              <Button size="sm" variant="ghost" className="h-9" onClick={resetAdding}>
                {translateInterface("m19766ed6ccb2")}</Button>
            </div>
            {preview && (
              <>
                <MarketPreview preview={preview} />
                {preview.already_added ? (
                  <p className="text-[13px] text-foreground">{translateInterface("mb7a1bb084dc2")}</p>
                ) : (
                  <>
                    <p className="flex items-start gap-2 text-[12.5px] text-amber-700 dark:text-amber-500">
                      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{translateInterface("mbfa5007b34bb")}</p>
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="flex cursor-pointer items-center gap-2 text-[13px] text-foreground">
                        <input type="checkbox" checked={acceptRisk} onChange={(e) => setAcceptRisk(e.target.checked)} />
                        {translateInterface("m2dca61bd9de2")}</label>
                      <Button size="sm" className="h-9" disabled={!acceptRisk || saving} onClick={addSource}>
                        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {" "}{translateInterface("m9fd728c66c9a")}</Button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {sources.length === 0 ? (
          <div className="border-t py-10 text-center text-sm text-muted-foreground">{translateInterface("mf755d54099bc")}</div>
        ) : (
          sources.map((s, i) => {
            const official = s.kind === 'official';
            const notAccepted = !official && !s.accepted_at;
            const count = s.market ? s.market.apps + (s.market.native ?? 0) : null;
            const address = s.address || s.url;
            return (
              <div key={`${s.id}-${i}`} className={`border-t px-[18px] py-3 ${s.enabled ? '' : 'opacity-60'}`}>
                <div className="flex items-start gap-3">
                  <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${official ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                    <Store className="size-[18px]" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="truncate">{s.name}</span>
                      {official && <Badge variant="secondary" className="bg-primary/10 text-[10px] text-primary">{translateInterface("m4f7838402f37")}</Badge>}
                      {notAccepted && <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-700 dark:text-amber-500">{translateInterface("m8ba391628be0")}</Badge>}
                      <span className="text-[12.5px] font-normal text-muted-foreground">
                        {count != null ? translateInterface("m71287f6e69e3", {count}) : ''}
                        {s.enabled ? '' : translateInterface("m79fb364bd287")}
                      </span>
                    </div>
                    {official && address ? (
                      <div className="truncate text-[12.5px] text-muted-foreground" title={address}>
                        {translateInterface("mb4a6242f5703", { address })}
                      </div>
                    ) : address ? (
                      <div className="truncate font-mono text-[12px] text-muted-foreground" title={address}>{address}</div>
                    ) : null}
                    {s.market && !official && (
                      <div className="truncate text-[12px] text-muted-foreground">
                        {translateInterface("mf2c804fb5a2d", { name: s.market.name, publisher: s.market.publisher })}
                      </div>
                    )}
                    {s.market && (
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {[s.market.commit?.slice(0, 8), when(s.market.sequence_date)].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    <div className="text-[11.5px] text-muted-foreground">
                      {s.refreshed_at
                        ? translateInterface("mecf18a110466", { time: when(s.refreshed_at) })
                        : translateInterface("md8c1fe2ed6cf")}
                    </div>
                    {s.refresh_error && <div className="break-words text-[11px] text-destructive">{translateInterface("mef30471405f6")}{" "}{s.refresh_error}</div>}
                    {notAccepted && <div className="text-[11.5px] text-amber-700 dark:text-amber-500">{translateInterface("m36c5f4c7b0b5")}</div>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8"
                      onClick={() => refreshSource(s.id)}
                      disabled={refreshing !== null || !s.enabled}
                      title={translateInterface("m148677068467")}
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${refreshing === s.id ? 'animate-spin' : ''}`} /> {" "}{translateInterface("m148677068467")}</Button>
                    {notAccepted && (
                      <Button size="sm" variant="outline" className="h-8" disabled={saving} onClick={() => { setAccepting(accepting === s.id ? null : s.id); setAcceptTick(false); }}>
                        {translateInterface("m89713b9c9c1b")}</Button>
                    )}
                    <Switch checked={s.enabled} disabled={saving} onCheckedChange={(v) => toggle(i, v)} aria-label={translateInterface("me6e7a76be787", { value0: String(s.name) })} />
                    {!official && (
                    <button
                      type="button"
                      onClick={() => remove(i)}
                      disabled={saving}
                      className="text-muted-foreground/50 transition-colors hover:text-destructive disabled:opacity-50"
                      aria-label={translateInterface("m3028bf7d2dec", { value0: String(s.name) })}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                    )}
                  </div>
                </div>
                {accepting === s.id && notAccepted && (
                  <div className="ml-12 mt-2 space-y-2 rounded-lg border bg-muted/30 p-3">
                    <p className="flex items-start gap-2 text-[12.5px] text-amber-700 dark:text-amber-500">
                      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{translateInterface("mbfa5007b34bb")}</p>
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="flex cursor-pointer items-center gap-2 text-[13px] text-foreground">
                        <input type="checkbox" checked={acceptTick} onChange={(e) => setAcceptTick(e.target.checked)} />
                        {translateInterface("m2dca61bd9de2")}</label>
                      <Button size="sm" className="h-8" disabled={!acceptTick || saving} onClick={() => acceptSource(s.id)}>
                        <Check className="h-4 w-4" /> {" "}{translateInterface("m89713b9c9c1b")}</Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>

      {/* Install from address */}
      <section className="rounded-xl border bg-card p-[22px]">
        <h2 className="text-[15px] font-semibold">{translateInterface("m01314216592f")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {translateInterface("mbeed2c2049c2")}</p>
        <div className="mt-4">
          <Button variant="outline" size="sm" className="h-9" onClick={() => setShowInstall(true)}>
            {translateInterface("m01314216592f")}</Button>
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
