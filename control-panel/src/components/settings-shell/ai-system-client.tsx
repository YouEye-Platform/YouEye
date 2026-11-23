'use client';

import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useEffect, useState } from 'react';
import { Database, HardDrive, Loader2, Sparkles } from 'lucide-react';
import { PageHeader } from './page-header';

type Health = { status: string; version: string | null; database: string; backup: string };

const GOOD = new Set(['ready', 'current', 'included']);
const KNOWN = new Set(['ready', 'degraded', 'unhealthy', 'unavailable', 'current', 'check_failed', 'unknown', 'included']);

/** System → AI service: whether the shared AI service runs, its database and its place in backups. */
export function AISystemClient() {
  const translateInterface = useInterfaceTranslations("interface");
  const t = useInterfaceTranslations("settingsSystem");

  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => { fetch('/settings/api/ai-system', { cache: 'no-store' }).then(async (response) => setHealth(await response.json())).catch(() => setHealth({ status: 'unavailable', version: null, database: 'unknown', backup: 'included_in_core_backup' })); }, []);

  const rows = health ? [
    { icon: Sparkles, label: t("ai.service"), value: health.status, detail: health.version ? translateInterface("ma18745121bb8", { version: health.version }) : translateInterface("mc0a7f647c17d") },
    { icon: Database, label: translateInterface("mfa7fe67124e9"), value: health.database, detail: t("ai.databaseDetail") },
    { icon: HardDrive, label: translateInterface("m838557924a5c"), value: 'included', detail: translateInterface("m846da0c207d2") },
  ] : [];

  return (
    <div>
      <PageHeader title={translateInterface("mb535945fa809")} description={t("ai.description")} />
      {!health ? (
        <div className="flex justify-center py-16" role="status"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <ul className="settings-group">
          {rows.map(({ icon: Icon, label, value, detail }) => (
            <li key={label} className="flex min-h-[3.75rem] items-center gap-3.5 px-4 py-2.5 text-[15px] leading-[1.35]">
              <span className="settings-row-icon" aria-hidden="true"><Icon className="size-[18px]" /></span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-foreground">{label}</span>
                <span className="block text-[13px] tabular-nums text-muted-foreground">{detail}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-muted-foreground">
                <span className={`size-2 shrink-0 rounded-full ${GOOD.has(value) ? 'bg-green-500' : 'bg-amber-500'}`} aria-hidden="true" />
                {KNOWN.has(value) ? t(`ai.values.${value}`) : value.replaceAll('_', ' ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
