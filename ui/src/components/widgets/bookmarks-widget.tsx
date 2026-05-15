/**
 * Bookmarks Widget
 *
 * Traditional bookmark rows with favicons, organized into named pages.
 * Frosted glass background for dashboard integration.
 */

"use client";

import { useMemo, useState } from "react";
import { Globe } from "lucide-react";
import { cn } from "@/lib/utils";

export interface BookmarkItem {
  id: string;
  url: string;
  title: string;
  icon?: string;
}

export interface BookmarkPage {
  id: string;
  name: string;
  bookmarks: BookmarkItem[];
}

interface BookmarksWidgetProps {
  settings?: {
    pages?: BookmarkPage[];
    activePage?: string;
    showLabels?: boolean;
    iconSize?: "small" | "medium" | "large";
  };
}

function getFaviconUrl(url: string, size: number): string {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}`;
  } catch {
    return "";
  }
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function BookmarksWidget({ settings }: BookmarksWidgetProps) {
  const pages = settings?.pages ?? [];
  const showLabels = settings?.showLabels ?? true;

  const [activePageId, setActivePageId] = useState<string | undefined>(
    () => settings?.activePage ?? pages[0]?.id
  );

  const activePage = useMemo(
    () => pages.find((p) => p.id === activePageId) ?? pages[0],
    [pages, activePageId]
  );

  if (pages.length === 0 || !activePage) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl bg-card/50 backdrop-blur-md border border-border/20 p-3">
        <div className="text-center text-muted-foreground/50">
          <Globe className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-xs">No bookmarks yet</p>
          <p className="text-[10px] opacity-60 mt-0.5">Open settings to add some</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full rounded-xl bg-card/50 backdrop-blur-md border border-border/20 p-3 gap-2">
      {/* Page tabs */}
      {pages.length > 1 && (
        <div className="flex gap-1 overflow-x-auto shrink-0">
          {pages.map((page) => (
            <button
              key={page.id}
              onClick={() => setActivePageId(page.id)}
              className={cn(
                "px-2.5 py-0.5 rounded-md text-xs whitespace-nowrap transition-colors",
                page.id === activePage?.id
                  ? "bg-primary/15 text-primary font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              )}
            >
              {page.name}
            </button>
          ))}
        </div>
      )}

      {/* Bookmark rows */}
      <div className="flex-1 overflow-auto space-y-0.5">
        {activePage.bookmarks.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground/40 text-xs">
            No bookmarks on this page
          </div>
        ) : (
          activePage.bookmarks.map((bookmark) => (
            <a
              key={bookmark.id}
              href={bookmark.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-2.5 py-1.5 rounded-lg hover:bg-white/5 transition-colors group"
            >
              <FaviconWithFallback url={bookmark.url} icon={bookmark.icon} title={bookmark.title} />
              <div className="flex-1 min-w-0">
                {showLabels && (
                  <span className="text-sm text-foreground/90 truncate block leading-tight">
                    {bookmark.title}
                  </span>
                )}
                <span className="text-[11px] text-muted-foreground/60 truncate block leading-tight">
                  {getDomain(bookmark.url)}
                </span>
              </div>
            </a>
          ))
        )}
      </div>
    </div>
  );
}

function FaviconWithFallback({
  url,
  icon,
  title,
}: {
  url: string;
  icon?: string;
  title: string;
}) {
  const faviconUrl = icon || getFaviconUrl(url, 32);
  const [failed, setFailed] = useState(false);

  if (!faviconUrl || failed) {
    const letter = (title || "?")[0].toUpperCase();
    return (
      <div className="w-5 h-5 rounded bg-muted/50 flex items-center justify-center text-[11px] font-medium text-muted-foreground shrink-0">
        {letter}
      </div>
    );
  }

  return (
    <img
      src={faviconUrl}
      alt=""
      className="w-5 h-5 rounded object-contain shrink-0"
      onError={() => setFailed(true)}
    />
  );
}
