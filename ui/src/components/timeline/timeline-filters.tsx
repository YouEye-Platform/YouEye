/**
 * Timeline Filters
 *
 * Filter bar for timeline entries: collection tabs, date range, app filter.
 */

"use client";

import { Search, Calendar, Filter, Lock, Unlock } from "lucide-react";
import { useTranslations } from "next-intl";

interface TimelineFiltersProps {
  collection: string;
  onCollectionChange: (c: string) => void;
  search: string;
  onSearchChange: (s: string) => void;
  from: string;
  onFromChange: (d: string) => void;
  to: string;
  onToChange: (d: string) => void;
  counts: { history: number; future: number; imported: number };
  sessionActive: boolean;
  onLock: () => void;
}

export function TimelineFilters({
  collection,
  onCollectionChange,
  search,
  onSearchChange,
  from,
  onFromChange,
  to,
  onToChange,
  counts,
  sessionActive,
  onLock,
}: TimelineFiltersProps) {
  const t = useTranslations('timeline');
  const totalCount = counts.history + counts.future + counts.imported;

  const COLLECTIONS = [
    { id: "all", label: t('all') },
    { id: "history", label: t('history') },
    { id: "future", label: t('upcoming') },
    { id: "imported", label: t('imported') },
  ];

  return (
    <div className="space-y-3">
      {/* Collection tabs */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1 bg-muted rounded-lg p-1">
          {COLLECTIONS.map((c) => {
            const count =
              c.id === "all"
                ? totalCount
                : counts[c.id as keyof typeof counts] ?? 0;
            return (
              <button
                key={c.id}
                onClick={() => onCollectionChange(c.id)}
                className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                  collection === c.id
                    ? "bg-background text-foreground shadow-sm font-medium"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {c.label}
                {count > 0 && (
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Lock button */}
        {sessionActive && (
          <button
            onClick={onLock}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground rounded-md hover:bg-accent transition-colors"
            title={t('lockTimeline')}
          >
            <Unlock className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Search + date filters */}
      <div className="flex gap-3">
        {/* Search */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t('searchEntries')}
            className="w-full pl-9 pr-4 py-2 text-sm bg-muted rounded-lg border-0 focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* Date range */}
        <div className="flex items-center gap-2">
          <div className="relative">
            <Calendar className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="date"
              value={from}
              onChange={(e) => onFromChange(e.target.value)}
              className="pl-8 pr-2 py-2 text-sm bg-muted rounded-lg border-0 focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <span className="text-sm text-muted-foreground">{t('dateRangeTo')}</span>
          <div className="relative">
            <Calendar className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="date"
              value={to}
              onChange={(e) => onToChange(e.target.value)}
              className="pl-8 pr-2 py-2 text-sm bg-muted rounded-lg border-0 focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
