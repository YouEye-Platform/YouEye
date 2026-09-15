'use client';

import Link from 'next/link';
import { Activity, Bot, Box, ChartNoAxesCombined, Layers3, Loader2, Play, Server, Sparkles, WalletCards } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { PageHeader } from './page-header';
import type { AISection, RecentUsage, Stats } from './ai-types';

const sections: Array<{ id: AISection; label: string; href: string; icon: typeof Sparkles }> = [
  { id: 'models', label: 'Models', href: '/settings/ai', icon: Bot },
  { id: 'groups', label: 'Groups', href: '/settings/ai/groups', icon: Layers3 },
  { id: 'instances', label: 'Instances', href: '/settings/ai/instances', icon: Server },
  { id: 'providers', label: 'Providers', href: '/settings/ai/providers', icon: WalletCards },
  { id: 'usage', label: 'Usage', href: '/settings/ai/usage', icon: ChartNoAxesCombined },
  { id: 'playground', label: 'Playground', href: '/settings/ai/playground', icon: Play },
];

export function AIShell({ section, children }: { section: AISection; children: React.ReactNode }) {
  return <div className="space-y-6">
    <PageHeader title="AI" description="Connect accounts, choose models for applications, monitor usage, and test your routes." />
    <nav className="flex gap-1 overflow-x-auto rounded-lg border bg-muted/40 p-1" aria-label="AI settings">
      {sections.map(({ id, label, href, icon: Icon }) => {
        const selected = id === section;
        return <Button key={id} asChild variant={selected ? 'default' : 'ghost'} size="sm" className="shrink-0">
          <Link href={href} aria-current={selected ? 'page' : undefined}><Icon className="size-4" />{label}</Link>
        </Button>;
      })}
    </nav>
    <div data-ai-section={section}>{children}</div>
  </div>;
}

export function Status({ value, label }: { value: string | boolean; label?: string }) {
  const ready = value === true || value === 'active' || value === 'ready' || value === 'success';
  const warning = value === 'disabled' || value === 'unavailable' || value === false;
  return <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
    <span className={cn('size-2 rounded-full', ready ? 'bg-emerald-500' : warning ? 'bg-amber-500' : 'bg-destructive')} />
    {label || (ready ? 'Ready' : String(value).replaceAll('_', ' '))}
  </span>;
}

export function Loading() {
  return <div className="flex justify-center py-20" role="status"><Loader2 className="size-5 animate-spin text-muted-foreground" /><span className="sr-only">Loading</span></div>;
}

export function Empty({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <Card className="items-center gap-3 p-8 text-center">
    <Box className="size-8 text-muted-foreground/70" />
    <div><h2 className="font-semibold">{title}</h2><p className="mt-1 max-w-lg text-sm text-muted-foreground">{description}</p></div>
    {action}
  </Card>;
}

export function MetricCards({ stats }: { stats: Stats }) {
  const metrics = [
    { label: 'Requests', value: stats.totals.requests.toLocaleString(), detail: `${stats.sample.confidence} confidence`, icon: Activity },
    { label: 'Success', value: stats.totals.successRate == null ? 'No data' : `${stats.totals.successRate.toFixed(1)}%`, detail: `${stats.totals.errors} errors`, icon: Sparkles },
    { label: 'Tokens', value: (stats.totals.inputTokens + stats.totals.outputTokens).toLocaleString(), detail: `${stats.totals.cachedTokens.toLocaleString()} cached`, icon: Bot },
    { label: 'Cost', value: stats.totals.totalCost == null ? 'Unknown' : `$${stats.totals.totalCost.toFixed(4)}`, detail: `${stats.totals.knownCostSamples} priced requests`, icon: ChartNoAxesCombined },
    { label: 'Latency p50', value: stats.latency.p50 == null ? 'Unknown' : `${Math.round(stats.latency.p50)} ms`, detail: `p95 ${stats.latency.p95 == null ? 'unknown' : `${Math.round(stats.latency.p95)} ms`}`, icon: Activity },
  ];
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
    {metrics.map(({ label, value, detail, icon: Icon }) => <Card key={label} className="gap-3 p-4">
      <div className="flex items-center justify-between"><span className="text-xs font-medium text-muted-foreground">{label}</span><Icon className="size-4 text-primary" /></div>
      <strong className="text-xl tracking-tight">{value}</strong><span className="text-xs text-muted-foreground">{detail}</span>
    </Card>)}
  </div>;
}

export function RecentUsageTable({ rows }: { rows: RecentUsage[] }) {
  if (!rows.length) return <Empty title="No requests yet" description="Requests made through instance API keys and Playground tests will appear here." />;
  return <Card className="block overflow-hidden p-0"><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm">
    <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-3 font-medium">Model</th><th className="px-4 py-3 font-medium">Provider</th><th className="px-4 py-3 font-medium">Source</th><th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3 font-medium">Tokens</th><th className="px-4 py-3 font-medium">Latency</th><th className="px-4 py-3 font-medium">When</th></tr></thead>
    <tbody className="divide-y">{rows.map((row) => <tr key={row.id} className="align-top hover:bg-muted/30"><td className="px-4 py-3 font-medium">{row.modelId}</td><td className="px-4 py-3 text-muted-foreground">{row.providerId}</td><td className="px-4 py-3"><Badge variant="secondary">{row.source}</Badge></td><td className="px-4 py-3"><Status value={row.outcome} /></td><td className="px-4 py-3 tabular-nums text-muted-foreground">{(row.inputTokens ?? 0).toLocaleString()} / {(row.outputTokens ?? 0).toLocaleString()}</td><td className="px-4 py-3 tabular-nums text-muted-foreground">{row.latencyMs == null ? '—' : `${row.latencyMs} ms`}</td><td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{new Date(row.createdAt).toLocaleString()}</td></tr>)}</tbody>
  </table></div></Card>;
}
