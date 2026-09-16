'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import { NativeGroupsPanel, NativeModelsPanel, NativeProvidersPanel } from './ai-native-sections';
import { AIModelPicker } from './ai-model-picker';
import { AIShell, Empty, Loading, MetricCards, RecentUsageTable, Status } from './ai-shared';
import {
  aiApi,
  streamModelTest,
  type Account,
  type AISection,
  type APIKey,
  type Breakdown,
  type Group,
  type Instance,
  type Manifest,
  type Stats,
  type TestTargets,
} from './ai-types';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

const sectionLabels: Record<AISection, string> = {
  models: 'Models',
  groups: 'Groups',
  instances: 'Instances',
  providers: 'Providers',
  usage: 'Usage',
  playground: 'Playground',
};

const sectionDescriptions: Record<AISection, string> = {
  models: 'Browse the complete catalog in benchmark order and add exact routes to groups.',
  groups: 'Expose friendly model names to applications while keeping provider routes private.',
  instances: 'Create isolated AI endpoints and manage each instance’s API keys.',
  providers: 'Connect providers and custom compatible endpoints. Credentials stay private to your user.',
  usage: 'Inspect your requests, performance, errors, tokens, and cost.',
  playground: 'Test or compare exact provider-account routes before exposing them to applications.',
};

function useAvailableId<T extends { id: string }>(items: T[], preferredId = '') {
  const [selected, setSelected] = useState('');
  const value = items.some((item) => item.id === selected)
    ? selected
    : preferredId && items.some((item) => item.id === preferredId)
      ? preferredId
      : items[0]?.id || '';
  return [value, setSelected] as const;
}

export function AIClient({ section = 'models' }: { section?: AISection }) {
  const [manifests, setManifests] = useState<Manifest[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [keys, setKeys] = useState<APIKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const [manifestRows, accountRows, groupRows, instanceRows, keyRows] = await Promise.all([
        aiApi<Manifest[]>('/providers/manifests'),
        aiApi<Account[]>('/provider-accounts'),
        aiApi<Group[]>('/groups'),
        aiApi<Instance[]>('/instances'),
        aiApi<APIKey[]>('/keys'),
      ]);
      setManifests(manifestRows);
      setAccounts(accountRows);
      setGroups(groupRows);
      setInstances(instanceRows);
      setKeys(keyRows);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'AI service is unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function mutate(work: () => Promise<void>, message: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      await work();
      if (message) setNotice(message);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'AI request failed');
    } finally {
      setBusy(false);
    }
  }

  return <AIShell section={section}>
    <div className="space-y-5">
      <div><h2 className="text-lg font-semibold">{sectionLabels[section]}</h2><p className="mt-1 text-sm text-muted-foreground">{sectionDescriptions[section]}</p></div>
      {error && <Alert variant="destructive">{error}</Alert>}
      {notice && <Alert><Check className="size-4" />{notice}</Alert>}
      {loading ? <Loading /> : <>
        {section === 'models' && <NativeModelsPanel accounts={accounts} groups={groups} onChanged={load} />}
        {section === 'groups' && <NativeGroupsPanel groups={groups} busy={busy} mutate={mutate} />}
        {section === 'instances' && <InstancesPanel instances={instances} groups={groups} keys={keys} busy={busy} mutate={mutate} />}
        {section === 'providers' && <NativeProvidersPanel manifests={manifests} accounts={accounts} busy={busy} mutate={mutate} reload={load} />}
        {section === 'usage' && <UsagePanel />}
        {section === 'playground' && <Playground />}
      </>}
    </div>
  </AIShell>;
}

