/**
 * Bookmarks Widget
 *
 * Grid of bookmark tiles organized into named pages.
 * Each tile shows a favicon and optional label.
 * Users manage bookmarks via the widget settings dialog.
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

const ICON_SIZES = {
  small: { tile: "w-14 h-14", icon: "w-5 h-5", favicon: 24, text: "text-[10px]" },
  medium: { tile: "w-[72px] h-[72px]", icon: "w-7 h-7", favicon: 32, text: "text-xs" },
  large: { tile: "w-20 h-20", icon: "w-9 h-9", favicon: 40, text: "text-xs" },
};

function getFaviconUrl(url: string, size: number): string {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}`;
  } catch {
    return "";
  }
}

export function BookmarksWidget({ settings }: BookmarksWidgetProps) {
  const pages = settings?.pages ?? [];
  const showLabels = settings?.showLabels ?? true;
  const iconSize = settings?.iconSize ?? "medium";
  const sizes = ICON_SIZES[iconSize] ?? ICON_SIZES.medium;

  const [activePageId, setActivePageId] = useState<string | undefined>(
    () => settings?.activePage ?? pages[0]?.id
  );

  const activePage = useMemo(
    () => pages.find((p) => p.id === activePageId) ?? pages[0],
    [pages, activePageId]
  );

  // Empty state
  if (pages.length === 0 || !activePage) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground/50">
        <div className="text-center">
          <Globe className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-xs">No bookmarks yet</p>
          <p className="text-[10px] opacity-60 mt-0.5">Open settings to add some</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-1.5 p-2">
      {/* Page tabs — only show if multiple pages */}
      {pages.length > 1 && (
        <div className="flex gap-1 overflow-x-auto shrink-0 pb-0.5">
          {pages.map((page) => (
            <button
              key={page.id}
              onClick={() => setActivePageId(page.id)}
              className={cn(
                "px-2.5 py-0.5 rounded-md text-xs whitespace-nowrap transition-colors",
                page.id === activePage?.id
                  ? "bg-primary/15 text-primary font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              )}
            >
              {page.name}
            </button>
          ))}
        </div>
      )}

      {/* Bookmark grid */}
      <div className="flex-1 overflow-auto">
        {activePage.bookmarks.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground/40 text-xs">
            No bookmarks on this page
          </div>
        ) : (
          <div className="flex flex-wrap gap-2 content-start">
            {activePage.bookmarks.map((bookmark) => (
              <a
                key={bookmark.id}
                href={bookmark.url}
                target="_blank"
                rel="noopener noreferrer"
                title={bookmark.title}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 rounded-lg transition-colors",
                  "hover:bg-foreground/5 cursor-pointer",
                  sizes.tile
                )}
              >
                {bookmark.icon ? (
                  <img
                    src={bookmark.icon}
                    alt=""
                    className={cn("rounded-md object-contain", sizes.icon)}
                    onError={(e) => {
                      // Fallback to favicon API on custom icon failure
                      const img = e.target as HTMLImageElement;
                      const faviconUrl = getFaviconUrl(bookmark.url, sizes.favicon);
                      if (faviconUrl && img.src !== faviconUrl) {
                        img.src = faviconUrl;
                      }
                    }}
                  />
                ) : (
                  <FaviconWithFallback url={bookmark.url} sizes={sizes} title={bookmark.title} />
                )}
                {showLabels && (
                  <span className={cn("leading-tight text-center text-muted-foreground truncate w-full px-0.5", sizes.text)}>
                    {bookmark.title}
                  </span>
                )}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Favicon image with letter-circle fallback */
function FaviconWithFallback({
  url,
  sizes,
  title,
}: {
  url: string;
  sizes: (typeof ICON_SIZES)[keyof typeof ICON_SIZES];
  title: string;
}) {
  const faviconUrl = getFaviconUrl(url, sizes.favicon);
  const [failed, setFailed] = useState(false);

  if (!faviconUrl || failed) {
    // Letter circle fallback
    const letter = (title || "?")[0].toUpperCase();
    return (
      <div className={cn(
        "rounded-md bg-muted flex items-center justify-center font-medium text-muted-foreground",
        sizes.icon
      )}>
        {letter}
      </div>
    );
  }

  return (
    <img
      src={faviconUrl}
      alt=""
      className={cn("rounded-md object-contain", sizes.icon)}
      onError={() => setFailed(true)}
    />
  );
}
