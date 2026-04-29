/**
 * Timeline Entry Card
 *
 * Renders a single decrypted timeline entry with type icon,
 * title, tags, timestamp, and either:
 *   - An iframe embed from the source app (via embed_path)
 *   - A standard card from stored data (fallback)
 *   - A legacy info card fetch (backward compat)
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
  Trash2,
  ChevronDown,
  ChevronUp,
  Search,
  MapPin,
  BookOpen,
  Eye,
  Heart,
  ListPlus,
  Play,
} from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { TimelineEmbed } from "./timeline-embed";
import { TimelineInfoCard } from "./timeline-info-card";

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
  /** Base domain for constructing app embed URLs (e.g. "devvm.test") */
  domain?: string;
  onDelete?: (id: string) => void;
  onSelect?: (entry: TimelineEntry) => void;
}

const TYPE_ICONS: Record<string, typeof Film> = {
  // Cinema
  "cinema-movie-viewed": Eye,
  "cinema-tv-viewed": Eye,
  "cinema-movie-watched": Play,
  "cinema-tv-watched": Play,
  "cinema-watchlist-add": ListPlus,
  "cinema-status-change": Film,
  "cinema-review": Star,
  "cinema-search": Search,
  "cinema-movie-favorited": Heart,
  // Search
  "search-query": Search,
  "search-link-clicked": Globe,
  // Wiki
  "wiki-article-read": BookOpen,
  "wiki-article-edit": FileText,
  // Generic
  "movie-watched": Film,
  "photo-taken": Camera,
  "note-created": FileText,
  "music-listened": Music,
  "article-read": Globe,
  "search-query-legacy": Search,
  "event-scheduled": Calendar,
  "item-rated": Star,
};

const COLLECTION_COLORS: Record<string, string> = {
  history: "border-l-blue-500",
  future: "border-l-amber-500",
  imported: "border-l-emerald-500",
};

export function TimelineEntryCard({
  entry,
  domain,
  onDelete,
  onSelect,
}: TimelineEntryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const t = useTranslations("timeline");

  const COLLECTION_LABELS: Record<string, string> = {
    history: t("history"),
    future: t("upcoming"),
    imported: t("imported"),
  };

  const Icon = TYPE_ICONS[entry.entry.entry_type] ?? Package;

  const borderColor =
    COLLECTION_COLORS[entry.collection] ?? "border-l-gray-500";

  const formatTimestamp = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffDays === 0) {
      return t("today", {
        time: d.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      });
    }
    if (diffDays === 1) return t("yesterday");
    if (diffDays < 7) return t("daysAgo", { count: diffDays });
    return d.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  };

  const tags = Object.entries(entry.entry.tags).filter(
    ([, v]) => v !== null && v !== undefined
  );

  // Determine which card rendering to use:
  // 1. embed_path → TimelineEmbed (iframe with fallback)
  // 2. Legacy infoCardUrl → TimelineInfoCard (data fetch)
  // 3. Neither → no card, just text entry
  const hasEmbedPath = !!entry.entry.embed_path;
  const legacyInfoCardUrl = !hasEmbedPath
    ? (entry.entry.infoCardUrl ??
      entry.entry.info_card?.endpoint ??
      (entry.entry.data.infoCardUrl as string | undefined) ??
      null)
    : null;

  return (
    <div
      className={`border-l-4 ${borderColor} bg-card rounded-lg border shadow-sm hover:shadow-md transition-shadow`}
    >
      <div className="flex items-start gap-3 p-4">
        {/* Icon */}
        <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-accent flex items-center justify-center">
          <Icon className="w-5 h-5 text-muted-foreground" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3
                className="font-medium text-sm cursor-pointer hover:text-primary transition-colors"
                onClick={() => onSelect?.(entry)}
              >
                {entry.entry.title}
              </h3>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-muted-foreground">
                  {formatTimestamp(entry.entry.timestamp)}
                </span>
                <span className="text-xs text-muted-foreground">
                  &middot;
                </span>
                <span className="text-xs text-muted-foreground capitalize">
                  {entry.entry.app_id.replace(/^ye-/, "")}
                </span>
                {entry.entry.import_source && (
                  <>
                    <span className="text-xs text-muted-foreground">
                      &middot;
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t("via", { source: entry.entry.import_source })}
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-1">
              {/* Collection badge */}
              <span className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                {COLLECTION_LABELS[entry.collection] ?? entry.collection}
              </span>

              {/* Expand/collapse */}
              <button
                onClick={() => setExpanded(!expanded)}
                className="p-1 rounded hover:bg-accent transition-colors"
              >
                {expanded ? (
                  <ChevronUp className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                )}
              </button>

              {/* Delete */}
              {onDelete && (
                <button
                  onClick={() => onDelete(entry.id)}
                  className="p-1 rounded hover:bg-red-500/10 transition-colors"
                >
                  <Trash2 className="w-4 h-4 text-muted-foreground hover:text-red-500" />
                </button>
              )}
            </div>
          </div>

          {/* Tags */}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {tags.map(([key, value]) => (
                <span
                  key={key}
                  className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] bg-accent text-muted-foreground"
                >
                  {key}: {String(value)}
                </span>
              ))}
            </div>
          )}

          {/* Embed card (new system — iframe with fallback) */}
          {hasEmbedPath && domain && (
            <div className="mt-3">
              <TimelineEmbed entry={entry.entry} domain={domain} />
            </div>
          )}

          {/* Embed card fallback when no domain provided (standard card only) */}
          {hasEmbedPath && !domain && (
            <div className="mt-3">
              <TimelineEmbed entry={entry.entry} domain="" />
            </div>
          )}

          {/* Legacy info card (for entries created before embed_path) */}
          {legacyInfoCardUrl && (
            <div className="mt-3">
              <TimelineInfoCard infoCardUrl={legacyInfoCardUrl} size="compact" />
            </div>
          )}

          {/* Expanded data */}
          {expanded && Object.keys(entry.entry.data).length > 0 && (
            <div className="mt-3 p-3 bg-muted rounded-md">
              <pre className="text-xs text-muted-foreground overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(entry.entry.data, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
