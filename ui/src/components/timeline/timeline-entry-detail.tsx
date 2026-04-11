/**
 * Timeline Entry Detail View
 *
 * Shows full details of a single timeline entry,
 * including a full-size info card with "Open in app" action.
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
  ArrowLeft,
  ExternalLink,
  Search,
} from "lucide-react";
import { useTranslations } from "next-intl";
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
    tags: Record<string, unknown>;
    data: Record<string, unknown>;
    info_card?: { card_type: string; endpoint: string };
    import_source?: string;
    infoCardUrl?: string;
  };
}

interface TimelineEntryDetailProps {
  entry: TimelineEntry;
  onBack: () => void;
}

const TYPE_ICONS: Record<string, typeof Film> = {
  "movie-watched": Film,
  "photo-taken": Camera,
  "note-created": FileText,
  "music-listened": Music,
  "article-read": Globe,
  "wiki-article-read": Globe,
  "wiki-article-edit": FileText,
  "search-query": Search,
  "event-scheduled": Calendar,
  "item-rated": Star,
};

const APP_NAMES: Record<string, string> = {
  "ye-wiki": "Wiki",
  "ye-search": "Search",
  "ye-notes": "Notes",
  "ye-photos": "Photos",
  system: "System",
};

export function TimelineEntryDetail({
  entry,
  onBack,
}: TimelineEntryDetailProps) {
  const t = useTranslations("timeline");
  const Icon = TYPE_ICONS[entry.entry.entry_type] ?? Package;

  const infoCardUrl =
    entry.entry.infoCardUrl ??
    entry.entry.info_card?.endpoint ??
    (entry.entry.data.infoCardUrl as string | undefined) ??
    null;

  const appName = APP_NAMES[entry.entry.app_id] ?? entry.entry.app_id;
  const actionUrl = entry.entry.data.actionUrl as string | undefined;

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString([], {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const tags = Object.entries(entry.entry.tags).filter(
    ([, v]) => v !== null && v !== undefined
  );

  return (
    <div className="space-y-6">
      {/* Back button */}
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        {t("backToTimeline") ?? "Back to timeline"}
      </button>

      {/* Full-size Info Card */}
      {infoCardUrl && (
        <div className="rounded-xl border bg-card p-1">
          <TimelineInfoCard
            infoCardUrl={infoCardUrl}
            size="expanded"
          />
        </div>
      )}

      {/* Entry Header */}
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-accent flex items-center justify-center">
          <Icon className="w-6 h-6 text-muted-foreground" />
        </div>
        <div className="flex-1">
          <h2 className="text-xl font-semibold">{entry.entry.title}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {formatDate(entry.entry.timestamp)}
          </p>
          <div className="flex items-center gap-2 mt-2">
            <span className="text-xs bg-accent px-2 py-0.5 rounded-full">
              {appName}
            </span>
            <span className="text-xs bg-muted px-2 py-0.5 rounded-full uppercase tracking-wider">
              {entry.collection}
            </span>
            <span className="text-xs text-muted-foreground">
              {entry.entry.entry_type}
            </span>
          </div>
        </div>
      </div>

      {/* Action button */}
      {actionUrl && (
        <a
          href={actionUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <ExternalLink className="h-4 w-4" />
          Open in {appName}
        </a>
      )}

      {/* Tags */}
      {tags.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2">{t("tags") ?? "Tags"}</h3>
          <div className="flex flex-wrap gap-1.5">
            {tags.map(([key, value]) => (
              <span
                key={key}
                className="inline-flex items-center px-2.5 py-1 rounded-full text-xs bg-accent text-muted-foreground"
              >
                <span className="font-medium">{key}:</span>&nbsp;
                {String(value)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Raw Data */}
      {Object.keys(entry.entry.data).length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2">
            {t("rawData") ?? "Entry Data"}
          </h3>
          <div className="p-4 bg-muted rounded-lg">
            <pre className="text-xs text-muted-foreground overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(entry.entry.data, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* Import info */}
      {entry.entry.import_source && (
        <div className="text-xs text-muted-foreground">
          {t("via", { source: entry.entry.import_source })}
        </div>
      )}
    </div>
  );
}