function InstancesPanel({ instances, groups, keys, busy, mutate }: {
  instances: Instance[];
  groups: Group[];
  keys: APIKey[];
  busy: boolean;
  mutate: (work: () => Promise<void>, message: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useAvailableId(groups, groups.find((item) => item.isDefault)?.id);
  const [deleteTarget, setDeleteTarget] = useState<Instance | null>(null);
  return <div className="space-y-4">
    <Card className="gap-3 p-4"><h3 className="font-semibold">New instance</h3><div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"><Input aria-label="Instance name" value={name} onChange={(event) => setName(event.target.value)} placeholder="My coding apps" /><Choice label="Model group" value={groupId} onChange={setGroupId} items={groups.map((item) => ({ value: item.id, label: item.name }))} /><Button disabled={busy || !name.trim() || !groupId} onClick={() => void mutate(async () => { await aiApi('/instances', { method: 'POST', body: JSON.stringify({ name: name.trim(), modelGroupId: groupId }) }); setName(''); }, 'AI instance created')}><Plus className="size-4" />Create</Button></div></Card>
    {instances.length === 0 ? <Empty title="No AI instances" description="Create an instance to give an application an isolated model catalog and its own API keys." /> : <div className="grid gap-3 md:grid-cols-2">{instances.map((instance) => { const group = groups.find((item) => item.id === instance.modelGroupId); const activeKeys = keys.filter((item) => item.instanceId === instance.id && !item.revoked).length; const appIcon = instance.icon?.startsWith('https://') || instance.icon?.startsWith('/api/market/image?') ? instance.icon : undefined; return <Card key={instance.id} className="gap-4 p-4"><div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-start gap-3">{instance.managedApplication && <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">{appIcon ? <img src={appIcon} alt="" className="size-9 object-cover" /> : <Sparkles className="size-4 text-primary" />}</div>}<div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Link href={`/settings/ai/instances/${encodeURIComponent(instance.id)}`} className="font-semibold hover:underline">{instance.name}</Link>{instance.managedApplication && <Badge variant="secondary">Installed app</Badge>}</div><p className="mt-1 font-mono text-xs text-muted-foreground">{instance.id}</p></div></div><Status value={instance.state} /></div><dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-muted-foreground">Model group</dt><dd className="mt-1 font-medium">{group?.name || 'None'}</dd></div><div><dt className="text-xs text-muted-foreground">Active keys</dt><dd className="mt-1 font-medium">{activeKeys}</dd></div></dl><div className="flex items-center justify-between"><Button asChild variant="outline" size="sm"><Link href={`/settings/ai/instances/${encodeURIComponent(instance.id)}`}>Open instance</Link></Button><Button variant="ghost" size="icon" disabled={instance.origin === 'managed'} onClick={() => setDeleteTarget(instance)} aria-label={`Remove ${instance.name}`}><Trash2 className="size-4" /></Button></div></Card>; })}</div>}
    <ConfirmDialog open={Boolean(deleteTarget)} title={`Remove ${deleteTarget?.name || 'instance'}?`} description="Its API keys will stop working immediately." confirmLabel="Remove" destructive onCancel={() => setDeleteTarget(null)} onConfirm={() => { const target = deleteTarget; setDeleteTarget(null); if (target) void mutate(() => aiApi(`/instances/${target.id}`, { method: 'DELETE' }).then(() => {}), `${target.name} removed`); }} />
  </div>;
}

function UsagePanel() {
  const [days, setDays] = useState('30');
  const [group, setGroup] = useState('model');
  const [source, setSource] = useState('all');
  const [outcome, setOutcome] = useState('all');
  const [stats, setStats] = useState<Stats | null>(null);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ days });
    if (source !== 'all') params.set('source', source);
    if (outcome !== 'all') params.set('outcome', outcome);
    const grouped = new URLSearchParams(params); grouped.set('group', group);
    Promise.all([aiApi<Stats>(`/stats/summary?${params}`), aiApi<Breakdown>(`/stats/breakdown?${grouped}`)]).then(([nextStats, nextBreakdown]) => {
      if (!cancelled) { setStats(nextStats); setBreakdown(nextBreakdown); setError(''); }
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Usage unavailable'); });
    return () => { cancelled = true; };
  }, [days, group, source, outcome]);

  return <div className="space-y-5"><Card className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4"><Choice label="Range" value={days} onChange={setDays} items={['1', '7', '30', '90'].map((value) => ({ value, label: `${value} days` }))} /><Choice label="Source" value={source} onChange={setSource} items={[{ value: 'all', label: 'All sources' }, { value: 'proxy', label: 'API proxy' }, { value: 'test', label: 'Playground' }]} /><Choice label="Outcome" value={outcome} onChange={setOutcome} items={[{ value: 'all', label: 'All outcomes' }, { value: 'success', label: 'Success' }, { value: 'upstream_error', label: 'Upstream error' }, { value: 'timeout', label: 'Timeout' }, { value: 'aborted', label: 'Aborted' }]} /><Choice label="Group by" value={group} onChange={setGroup} items={['model', 'provider', 'account', 'instance', 'key', 'source', 'outcome'].map((value) => ({ value, label: `Group by ${value}` }))} /></Card>
    {error && <Alert variant="destructive">{error}</Alert>}
    {!stats ? <Loading /> : <><MetricCards stats={stats} /><div><h3 className="mb-3 font-semibold">Grouped by {breakdown?.group}</h3>{!breakdown?.items.length ? <Empty title="No matching usage" description="Change the filters or make a request through an instance or Playground." /> : <Card className="block overflow-hidden p-0"><div className="overflow-x-auto"><table className="w-full min-w-[780px] text-sm"><thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-3 font-medium">ID</th><th className="px-4 py-3 font-medium">Requests</th><th className="px-4 py-3 font-medium">Success</th><th className="px-4 py-3 font-medium">Tokens in / out</th><th className="px-4 py-3 font-medium">Cost</th><th className="px-4 py-3 font-medium">Latency / TTFB</th></tr></thead><tbody className="divide-y">{breakdown.items.map((row) => <tr key={row.id || 'none'}><td className="px-4 py-3 font-mono text-xs">{row.id || 'Unassigned'}</td><td className="px-4 py-3">{row.requests}</td><td className="px-4 py-3">{row.successRate == null ? '—' : `${row.successRate.toFixed(1)}%`}</td><td className="px-4 py-3">{row.inputTokens.toLocaleString()} / {row.outputTokens.toLocaleString()}</td><td className="px-4 py-3">{row.totalCost == null ? 'Unknown' : `$${row.totalCost.toFixed(5)}`}</td><td className="px-4 py-3">{row.avgLatency == null ? '—' : `${Math.round(row.avgLatency)} ms`} / {row.avgTtfb == null ? '—' : `${Math.round(row.avgTtfb)} ms`}</td></tr>)}</tbody></table></div></Card>}</div><div><h3 className="mb-3 font-semibold">Requests</h3><RecentUsageTable rows={stats.recent} /></div></>}
  </div>;
}

type RunResult = { output: string; status: string; latency: number | null; error: string };

function Playground() {
  const [targets, setTargets] = useState<TestTargets>({ models: [], providers: [] });
  const [primary, setPrimary] = useState('');
  const [secondary, setSecondary] = useState('');
  const [compare, setCompare] = useState(false);
  const [prompt, setPrompt] = useState('write me 2 sentences about cool cats.');
  const [maxTokens, setMaxTokens] = useState(256);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<RunResult[]>([{ output: '', status: 'Ready', latency: null, error: '' }, { output: '', status: 'Ready', latency: null, error: '' }]);
  const options = useMemo(() => targets.models.flatMap((model) => model.providers.map((route) => ({
    value: route.id,
    model,
    route,
    modelName: model.name,
    creator: model.creator,
    modelIconKey: model.modelIconKey,
    providerName: route.providerName,
    providerIconKey: route.providerIconKey,
    accountLabel: route.providerAccountNickname || route.providerAccountId.slice(-6),
    rawModelId: route.rawModelId,
    aliases: model.aliases,
  }))), [targets]);

  useEffect(() => { aiApi<TestTargets>('/test-model/targets').then((rows) => { setTargets(rows); const flat = rows.models.flatMap((model) => model.providers); setPrimary(flat[0]?.id || ''); setSecondary(flat[1]?.id || flat[0]?.id || ''); }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Playground unavailable')); }, []);

  async function runOne(value: string, index: number) {
    const selected = options.find((item) => item.value === value);
    if (!selected) throw new Error('Select a model route');
    const started = performance.now();
    setResults((current) => current.map((item, itemIndex) => itemIndex === index ? { output: '', status: 'Connecting', latency: null, error: '' } : item));
    await streamModelTest({ providerId: selected.route.providerId, providerAccountId: selected.route.providerAccountId, modelId: selected.route.rawModelId, prompt, maxTokens }, {
      onDelta(delta) { setResults((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, output: item.output + delta, status: 'Streaming' } : item)); },
      onDone(reason) { setResults((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, status: reason === 'length' ? 'Truncated' : 'Complete', latency: Math.round(performance.now() - started) } : item)); },
      onError(message) { setResults((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, status: 'Failed', error: message, latency: Math.round(performance.now() - started) } : item)); },
    });
  }
  async function run() {
    if (!prompt.trim()) return setError('Enter a prompt first');
    if (compare && primary === secondary) return setError('Choose two different routes to compare');
    setError(''); setRunning(true);
    try { await Promise.all([runOne(primary, 0), ...(compare ? [runOne(secondary, 1)] : [])]); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Model test failed'); }
    finally { setRunning(false); }
  }

  return <div className="space-y-5">{error && <Alert variant="destructive">{error}</Alert>}{options.length === 0 ? <Empty title="No testable models" description="Connect a provider and sync its models before using Playground." action={<Button asChild><Link href="/settings/ai/providers">Connect provider</Link></Button>} /> : <><Card className="gap-4 p-5"><div className="flex items-center justify-between gap-4"><div><h3 className="font-semibold">Targets</h3><p className="mt-1 text-sm text-muted-foreground">Choose exact provider accounts in the same order as Models. Search names, creators, providers, aliases, or routes.</p></div><div className="flex items-center gap-2"><Label htmlFor="ai-compare">Compare</Label><Switch id="ai-compare" checked={compare} onCheckedChange={setCompare} disabled={running} /></div></div><div className={`grid gap-3 ${compare ? 'md:grid-cols-2' : ''}`}><AIModelPicker label={compare ? 'Target A' : 'Target'} value={primary} onChange={setPrimary} options={options} disabled={running} />{compare && <AIModelPicker label="Target B" value={secondary} onChange={setSecondary} options={options} disabled={running} />}</div><div className="space-y-2"><Label htmlFor="ai-playground-prompt">Prompt</Label><textarea id="ai-playground-prompt" className="min-h-32 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={running} /></div><div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div className="space-y-2"><Label htmlFor="ai-max-tokens">Max output tokens</Label><Input id="ai-max-tokens" className="w-40" type="number" min={1} max={4096} value={maxTokens} onChange={(event) => setMaxTokens(Number(event.target.value))} /></div><Button disabled={running || !primary || (compare && !secondary)} onClick={() => void run()}>{running ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}{running ? 'Running' : compare ? 'Run comparison' : 'Run test'}</Button></div></Card><div className={`grid gap-4 ${compare ? 'lg:grid-cols-2' : ''}`}>{results.slice(0, compare ? 2 : 1).map((result, index) => <Card key={index} className="gap-4 p-5" aria-live="polite"><div className="flex items-center justify-between"><h3 className="font-semibold">{compare ? `Target ${index ? 'B' : 'A'}` : 'Output'}</h3><Badge variant={result.status === 'Failed' ? 'destructive' : 'secondary'}>{result.status}</Badge></div>{result.error && <Alert variant="destructive">{result.error}</Alert>}<pre className="min-h-44 whitespace-pre-wrap rounded-md bg-muted/50 p-4 font-sans text-sm leading-6">{result.output || 'Output will stream here.'}</pre><p className="text-xs text-muted-foreground">Latency: {result.latency == null ? 'Unknown' : `${result.latency} ms`}</p></Card>)}</div></>}</div>;
}

function Choice({ label, value, onChange, items }: { label: string; value: string; onChange: (value: string) => void; items: Array<{ value: string; label: string }> }) {
  return <div className="space-y-2"><Label>{label}</Label><Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} className="bg-background"><SelectValue placeholder={label} /></SelectTrigger><SelectContent>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div>;
}
