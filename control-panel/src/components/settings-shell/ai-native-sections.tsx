'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Loader2, MoreHorizontal, Plus, RefreshCw, Search, Star, Trash2 } from 'lucide-react';
import { AIIcon } from './ai-icon';
import { Empty, Loading, Status } from './ai-shared';
import {
  accountLabel,
  aiApi,
  formatPrice,
  formatTokens,
  type Account,
  type CatalogModel,
  type CatalogResponse,
  type Group,
  type GroupDetail,
  type Manifest,
} from './ai-types';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Mutation = (work: () => Promise<void>, message: string) => Promise<void>;

function Choice({ label, value, onChange, items, open, onOpenChange }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  items: Array<{ value: string; label: string }>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return <div className="space-y-2"><Label>{label}</Label><Select value={value} onValueChange={onChange} open={open} onOpenChange={onOpenChange}><SelectTrigger aria-label={label} className="bg-background"><SelectValue placeholder={label} /></SelectTrigger><SelectContent>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div>;
}

export function NativeModelsPanel({ accounts, groups, onChanged }: { accounts: Account[]; groups: Group[]; onChanged: () => Promise<void> }) {
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [search, setSearch] = useState('');
  const [provider, setProvider] = useState('all');
  const [capability, setCapability] = useState('all');
  const [availability, setAvailability] = useState('available');
  const [sort, setSort] = useState('recommended');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ page: String(page), pageSize: '24', availability, sort });
      if (search.trim()) params.set('search', search.trim());
      if (provider !== 'all') params.set('provider', provider);
      if (capability !== 'all') params.set('capability', capability);
      setLoading(true); setError('');
      aiApi<CatalogResponse>(`/catalog?${params}`).then(setData).catch((reason) => setError(reason instanceof Error ? reason.message : 'Catalog unavailable')).finally(() => setLoading(false));
    }, 180);
    return () => clearTimeout(timer);
  }, [search, provider, capability, availability, sort, page, reload]);
  const pages = Math.max(1, Math.ceil((data?.total || 0) / (data?.pageSize || 24)));
  const staleSources = data?.sources.filter((source) => source.stale || source.status === 'error') || [];

  return <div className="space-y-4">
    <Card className="gap-4 p-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <div className="relative xl:col-span-2"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" /><Input aria-label="Search models" className="pl-9" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search models or aliases" /></div>
        <Choice label="Availability" value={availability} onChange={(value) => { setAvailability(value); setPage(1); }} items={[{ value: 'available', label: 'Available to me' }, { value: 'all', label: 'All models' }, { value: 'unavailable', label: 'Unavailable' }]} />
        <Choice label="Provider" value={provider} onChange={(value) => { setProvider(value); setPage(1); }} items={[{ value: 'all', label: 'All providers' }, ...(data?.facets.providers || []).map((item) => ({ value: item.id, label: item.name }))]} />
        <Choice label="Capability" value={capability} onChange={(value) => { setCapability(value); setPage(1); }} items={[{ value: 'all', label: 'All capabilities' }, { value: 'reasoning', label: 'Reasoning' }, { value: 'vision', label: 'Vision' }, { value: 'tools', label: 'Tools' }, { value: 'streaming', label: 'Streaming' }]} />
      </div>
      <div className="flex flex-col gap-3 text-xs text-muted-foreground sm:flex-row sm:items-end sm:justify-between"><span>{data ? `${data.total.toLocaleString()} models · refreshed ${new Date(data.generatedAt).toLocaleString()}` : 'Loading catalog'}</span><div className="w-full sm:w-56"><Choice label="Order" value={sort} onChange={(value) => { setSort(value); setPage(1); }} items={[{ value: 'recommended', label: 'Recommended consensus' }, { value: 'newest', label: 'Newest releases' }, { value: 'name', label: 'Name' }, { value: 'price', label: 'Input price' }, { value: 'context', label: 'Context window' }, { value: 'providers', label: 'Provider count' }, ...(data?.benchmarkDescriptors || []).map((benchmark) => ({ value: `benchmark:${benchmark.id}`, label: benchmark.label }))]} /></div></div>
    </Card>
    {staleSources.length > 0 && <Alert variant="destructive">Catalog refresh is stale for {staleSources.map((source) => source.sourceId).join(', ')}. Last-known-good data is still being shown and Pointer will retry automatically.</Alert>}
    {error && <Alert variant="destructive">{error}</Alert>}
    {loading ? <Loading /> : !data?.items.length ? <Empty title="No matching models" description={accounts.length ? 'Try widening the filters or sync a connected provider.' : 'Connect and sync an AI provider first.'} /> : <div data-view="models-list" className="overflow-hidden rounded-xl border bg-card">
      <div className="hidden border-b bg-muted/35 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground lg:grid lg:grid-cols-[minmax(220px,1.65fr)_minmax(120px,.8fr)_minmax(120px,.8fr)_minmax(130px,.9fr)_minmax(170px,1.1fr)_32px] lg:items-center lg:gap-4"><span>Model</span><span>{sort === 'recommended' ? 'Consensus' : sort.startsWith('benchmark:') ? data.benchmarkDescriptors.find((item) => item.id === sort.slice('benchmark:'.length))?.label || 'Benchmark' : 'Benchmark'}</span><span>Context / output</span><span>Price / 1M</span><span>Availability</span><span className="sr-only">Add to group</span></div>
      {data.items.map((model) => {
        const capabilities = Object.entries(model.capabilities).filter(([, enabled]) => enabled).map(([name]) => name);
        const selectedBenchmark = sort.startsWith('benchmark:') ? model.benchmarks.find((benchmark) => benchmark.benchmarkId === sort.slice('benchmark:'.length)) : null;
        const rankingLabel = sort === 'recommended' ? 'Consensus' : selectedBenchmark?.presentation.label || 'Benchmark';
        return <div key={model.id} data-list-row="model" className="relative grid grid-cols-2 gap-3 border-b px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/30 lg:grid-cols-[minmax(220px,1.65fr)_minmax(120px,.8fr)_minmax(120px,.8fr)_minmax(130px,.9fr)_minmax(170px,1.1fr)_32px] lg:items-center lg:gap-4">
          <div className="col-span-2 flex min-w-0 items-center gap-3 pr-10 lg:col-span-1 lg:pr-0"><AIIcon className="size-8" iconKey={model.modelIconKey || model.creatorIconKey} name={model.name} /><div className="min-w-0"><Link className="block truncate text-sm font-semibold hover:underline" href={`/settings/ai/models/${encodeURIComponent(model.slug)}`}>{model.name}</Link><p className="truncate text-xs text-muted-foreground">{model.creator || 'Unknown creator'}{model.releasedAt ? ` · ${new Date(model.releasedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })}` : ''}</p></div></div>
          <div className="text-sm"><span className="mb-0.5 block text-[11px] text-muted-foreground lg:hidden">{rankingLabel}</span>{sort === 'recommended' ? model.recommendedRanking ? <><strong>#{model.recommendedRanking.rank}</strong><p className="truncate text-xs text-muted-foreground">{model.recommendedRanking.coverage}/{model.recommendedRanking.eligibleSources} sources</p></> : <span className="text-xs text-muted-foreground">Awaiting benchmark results</span> : selectedBenchmark?.presentation.effectiveRank != null ? <><strong>#{selectedBenchmark.presentation.effectiveRank}</strong><p className="truncate text-xs text-muted-foreground">{selectedBenchmark.presentation.rankDerived ? 'Derived from score' : selectedBenchmark.presentation.score == null ? 'Published rank' : `${selectedBenchmark.presentation.score.toLocaleString()} points`}</p></> : model.recommendedRanking ? <><strong>#{model.recommendedRanking.rank}</strong><p className="truncate text-xs text-muted-foreground">Consensus</p></> : <span className="text-xs text-muted-foreground">{sort === 'newest' ? 'New · awaiting benchmark results' : 'Awaiting benchmark results'}</span>}</div>
          <div className="text-sm tabular-nums"><span className="mb-0.5 block text-[11px] text-muted-foreground lg:hidden">Context / output</span><strong>{formatTokens(model.contextWindow)}</strong><span className="text-muted-foreground"> / {formatTokens(model.maxOutput)}</span></div>
          <div className="text-sm tabular-nums"><span className="mb-0.5 block text-[11px] text-muted-foreground lg:hidden">Input / output per 1M</span><strong>{formatPrice(model.referencePricing.input)}</strong><span className="text-muted-foreground"> / {formatPrice(model.referencePricing.output)}</span></div>
          <div className="min-w-0 text-sm"><span className="mb-0.5 block text-[11px] text-muted-foreground lg:hidden">Availability</span><div className="flex items-center gap-2"><Status value={model.available} label={model.available ? 'Ready' : 'Unavailable'} /><span className="text-xs text-muted-foreground">{model.availableProviderCount}/{model.providerCount} routes</span></div><p className="mt-1 truncate text-xs capitalize text-muted-foreground">{capabilities.length ? capabilities.join(' · ') : 'No capabilities declared'}</p></div>
          <div className="absolute right-4 top-3 lg:static"><ModelStar model={model} groups={groups} onChanged={async () => { setReload((value) => value + 1); await onChanged(); }} /></div>
        </div>;
      })}
    </div>}
    <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">Page {page} of {pages}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button><Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Next</Button></div></div>
  </div>;
}

