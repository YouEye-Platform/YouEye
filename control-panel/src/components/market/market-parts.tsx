'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import * as LucideIcons from 'lucide-react';
import { Package, type LucideIcon } from 'lucide-react';
import { useTranslations as useInterfaceTranslations } from 'next-intl';
import type { MarketApp, MarketCategory } from '@/lib/market/types';
import { installBlockedLabel } from '@/components/market/update-blocked';

// Category labels, icons, order and tile colours come from the catalog's `categories:` (data), not from code.
export const DEFAULT_TILE = { bg: '#f4f4f5', fg: '#52525b' };

export function prettify(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1).replace(/[-_]/g, ' ');
}

export function lucideByName(name?: string): LucideIcon {
  if (!name) return Package;
  const map = LucideIcons as unknown as Record<string, LucideIcon>;
  const pascal = name.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  return map[name] || map[pascal] || Package;
}

/** Looks up a category's label, tile colours, icon and order in the catalog's list. */
export function categoryLookup(categories: MarketCategory[]) {
  const index = new Map(categories.map((category) => [category.id, category]));
  const of = (id?: string) => index.get(id || 'other');
  return {
    label: (id?: string) => of(id)?.label ?? prettify(id || 'other'),
    tile: (id?: string) => of(id)?.tile ?? DEFAULT_TILE,
    icon: (id?: string) => of(id)?.icon,
    order: (id?: string) => of(id)?.order ?? Number.MAX_SAFE_INTEGER,
  };
}

export function appHref(app: Pick<MarketApp, 'id' | 'sourceId'>): string {
  return app.sourceId && app.sourceId !== 'official'
    ? `/market/${encodeURIComponent(app.id)}?source=${encodeURIComponent(app.sourceId)}`
    : `/market/${encodeURIComponent(app.id)}`;
}

export function MarketIcon({ app, size = 48, tile }: { app: Pick<MarketApp, 'icon' | 'iconUrl'>; size?: number; tile?: { bg: string; fg: string } }) {
  const radius = Math.round(size * 0.24);
  if (app.iconUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={app.iconUrl} alt="" className="shrink-0 object-contain" style={{ width: size, height: size, borderRadius: radius }} />
    );
  }
  const { bg, fg } = tile || DEFAULT_TILE;
  const Icon = lucideByName(app.icon);
  return (
    <span className="flex shrink-0 items-center justify-center" style={{ width: size, height: size, borderRadius: radius, background: bg, color: fg }} aria-hidden>
      <Icon style={{ width: Math.round(size * 0.46), height: Math.round(size * 0.46) }} />
    </span>
  );
}

/**
 * A picture from a market. The box fetches only a few market pictures at a time and answers the rest "busy" (503)
 * until it has them, so a picture that fails is asked for again a few times, a little later each time; the space
 * stays quiet meanwhile. After that the fallback shows.
 */
export function MarketPicture({ src, alt = '', className, fallback }: { src: string; alt?: string; className?: string; fallback?: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  useEffect(() => { setAttempt(0); setFailed(false); setRetryAt(null); }, [src]);
  useEffect(() => {
    if (retryAt === null) return;
    const timer = setTimeout(() => { setRetryAt(null); setAttempt((n) => n + 1); }, retryAt);
    return () => clearTimeout(timer);
  }, [retryAt]);
  if (failed) return <>{fallback ?? null}</>;
  if (retryAt !== null) return null;
  const url = attempt === 0 ? src : `${src}${src.includes('?') ? '&' : '?'}attempt=${attempt}`;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img key={url} src={url} alt={alt} className={className} loading="lazy" decoding="async"
      onError={() => (attempt >= 5 ? setFailed(true) : setRetryAt(2000 * (attempt + 1)))} />
  );
}

/** The source of an app that is not from the official Market (a custom source, or an app added by address). */
export function SourceTag({ app }: { app: MarketApp }) {
  if (!app.sourceId || app.sourceId === 'official') return null;
  return (
    <span className="shrink-0 truncate rounded border border-amber-500/40 px-1.5 py-px text-[11px] font-medium text-amber-700 dark:text-amber-500">
      {app.sourceName || app.sourceId}
    </span>
  );
}

/**
 * One app as a card: what it looks like at work (its first screenshot) above its icon, name and one line. Only
 * whether it is installed here is shown; its health, updates and access are on its page in Settings → Apps.
 */
export function AppCard({ app, installed, tile, size = 'regular' }: { app: MarketApp; installed: boolean; tile?: { bg: string; fg: string }; size?: 'large' | 'regular' }) {
  const translateInterface = useInterfaceTranslations('interface');
  const blocked = installed ? null : installBlockedLabel(translateInterface, app);
  const shot = app.detail?.screenshots?.[0];
  const noShot = <span className="market-card-noshot" style={{ background: (tile || DEFAULT_TILE).bg }}><MarketIcon app={app} size={size === 'large' ? 72 : 56} tile={tile} /></span>;
  return (
    <Link href={appHref(app)} className={`market-card${size === 'large' ? ' market-card-large' : ''}`}>
      <span className="market-card-shot">
        {shot ? (
          <MarketPicture src={shot.url} fallback={noShot} />
        ) : noShot}
      </span>
      <span className="market-card-text">
        <MarketIcon app={app} size={size === 'large' ? 40 : 32} tile={tile} />
        <span className="min-w-0 flex-1">
          <span className="market-card-name">
            <span className="truncate">{app.name}</span>
            <SourceTag app={app} />
            {installed && <span className="market-card-state">{translateInterface('mf8b32f4e92bd')}</span>}
          </span>
          <span className="market-card-line">{blocked ?? (app.tagline || app.description)}</span>
        </span>
      </span>
    </Link>
  );
}

/**
 * One app in a list: icon, name, one line about it, and only whether it is installed here (its health, updates and
 * access are on its page in Settings → Apps).
 */
export function AppTile({ app, installed, tile, detail }: { app: MarketApp; installed: boolean; tile?: { bg: string; fg: string }; detail?: string }) {
  const translateInterface = useInterfaceTranslations('interface');
  const blocked = installed ? null : installBlockedLabel(translateInterface, app);
  return (
    <Link href={appHref(app)} className="market-tile">
      <MarketIcon app={app} size={48} tile={tile} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-foreground">{app.name}</span>
          <SourceTag app={app} />
        </span>
        <span className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-muted-foreground">{app.tagline || app.description}</span>
        {(installed || blocked || detail) && (
          <span className={`mt-1 block truncate text-[12px] font-medium ${blocked ? 'text-amber-700 dark:text-amber-500' : 'text-muted-foreground'}`}>
            {installed ? translateInterface('mf8b32f4e92bd') : blocked ?? detail}
          </span>
        )}
      </span>
    </Link>
  );
}
