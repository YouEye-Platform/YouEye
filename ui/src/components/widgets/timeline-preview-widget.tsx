/**
 * Timeline Preview Widget
 *
 * Shows the most recent timeline entries on the dashboard.
 * Requires an active PIN session to decrypt entries.
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import { Clock, Lock, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";

interface TimelineItem {
  id: string;
  collection: string;
  title: string;
  entry_type: string;
  timestamp: string;
  tags: string[];
}

interface TimelinePreviewProps {
  settings?: { maxItems?: number; collection?: string };
}

export function TimelinePreviewWidget({ settings }: TimelinePreviewProps) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const t = useTranslations('timelinePreview');

  const maxItems = settings?.maxItems ?? 5;
  const collection = settings?.collection ?? "all";

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(maxItems) });
      if (collection !== "all") params.set("collection", collection);

      const res = await fetch(`/api/v1/timeline?${params}`);
      if (res.status === 403) {
        setLocked(true);
        setItems([]);
      } else if (res.ok) {
        const data = await res.json();
        setItems(data.entries ?? []);
        setLocked(false);
      }
    } catch {
      // Silent fail
    } finally {
      setLoading(false);
    }
  }, [maxItems, collection]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (locked) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <Lock className="w-5 h-5" />
        <span className="text-xs">{t('unlockToView')}</span>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
        <Clock className="w-5 h-5 opacity-50" />
        <span className="text-xs">{t('noEntries')}</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col p-2 overflow-hidden">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t('title')}
        </span>
        <a
          href="/timeline"
          className="text-[10px] text-primary hover:underline flex items-center gap-0.5"
        >
          {t('viewAll')} <ChevronRight className="w-3 h-3" />
        </a>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto">
        {items.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-2 px-2 py-1 rounded-md bg-background/40 hover:bg-background/60 transition-colors"
          >
            <div className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium truncate">{item.title}</div>
              <div className="text-[10px] text-muted-foreground">
                {new Date(item.timestamp).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