function ModelStar({ model, groups, onChanged }: { model: CatalogModel; groups: Group[]; onChanged: () => Promise<void> }) {
  const defaultGroup = groups.find((group) => group.isDefault) || groups[0];
  const [open, setOpen] = useState(false);
  const [groupId, setGroupId] = useState(defaultGroup?.id || '');
  const [routeChoice, setRouteChoice] = useState('');
  const [membershipId, setMembershipId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choices = useMemo(() => model.providers.filter((route) => route.available).flatMap((route) => route.accounts.map((account) => ({
    value: `${route.providerModelKey}\u0000${account.id}`,
    label: `${route.providerName} · ${account.nickname || account.id.slice(-6)}`,
  }))), [model.providers]);

  const inspect = useCallback(async (nextGroupId: string) => {
    if (!nextGroupId) return;
    try {
      const detail = await aiApi<GroupDetail>(`/groups/${encodeURIComponent(nextGroupId)}`);
      const entry = detail.entries.find((item) => item.catalogEntityId === model.id);
      setMembershipId(entry?.id || '');
      const current = entry?.providerModelKey && entry.providerAccountId ? `${entry.providerModelKey}\u0000${entry.providerAccountId}` : '';
      setRouteChoice(choices.some((choice) => choice.value === current) ? current : choices[0]?.value || '');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not inspect this group'); }
  }, [choices, model.id]);

  useEffect(() => { if (open && groupId) void inspect(groupId); }, [open, groupId, inspect]);
  return <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) { setError(''); setGroupId(defaultGroup?.id || groups[0]?.id || ''); } }}>
    <PopoverTrigger asChild><Button variant="ghost" size="icon" className="size-8" aria-label={`Add ${model.name} to a model group`}><Star className={`size-4 ${membershipId ? 'fill-current text-primary' : ''}`} /></Button></PopoverTrigger>
    <PopoverContent className="w-80 space-y-4 p-4" align="end"><div><strong className="text-sm">Add {model.name}</strong><p className="mt-1 text-xs text-muted-foreground">Choose its group and exact private route.</p></div>{groups.length === 0 ? <Empty title="No groups" description="Create a model group first." action={<Button asChild size="sm"><Link href="/settings/ai/groups">Create group</Link></Button>} /> : <>
      <Choice label="Group" value={groupId} onChange={(value) => { setGroupId(value); setMembershipId(''); }} items={groups.map((group) => ({ value: group.id, label: group.isDefault ? `${group.name} · default` : group.name }))} />
      <div className="space-y-2"><Label>Provider</Label><div role="listbox" aria-label="Provider" className="max-h-48 space-y-1 overflow-y-auto rounded-md border bg-popover p-1">{choices.length ? choices.map((choice) => <button key={choice.value} type="button" role="option" aria-selected={routeChoice === choice.value} className={`w-full rounded-sm px-2 py-2 text-left text-sm transition-colors ${routeChoice === choice.value ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'}`} onClick={() => setRouteChoice(choice.value)}>{choice.label}</button>) : <p className="p-2 text-xs text-muted-foreground">No connected provider offers this model.</p>}</div><p className="text-xs text-muted-foreground">Provider choices open automatically so the exact private route is always explicit.</p></div>
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      <div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button><Button size="sm" disabled={busy || !groupId || !routeChoice} onClick={async () => { setBusy(true); setError(''); try { const [providerModelKey, providerAccountId] = routeChoice.split('\u0000'); if (membershipId) await aiApi(`/groups/${groupId}/entries/${membershipId}`, { method: 'PUT', body: JSON.stringify({ providerModelKey, providerAccountId }) }); else await aiApi(`/groups/${groupId}/entries`, { method: 'POST', body: JSON.stringify({ catalogEntityId: model.id, providerModelKey, providerAccountId }) }); await onChanged(); setOpen(false); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not add this model'); } finally { setBusy(false); } }}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}OK</Button></div>
    </>}</PopoverContent>
  </Popover>;
}

export function NativeGroupsPanel({ groups, busy, mutate }: { groups: Group[]; busy: boolean; mutate: Mutation }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Group | null>(null);
  return <div className="space-y-4"><div className="flex justify-end"><Popover open={createOpen} onOpenChange={setCreateOpen}><PopoverTrigger asChild><Button><Plus className="size-4" />New model group</Button></PopoverTrigger><PopoverContent className="space-y-3 p-4"><div><strong className="text-sm">New model group</strong><p className="mt-1 text-xs text-muted-foreground">Applications see this group&apos;s public model names.</p></div><div className="space-y-2"><Label htmlFor="ai-group-name">Name</Label><Input id="ai-group-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Writing tools" /></div><div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>Cancel</Button><Button size="sm" disabled={busy || !name.trim()} onClick={() => void mutate(async () => { await aiApi('/groups', { method: 'POST', body: JSON.stringify({ name: name.trim() }) }); setName(''); setCreateOpen(false); }, 'Model group created')}>Create</Button></div></PopoverContent></Popover></div>
    {groups.length === 0 ? <Empty title="No model groups" description="Create a group to decide which public model names applications can use." /> : <div data-view="groups-list" className="overflow-hidden rounded-xl border bg-card"><div className="hidden border-b bg-muted/35 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:grid md:grid-cols-[minmax(180px,.8fr)_minmax(260px,1.4fr)_100px_auto] md:items-center md:gap-4"><span>Group</span><span>Top models</span><span>Status</span><span className="sr-only">Actions</span></div>{groups.map((group) => <div key={group.id} data-list-row="group" className="relative flex flex-col gap-3 border-b px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/30 md:grid md:grid-cols-[minmax(180px,.8fr)_minmax(260px,1.4fr)_100px_auto] md:items-center md:gap-4"><Link href={`/settings/ai/groups/${encodeURIComponent(group.id)}`} className="absolute inset-0" aria-label={`Open ${group.name}`} /><div className="min-w-0"><div className="flex items-center gap-2"><strong className="truncate text-sm">{group.name}</strong>{group.isDefault && <Badge>Default</Badge>}</div><p className="mt-1 text-xs text-muted-foreground">{group.enabledEntryCount} enabled of {group.entryCount}</p></div><div className="flex min-w-0 items-center gap-3">{group.previewEntries.length ? <>{group.previewEntries.map((entry) => <div key={entry.id} className="flex min-w-0 items-center gap-1.5" title={`${entry.alias || entry.modelName} · ${entry.providerName}`}><AIIcon className="size-6 rounded-md" iconKey={entry.modelIconKey} name={entry.modelName} /><span className="max-w-28 truncate text-xs">{entry.alias || entry.modelName}</span></div>)}{group.entryCount > group.previewEntries.length && <span className="shrink-0 text-xs text-muted-foreground">+{group.entryCount - group.previewEntries.length}</span>}</> : <span className="text-sm text-muted-foreground">No models yet</span>}</div><div><span className="mb-0.5 block text-[11px] text-muted-foreground md:hidden">Status</span><Status value={group.enabledEntryCount > 0} label={group.enabledEntryCount > 0 ? 'Ready' : 'Empty'} /></div><div className="relative z-10 flex justify-end gap-1">{!group.isDefault && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void mutate(() => aiApi(`/groups/${group.id}/set-default`, { method: 'PUT' }).then(() => {}), `${group.name} is now default`)}>Make default</Button>}<Button variant="ghost" size="icon" disabled={group.isDefault} onClick={() => setDeleteTarget(group)} aria-label={`Remove ${group.name}`}><Trash2 className="size-4" /></Button></div></div>)}</div>}
    <ConfirmDialog open={Boolean(deleteTarget)} title={`Remove ${deleteTarget?.name || 'group'}?`} description="Instances using this group will lose their group assignment." confirmLabel="Remove" destructive onCancel={() => setDeleteTarget(null)} onConfirm={() => { const target = deleteTarget; setDeleteTarget(null); if (target) void mutate(() => aiApi(`/groups/${target.id}`, { method: 'DELETE' }).then(() => {}), `${target.name} removed`); }} />
  </div>;
}

type OAuthState = { account: Account; flowId: string; userCode: string; url: string; expiresAt: string; status: 'waiting' | 'connected' | 'denied' | 'expired' | 'error'; error?: string };

export function NativeProvidersPanel({ manifests, accounts, busy, mutate, reload }: { manifests: Manifest[]; accounts: Account[]; busy: boolean; mutate: Mutation; reload: () => Promise<void> }) {
  const [addOpen, setAddOpen] = useState(false);
  const [providerId, setProviderId] = useState(manifests[0]?.id || '');
  const [nickname, setNickname] = useState('');
  const [credential, setCredential] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);
  const [oauth, setOAuth] = useState<OAuthState | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selected = manifests.find((item) => item.id === providerId);
  const isOAuth = selected?.auth?.type === 'oauth-device-flow' || selected?.auth?.type === 'oauth-pkce';
  const customEndpoint = selected?.endpoint?.mode === 'required';
  useEffect(() => { if (!providerId && manifests[0]) setProviderId(manifests[0].id); }, [manifests, providerId]);
  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);

  const poll = useCallback((account: Account, flowId: string, delay: number) => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = setTimeout(async () => {
      try {
        const result = await aiApi<{ status: OAuthState['status'] | 'pending'; retryAfter?: number }>(`/providers/${encodeURIComponent(account.providerId)}/oauth/device/${encodeURIComponent(flowId)}/poll`, { method: 'POST', body: '{}' });
        if (result.status === 'waiting' || result.status === 'pending') return poll(account, flowId, result.retryAfter ?? 5);
        const terminalStatus: OAuthState['status'] = result.status;
        setOAuth((current) => current ? { ...current, status: terminalStatus } : current);
        if (result.status === 'connected') await reload();
      } catch (reason) { setOAuth((current) => current ? { ...current, status: 'error', error: reason instanceof Error ? reason.message : 'Authorization polling failed' } : current); }
    }, Math.max(1, delay) * 1000);
  }, [reload]);

  async function startOAuth(account: Account) {
    const started = await aiApi<{ flowId: string; userCode: string; verificationUri: string; verificationUriComplete: string | null; interval: number; expiresAt: string }>(`/providers/${encodeURIComponent(account.providerId)}/oauth/device/start`, { method: 'POST', body: JSON.stringify({ providerAccountId: account.id }) });
    setOAuth({ account, flowId: started.flowId, userCode: started.userCode, url: started.verificationUriComplete || started.verificationUri, expiresAt: started.expiresAt, status: 'waiting' });
    poll(account, started.flowId, started.interval);
  }

  async function closeOAuth() {
    const current = oauth; setOAuth(null); if (pollRef.current) clearTimeout(pollRef.current);
    if (current && current.status === 'waiting') await aiApi(`/providers/${encodeURIComponent(current.account.providerId)}/oauth/device/${encodeURIComponent(current.flowId)}`, { method: 'DELETE' }).catch(() => {});
  }

  return <div className="space-y-4"><div className="flex justify-end"><Popover open={addOpen} onOpenChange={setAddOpen}><PopoverTrigger asChild><Button><Plus className="size-4" />Add provider</Button></PopoverTrigger><PopoverContent className="w-[min(24rem,calc(100vw-2rem))] space-y-4 p-4"><div><strong className="text-sm">Add provider</strong><p className="mt-1 text-xs text-muted-foreground">Add the same provider more than once; nicknames are optional and private.</p></div><Choice label="Provider type" value={providerId} onChange={(value) => { setProviderId(value); setEndpoint(''); }} items={manifests.map((manifest) => ({ value: manifest.id, label: manifest.name }))} /><div className="space-y-2"><Label htmlFor="provider-nickname">Nickname (optional)</Label><Input id="provider-nickname" value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="Work, personal…" /></div>{!isOAuth && <div className="space-y-2"><Label htmlFor="provider-key">API key</Label><Input id="provider-key" type="password" autoComplete="off" value={credential} onChange={(event) => setCredential(event.target.value)} /></div>}{customEndpoint && <div className="space-y-2"><Label htmlFor="provider-endpoint">{selected?.endpoint?.label || 'API endpoint'}</Label><Input id="provider-endpoint" type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder={selected?.endpoint?.placeholder || 'https://ai.example.com/v1'} /><p className="text-xs text-muted-foreground">This endpoint belongs to the selected custom provider type. Official providers keep their official endpoint.</p></div>}<div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => setAddOpen(false)}>Cancel</Button><Button size="sm" disabled={busy || !providerId || (!isOAuth && !credential) || (customEndpoint && !endpoint.trim())} onClick={() => void mutate(async () => { const created = await aiApi<{ accountId: string }>('/providers/from-manifest', { method: 'POST', body: JSON.stringify({ manifestId: providerId, ...(credential ? { apiKey: credential } : {}), ...(nickname.trim() ? { label: nickname.trim() } : {}), ...(customEndpoint ? { baseUrl: endpoint.trim() } : {}) }) }); setCredential(''); setEndpoint(''); setNickname(''); setAddOpen(false); if (isOAuth) { await reload(); const account = (await aiApi<Account[]>('/provider-accounts')).find((item) => item.id === created.accountId); if (account) await startOAuth(account); } }, isOAuth ? 'Provider added — finish sign-in' : 'Provider added')}>{isOAuth ? 'Add and connect' : 'Add provider'}</Button></div></PopoverContent></Popover></div>
    {accounts.length === 0 ? <Empty title="No providers" description="Connect a built-in provider or a custom compatible API endpoint." /> : <div data-view="providers-list" className="overflow-hidden rounded-xl border bg-card"><div className="hidden border-b bg-muted/35 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:grid md:grid-cols-[minmax(200px,1fr)_minmax(180px,1fr)_120px_auto] md:items-center md:gap-4"><span>Provider</span><span>Endpoint</span><span>Status</span><span className="sr-only">Actions</span></div>{accounts.map((account) => <div key={account.id} data-list-row="provider" className="flex flex-col gap-3 border-b px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/30 md:grid md:grid-cols-[minmax(200px,1fr)_minmax(180px,1fr)_120px_auto] md:items-center md:gap-4"><div className="flex min-w-0 items-center gap-3"><AIIcon className="size-8 rounded-md" iconKey={account.iconKey || account.providerId} name={account.providerName} /><div className="min-w-0"><Link className="block truncate text-sm font-semibold hover:underline" href={`/settings/ai/providers/${encodeURIComponent(account.id)}`}>{accountLabel(account)}</Link><p className="truncate text-xs text-muted-foreground">{account.providerName} · {account.providerType}</p></div></div><div className="min-w-0"><span className="mb-0.5 block text-[11px] text-muted-foreground md:hidden">Endpoint</span><p className="truncate text-xs text-muted-foreground">{account.baseUrl || 'Official provider endpoint'}</p></div><div><span className="mb-0.5 block text-[11px] text-muted-foreground md:hidden">Status</span><Status value={account.credentialConfigured ? account.status : 'needs connection'} /></div><div className="flex justify-end gap-1">{account.authType.includes('oauth') && !account.credentialConfigured && <Button variant="outline" size="sm" disabled={busy} onClick={() => void mutate(() => startOAuth(account), `Sign in to ${accountLabel(account)}`)}>Connect</Button>}{account.credentialConfigured && <><Button variant="ghost" size="sm" disabled={busy} onClick={() => void mutate(() => aiApi(`/provider-accounts/${account.id}/test`, { method: 'POST' }).then(() => {}), `${accountLabel(account)} connection works`)}>Test</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => void mutate(() => aiApi(`/provider-accounts/${account.id}/sync`, { method: 'POST' }).then(() => {}), `${accountLabel(account)} models synced`)}><RefreshCw className="size-4" />Sync</Button></>}<Button asChild variant="ghost" size="icon"><Link href={`/settings/ai/providers/${encodeURIComponent(account.id)}`} aria-label={`Details for ${accountLabel(account)}`}><MoreHorizontal className="size-4" /></Link></Button><Button variant="ghost" size="icon" onClick={() => setDeleteTarget(account)} aria-label={`Remove ${accountLabel(account)}`}><Trash2 className="size-4" /></Button></div></div>)}</div>}
    <ConfirmDialog open={Boolean(deleteTarget)} title={`Remove ${deleteTarget ? accountLabel(deleteTarget) : 'provider'}?`} description="Models using this provider account must be moved first." confirmLabel="Remove" destructive onCancel={() => setDeleteTarget(null)} onConfirm={() => { const target = deleteTarget; setDeleteTarget(null); if (target) void mutate(() => aiApi(`/provider-accounts/${target.id}`, { method: 'DELETE' }).then(() => {}), `${accountLabel(target)} removed`); }} />
    {oauth && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true" aria-label="Provider sign-in"><Card className="w-full max-w-md gap-5 p-6"><div><h2 className="font-semibold">Connect {accountLabel(oauth.account)}</h2><p className="mt-1 text-sm text-muted-foreground">Sign in at the provider, then leave this window open while Pointer finishes securely.</p></div>{oauth.status === 'waiting' ? <><div className="rounded-lg border bg-muted/35 p-4 text-center"><p className="text-xs text-muted-foreground">Your one-time code</p><code className="mt-2 block text-2xl font-semibold tracking-[0.2em]">{oauth.userCode}</code><p className="mt-2 text-xs text-muted-foreground">Expires {new Date(oauth.expiresAt).toLocaleTimeString()}</p></div><div className="flex flex-wrap justify-center gap-2"><Button variant="outline" onClick={() => void navigator.clipboard.writeText(oauth.userCode)}><Copy className="size-4" />Copy code</Button><Button asChild><a href={oauth.url} target="_blank" rel="noreferrer">Open provider sign-in<ExternalLink className="size-4" /></a></Button></div><div className="flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Waiting for authorization…</div></> : oauth.status === 'connected' ? <Alert><Check className="size-4" />Provider connected. Models will sync automatically.</Alert> : <Alert variant="destructive">{oauth.error || (oauth.status === 'denied' ? 'Authorization was denied.' : 'The authorization code expired. Start again.')}</Alert>}<div className="flex justify-end"><Button variant="outline" onClick={() => void closeOAuth()}>{oauth.status === 'waiting' ? 'Cancel' : 'Done'}</Button></div></Card></div>}
  </div>;
}
