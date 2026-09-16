'use client';

import { useEffect, useState } from 'react';
import { Database, HardDrive, Loader2, Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { PageHeader } from './page-header';

type Health = { status: string; version: string | null; database: string; backup: string };

export function AISystemClient() {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => { fetch('/api/ai-system', { cache: 'no-store' }).then(async (response) => setHealth(await response.json())).catch(() => setHealth({ status: 'unavailable', version: null, database: 'unknown', backup: 'included_in_core_backup' })); }, []);
  if (!health) return <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin" /></div>;
  const rows = [
    { icon: Sparkles, label: 'AI service', value: health.status, detail: health.version ? `Version ${health.version}` : 'Version unavailable' },
    { icon: Database, label: 'Database', value: health.database, detail: 'Dedicated Pointer database' },
    { icon: HardDrive, label: 'Backup', value: 'included', detail: 'Included in core backup and restore' },
  ];
  return <div><PageHeader title="System · AI" description="Aggregate service health only. Personal accounts, credentials, routes, usage, prompts, and responses are never shown here." /><div className="grid gap-3">{rows.map(({ icon: Icon, label, value, detail }) => <Card key={label} className="flex items-center justify-between p-4"><div className="flex items-center gap-3"><Icon className="size-5 text-primary" /><div><strong className="text-sm">{label}</strong><p className="text-xs text-muted-foreground">{detail}</p></div></div><span className="flex items-center gap-2 text-sm capitalize"><span className={`size-2 rounded-full ${value === 'ready' || value === 'current' || value === 'included' ? 'bg-green-500' : 'bg-amber-500'}`} />{value.replaceAll('_', ' ')}</span></Card>)}</div></div>;
}
