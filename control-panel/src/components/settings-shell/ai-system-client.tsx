'use client';

import { useTranslations as useInterfaceTranslations } from "next-intl";


import { useEffect, useState } from 'react';
import { Database, HardDrive, Loader2, Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { PageHeader } from './page-header';

type Health = { status: string; version: string | null; database: string; backup: string };

export function AISystemClient() {
  const translateInterface = useInterfaceTranslations("interface");

  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => { fetch('/settings/api/ai-system', { cache: 'no-store' }).then(async (response) => setHealth(await response.json())).catch(() => setHealth({ status: 'unavailable', version: null, database: 'unknown', backup: 'included_in_core_backup' })); }, []);
  if (!health) return <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin" /></div>;
  const rows = [
    { icon: Sparkles, label: translateInterface("mb535945fa809"), value: health.status, detail: health.version ? translateInterface("ma18745121bb8", {version: health.version}) : translateInterface("mc0a7f647c17d") },
    { icon: Database, label: translateInterface("mfa7fe67124e9"), value: health.database, detail: translateInterface("mf4ba2d238482") },
    { icon: HardDrive, label: translateInterface("m838557924a5c"), value: 'included', detail: translateInterface("m846da0c207d2") },
  ];
  return <div><PageHeader title={translateInterface("m585ada11b355")} description={translateInterface("m993f954e03c2")} /><div className="grid gap-3">{rows.map(({ icon: Icon, label, value, detail }) => <Card key={label} className="flex items-center justify-between p-4"><div className="flex items-center gap-3"><Icon className="size-5 text-primary" /><div><strong className="text-sm">{label}</strong><p className="text-xs text-muted-foreground">{detail}</p></div></div><span className="flex items-center gap-2 text-sm capitalize"><span className={`size-2 rounded-full ${value === 'ready' || value === 'current' || value === 'included' ? 'bg-green-500' : 'bg-amber-500'}`} />{value.replaceAll('_', ' ')}</span></Card>)}</div></div>;
}
