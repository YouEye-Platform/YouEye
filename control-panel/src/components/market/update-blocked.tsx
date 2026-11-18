'use client';

import { useTranslations as useInterfaceTranslations } from "next-intl";
import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import type { MarketApp, UpdateBlocked } from '@/lib/market/types';

type Translate = ReturnType<typeof useInterfaceTranslations>;

/** "Needs YouEye X.Y.Z or newer" for an app this box cannot install; null when it can. */
export function installBlockedLabel(translateInterface: Translate, app: Pick<MarketApp, 'installBlocked' | 'needsYouEye'>): string | null {
  if (!app.installBlocked) return null;
  return app.needsYouEye
    ? translateInterface("m8d16ca227ec5", { version: app.needsYouEye })
    : translateInterface("md2d5f84fb3c6");
}

/** In place of Install: the YouEye the app needs, and where to update YouEye. */
export function InstallBlockedNotice({ app }: { app: Pick<MarketApp, 'installBlocked' | 'needsYouEye'> }) {
  const translateInterface = useInterfaceTranslations("interface");
  const label = installBlockedLabel(translateInterface, app);
  if (!label) return null;
  return (
    <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <p className="text-sm font-semibold text-foreground">{label}</p>
      <p className="mt-1 text-[13px] text-muted-foreground">
        {translateInterface("m678f57b77ec7")}{" "}
        <Link href="/settings/system" className="font-medium text-primary hover:underline">{translateInterface("m3f940108cb1e")}</Link>
      </p>
    </div>
  );
}

/** The sentence for an app that gets no updates, and where the owner can act on it. */
export function useUpdateBlockedText() {
  const translateInterface = useInterfaceTranslations("interface");
  return (blocked: UpdateBlocked, appId: string, options: { onAppPage?: boolean } = {}) => {
    switch (blocked.code) {
      case 'source-unavailable':
        return {
          text: translateInterface("m02ac2729d839"),
          ...(options.onAppPage
            ? { hint: translateInterface("m08597fd4e30c") }
            : { link: { href: `/market/${encodeURIComponent(appId)}`, label: translateInterface("mbc901cdff274") } }),
        };
      case 'source-not-accepted':
        return {
          text: translateInterface("mafdf9b9ddecd"),
          link: { href: '/market/sources', label: translateInterface("m81393d1e2beb") },
        };
      case 'requires-newer-youeye':
        return {
          text: translateInterface("m435f55837d9d"),
          link: { href: '/settings/system', label: translateInterface("m3f940108cb1e") },
        };
      case 'source-changed':
      default:
        // Names both addresses: the API's own words.
        return {
          text: blocked.message,
          ...(options.onAppPage ? {} : { link: { href: `/market/${encodeURIComponent(appId)}`, label: translateInterface("mcbad0bce0886") } }),
        };
    }
  };
}

/** Why an installed app gets no updates, where its update state is shown. */
export function UpdateBlockedNote({ blocked, appId, onAppPage = false, className = '' }: {
  blocked: UpdateBlocked; appId: string; onAppPage?: boolean; className?: string;
}) {
  const describe = useUpdateBlockedText();
  const { text, hint, link } = describe(blocked, appId, { onAppPage }) as { text: string; hint?: string; link?: { href: string; label: string } };
  return (
    <div role="status" className={`flex items-start gap-2 text-[13px] text-amber-700 dark:text-amber-500 ${className}`}>
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <p>
        {text}
        {hint && <>{" "}{hint}</>}
        {link && <>{" "}<Link href={link.href} className="font-medium text-primary hover:underline">{link.label}</Link></>}
      </p>
    </div>
  );
}
