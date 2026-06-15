/**
 * Timeline Entry Card — Plan 1 Workstream E2.
 *
 * An entry is now an embeds-first row that matches `timeline.html`:
 *   1. a `.via` attribution row rendered by the UI **outside** the embed
 *      (18px app chip + app name + clock time, delete on hover) — this is the
 *      anti-impersonation guarantee: the app can never forge its own attribution.
 *   2. the body — the source app's own card via <TimelineEmbed kind="timeline-card">
 *      (app-declared height), or a legacy info-card fetch, or the StandardCard
 *      fallback for plain / uninstalled-app entries.
 *
 * The old chrome (bordered card, collection badge, expand-raw-JSON, in-row title)
 * is gone — the day-group header gives the date, the embed owns the content, and
 * the full record stays one click away in the detail view.
 */

"use client";

import {
  Film,
  Camera,
  FileText,
  Music,
  Globe,
  Calendar,
  Star,
  Package,
  Search,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { TimelineEmbed, type AppMetaEntry } from "./timeline-embed";
import { TimelineInfoCard } from "./timeline-info-card";
import { resolveLucideIcon } from "@/lib/timeline/icon-map";

interface TimelineEntry {
  id: string;
  collection: string;
  created_at: string | null;
  entry: {
    app_id: string;
    entry_type: string;
    title: string;
    timestamp: string;
    embed_path?: string;
    tags: Record<string, unknown>;
    data: Record<string, unknown>;
    info_card?: { card_type: string; endpoint: string };
    import_source?: string;
    infoCardUrl?: string;
  };
}

interface TimelineEntryCardProps {
  entry: TimelineEntry;
  /** Base domain for constructing app embed URLs (e.g. "yourdomain.com") */
  domain?: string;
  /** App metadata map: app_id → { icon, accent_color, entry_icons } */
  appMetaMap?: Record<string, AppMetaEntry>;
  onDelete?: (id: string) => void;
  onSelect?: (entry: TimelineEntry) => void;
}

/**
 * Legacy icon map — kept as fallback for entries from before the
 * dynamic manifest system. New apps don't need to be added here;
 * they declare icons in their manifest and get resolved via appMeta.
 */
const LEGACY_TYPE_ICONS: Record<string, typeof Film> = {
  "movie-watched": Film,
  "photo-taken": Camera,
  "note-created": FileText,
  "music-listened": Music,
  "article-read": Globe,
  "search-query-legacy": Search,
  "event-scheduled": Calendar,
  "item-rated": Star,
};

/**
 * Resolve the icon for a timeline entry.
 * Priority: entry-type icon from manifest > app-level icon from manifest > legacy map > Package
 */
function resolveEntryIcon(
  entryType: string,
  appMeta?: AppMetaEntry
): typeof Film {
  if (appMeta?.entry_icons[entryType]) {
    return resolveLucideIcon(appMeta.entry_icons[entryType]);
  }
  if (appMeta?.icon) {
    return resolveLucideIcon(appMeta.icon);
  }
  if (LEGACY_TYPE_ICONS[entryType]) {
    return LEGACY_TYPE_ICONS[entryType];
  }
  return Package;
}

/** Soft-tinted chip style from a hex accent (bg ~12% alpha, fg full) — matches the mockup `.mini`. */
function chipStyle(hex: string | null | undefined): React.CSSProperties | undefined {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { background: `rgba(${r}, ${g}, ${b}, 0.12)`, color: hex };
}

export function TimelineEntryCard({
  entry,
  domain,
  appMetaMap,
  onDelete,
  onSelect,
}: TimelineEntryCardProps) {
  const t = useTranslations("timeline");

  const appMeta = appMetaMap?.[entry.entry.app_id];
  const Icon = resolveEntryIcon(entry.entry.entry_type, appMeta);

  const appSlug = entry.entry.app_id.replace(/^ye-/, "");
  const appName = appSlug.charAt(0).toUpperCase() + appSlug.slice(1);
  const chip = chipStyle(appMeta?.accent_color);

  // Day-grouped feed gives the date — the per-entry attribution shows the clock time.
  const clockTime = new Date(entry.entry.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  // Body selection:
  //  1. embed_path → the app's own card (iframe) with StandardCard fallback
  //  2. legacy info-card URL → fetched info card
  //  3. neither → StandardCard (TimelineEmbed renders it when embed_path is absent)
  const hasEmbedPath = !!entry.entry.embed_path;
  const legacyInfoCardUrl = !hasEmbedPath
    ? (entry.entry.infoCardUrl ??
      entry.entry.info_card?.endpoint ??
      (entry.entry.data.infoCardUrl as string | undefined) ??
      null)
    : null;

  return (
    <div className="group grid gap-1.5">
      {/* Attribution row (.via) — UI-rendered, outside the embed (anti-impersonation) */}
      <div className="flex items-center gap-[7px] pl-0.5 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => onSelect?.(entry)}
          className="flex items-center gap-[7px] rounded transition-colors hover:text-foreground"
          title={t("backToTimeline")}
        >
          <span
            className="grid h-[18px] w-[18px] place-items-center rounded-[5px] bg-accent text-muted-foreground"
            style={chip}
          >
            <Icon className="h-[11px] w-[11px]" />
          </span>
          <span className="font-medium text-foreground/90">{appName}</span>
        </button>

        {entry.entry.import_source && (
          <span>· {t("via", { source: entry.entry.import_source })}</span>
        )}

        <time className="ml-auto tabular-nums">{clockTime}</time>

        {onDelete && (
          <button
            type="button"
            onClick={() => onDelete(entry.id)}
            className="rounded p-0.5 opacity-0 transition-opacity hover:text-red-500 focus:opacity-100 group-hover:opacity-100"
            title={t("deleteEntry")}
            aria-label={t("deleteEntry")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Body — the embed (app-native), legacy info card, or StandardCard fallback */}
      {hasEmbedPath ? (
        <TimelineEmbed entry={entry.entry} domain={domain ?? ""} appMeta={appMeta} />
      ) : legacyInfoCardUrl ? (
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelect?.(entry)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") onSelect?.(entry);
          }}
          className="cursor-pointer"
        >
          <TimelineInfoCard infoCardUrl={legacyInfoCardUrl} size="compact" />
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelect?.(entry)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") onSelect?.(entry);
          }}
          className="cursor-pointer"
        >
          <TimelineEmbed entry={entry.entry} domain={domain ?? ""} appMeta={appMeta} />
        </div>
      )}
    </div>
  );
}
