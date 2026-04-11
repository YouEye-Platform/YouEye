/**
 * Timeline Feed
 *
 * Main timeline component. Handles PIN state, fetching entries,
 * filtering, entry detail view, and rendering the chronological feed.
 * Includes retroactive enrichment for entries without infoCardUrl.
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import { PINPrompt } from "./pin-prompt";
import { TimelineFilters } from "./timeline-filters";
import { TimelineEntryCard } from "./timeline-entry-card";
import { TimelineEntryDetail } from "./timeline-entry-detail";
import { Clock, Plus, Lock, History } from "lucide-react";
import { useTranslations } from "next-intl";
import { deriveInfoCardUrl } from "@/lib/timeline/derive-info-card-url";

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
    original_id?: string;
    original_timestamp?: string;
    infoCardUrl?: string;
  };
}

interface TimelineFeedProps {
  initialPinExists: boolean;
  initialSessionActive: boolean;
}

export function TimelineFeed({
  initialPinExists,
  initialSessionActive,
}: TimelineFeedProps) {
  const [pinExists, setPinExists] = useState(initialPinExists);
  const [sessionActive, setSessionActive] = useState(initialSessionActive);
  const [showPinPrompt, setShowPinPrompt] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<TimelineEntry | null>(
    null
  );
  const t = useTranslations("timeline");
  const tc = useTranslations("common");

  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [counts, setCounts] = useState({
    history: 0,
    future: 0,
    imported: 0,
  });
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // Filters
  const [collection, setCollection] = useState("all");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const limit = 50;

  /**
   * Retroactive enrichment: for entries without infoCardUrl,
   * attempt to derive it from entry metadata.
   */
  const enrichEntries = useCallback(
    (rawEntries: TimelineEntry[]): TimelineEntry[] => {
      // Get the domain from the current page location
      const domain =
        typeof window !== "undefined"
          ? window.location.hostname.replace(/^[^.]+\./, "")
          : "";

      return rawEntries.map((entry) => {
        // Already has an info card URL — skip
        if (
          entry.entry.infoCardUrl ||
          entry.entry.info_card?.endpoint ||
          entry.entry.data.infoCardUrl
        ) {
          return entry;
        }

        // Attempt to derive
        const derived = deriveInfoCardUrl(
          {
            entry_type: entry.entry.entry_type,
            app_id: entry.entry.app_id,
            data: entry.entry.data,
            tags: entry.entry.tags,
          },
          domain
        );

        if (!derived) return entry;

        // Return new entry with enriched data (immutable)
        return {
          ...entry,
          entry: {
            ...entry.entry,
            infoCardUrl: derived,
          },
        };
      });
    },
    []
  );

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (collection !== "all") params.set("collection", collection);
      params.set("limit", String(limit));
      params.set("offset", String(offset));
      if (from) params.set("from", from);
      if (to) params.set("to", to);

      const res = await fetch(`/api/v1/timeline?${params}`);
      if (!res.ok) return;
      const data = await res.json();

      if (data.pin_required) {
        setPinExists(data.pin_exists);
        setSessionActive(false);
        setEntries([]);
        setCounts(data.counts);
        return;
      }

      setSessionActive(true);
      setPinExists(true);
      // Enrich entries with derived info card URLs
      setEntries(enrichEntries(data.entries));
      setTotal(data.total);
      setCounts(data.counts);
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, [collection, offset, from, to, enrichEntries]);

  useEffect(() => {
    if (sessionActive) {
      fetchEntries();
    }
  }, [sessionActive, fetchEntries]);

  // Client-side search filter (on already-decrypted entries)
  const displayEntries = search
    ? entries.filter(
        (e) =>
          e.entry.title.toLowerCase().includes(search.toLowerCase()) ||
          e.entry.app_id.toLowerCase().includes(search.toLowerCase()) ||
          e.entry.entry_type.toLowerCase().includes(search.toLowerCase())
      )
    : entries;

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/v1/timeline/entry/${id}`, {
      method: "DELETE",
    });
    if (res.ok) {
      setEntries((prev) => prev.filter((e) => e.id !== id));
      setTotal((t) => t - 1);
    }
  };

  const handleLock = async () => {
    await fetch("/api/v1/pin/session", { method: "DELETE" });
    setSessionActive(false);
    setEntries([]);
  };

  const handlePinSuccess = () => {
    setShowPinPrompt(false);
    setPinExists(true);
    setSessionActive(true);
  };

  // Show PIN setup or unlock prompt
  if (!sessionActive) {
    return (
      <div className="space-y-6">
        {/* Show prompt inline if needed */}
        {showPinPrompt && (
          <PINPrompt
            mode={pinExists ? "verify" : "create"}
            onSuccess={handlePinSuccess}
            onCancel={() => setShowPinPrompt(false)}
          />
        )}

        {/* Locked state */}
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 rounded-full bg-accent flex items-center justify-center mb-4">
            <Lock className="w-8 h-8 text-muted-foreground" />
          </div>
          <h2 className="text-xl font-semibold mb-2">
            {pinExists ? t("locked") : t("setupEncryption")}
          </h2>
          <p className="text-sm text-muted-foreground max-w-md mb-6">
            {pinExists ? t("lockedDescription") : t("setupDescription")}
          </p>
          <button
            onClick={() => setShowPinPrompt(true)}
            className="px-6 py-2.5 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors"
          >
            {pinExists ? t("unlockTimeline") : t("createPin")}
          </button>
        </div>
      </div>
    );
  }

  // Show entry detail view
  if (selectedEntry) {
    return (
      <TimelineEntryDetail
        entry={selectedEntry}
        onBack={() => setSelectedEntry(null)}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Filters */}
      <TimelineFilters
        collection={collection}
        onCollectionChange={(c) => {
          setCollection(c);
          setOffset(0);
        }}
        search={search}
        onSearchChange={setSearch}
        from={from}
        onFromChange={setFrom}
        to={to}
        onToChange={setTo}
        counts={counts}
        sessionActive={sessionActive}
        onLock={handleLock}
      />

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Entries */}
      {!loading && displayEntries.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-12 h-12 rounded-full bg-accent flex items-center justify-center mb-3">
            <History className="w-6 h-6 text-muted-foreground" />
          </div>
          <h3 className="font-medium text-sm mb-1">{t("noEntries")}</h3>
          <p className="text-xs text-muted-foreground max-w-sm">
            {t("noEntriesDescription")}
          </p>
        </div>
      )}

      {!loading && displayEntries.length > 0 && (
        <div className="space-y-3">
          {displayEntries.map((entry) => (
            <TimelineEntryCard
              key={entry.id}
              entry={entry}
              onDelete={handleDelete}
              onSelect={setSelectedEntry}
            />
          ))}

          {/* Pagination */}
          {total > limit && (
            <div className="flex items-center justify-center gap-3 pt-4">
              <button
                onClick={() => setOffset(Math.max(0, offset - limit))}
                disabled={offset === 0}
                className="px-4 py-2 text-sm rounded-lg border hover:bg-accent disabled:opacity-50 transition-colors"
              >
                {tc("previous")}
              </button>
              <span className="text-sm text-muted-foreground">
                {t("ofTotal", {
                  start: offset + 1,
                  end: Math.min(offset + limit, total),
                  total,
                })}
              </span>
              <button
                onClick={() => setOffset(offset + limit)}
                disabled={offset + limit >= total}
                className="px-4 py-2 text-sm rounded-lg border hover:bg-accent disabled:opacity-50 transition-colors"
              >
                {tc("next")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
