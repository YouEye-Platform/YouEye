'use client';

import { useTranslations as useInterfaceTranslations } from "next-intl";
import { ExternalLink } from 'lucide-react';

/** What `POST /api/market/add/preview?market=…` says about a market (nothing is added by reading it). */
export interface MarketPreviewData {
  kind: 'market';
  address: string;
  /** The market's own words: plain text, never the box's name for it. */
  name: string;
  publisher: string;
  /** Only an https address. */
  homepage?: string;
  /** Its apps (the count `youeye market list` shows), native ones included; `native` says how many are native apps (YE-142). */
  apps: number;
  apps_with_setup: number;
  /** How many of its apps are native apps (they join the dashboard; any market may offer them, YE-142). */
  native?: number;
  /** The id of the source this box already has for this address, or null. */
  already_added: string | null;
}

/** A market's own name and publisher, marked as its own words, and what it holds. */
export function MarketPreview({ preview }: { preview: MarketPreviewData }) {
  const translateInterface = useInterfaceTranslations("interface");
  return (
    <div className="space-y-2 rounded-lg border bg-card p-3 text-[13px]">
      <p className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">{translateInterface("mfee8a979d12a")}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">{translateInterface("mdcd1d5223f73")}</dt>
        <dd className="break-words font-medium text-foreground">{preview.name}</dd>
        <dt className="text-muted-foreground">{translateInterface("m21378545892f")}</dt>
        <dd className="break-words font-medium text-foreground">{preview.publisher}</dd>
        {preview.homepage && (
          <>
            <dt className="text-muted-foreground">{translateInterface("m9e3391e9bf07")}</dt>
            <dd className="min-w-0">
              <a href={preview.homepage} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex max-w-full items-center gap-1 text-primary hover:underline">
                <span className="truncate">{preview.homepage}</span><ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            </dd>
          </>
        )}
      </dl>
      <p className="text-foreground">
        {translateInterface("m71287f6e69e3", { count: preview.apps })}{" · "}
        {translateInterface("m9bf2d11af31a", { count: preview.apps_with_setup })}
      </p>
    </div>
  );
}
