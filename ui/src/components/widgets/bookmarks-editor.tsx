/**
 * Bookmarks Editor
 *
 * Custom settings panel for the bookmarks widget.
 * Manages pages and bookmarks within each page.
 */

"use client";

import { useState, useCallback } from "react";
import { Plus, Trash2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { BookmarkItem, BookmarkPage } from "./bookmarks-widget";

interface BookmarksEditorProps {
  pages: BookmarkPage[];
  onChange: (pages: BookmarkPage[]) => void;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function extractTitle(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    // Capitalize first letter of domain name
    const name = hostname.split(".")[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return "Bookmark";
  }
}

export function BookmarksEditor({ pages, onChange }: BookmarksEditorProps) {
  const [activePageId, setActivePageId] = useState<string>(pages[0]?.id ?? "");
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editingPageName, setEditingPageName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newTitle, setNewTitle] = useState("");

  const activePage = pages.find((p) => p.id === activePageId) ?? pages[0];

  // ─── Page management ───

  const addPage = useCallback(() => {
    const id = generateId();
    const newPage: BookmarkPage = {
      id,
      name: `Page ${pages.length + 1}`,
      bookmarks: [],
    };
    onChange([...pages, newPage]);
    setActivePageId(id);
  }, [pages, onChange]);

  const removePage = useCallback(
    (pageId: string) => {
      const updated = pages.filter((p) => p.id !== pageId);
      onChange(updated);
      if (activePageId === pageId) {
        setActivePageId(updated[0]?.id ?? "");
      }
    },
    [pages, activePageId, onChange]
  );

  const startRenamePage = useCallback(
    (pageId: string) => {
      const page = pages.find((p) => p.id === pageId);
      if (page) {
        setEditingPageId(pageId);
        setEditingPageName(page.name);
      }
    },
    [pages]
  );

  const commitRenamePage = useCallback(() => {
    if (!editingPageId || !editingPageName.trim()) {
      setEditingPageId(null);
      return;
    }
    onChange(
      pages.map((p) =>
        p.id === editingPageId ? { ...p, name: editingPageName.trim() } : p
      )
    );
    setEditingPageId(null);
  }, [editingPageId, editingPageName, pages, onChange]);

  // ─── Bookmark management ───

  const addBookmark = useCallback(() => {
    if (!newUrl.trim() || !activePage) return;
    let url = newUrl.trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

    const bookmark: BookmarkItem = {
      id: generateId(),
      url,
      title: newTitle.trim() || extractTitle(url),
    };

    onChange(
      pages.map((p) =>
        p.id === activePage.id
          ? { ...p, bookmarks: [...p.bookmarks, bookmark] }
          : p
      )
    );
    setNewUrl("");
    setNewTitle("");
  }, [newUrl, newTitle, activePage, pages, onChange]);

  const removeBookmark = useCallback(
    (bookmarkId: string) => {
      if (!activePage) return;
      onChange(
        pages.map((p) =>
          p.id === activePage.id
            ? { ...p, bookmarks: p.bookmarks.filter((b) => b.id !== bookmarkId) }
            : p
        )
      );
    },
    [activePage, pages, onChange]
  );

  return (
    <div className="space-y-4">
      {/* Page tabs */}
      <div>
        <span className="text-xs text-muted-foreground mb-2 block">Pages</span>
        <div className="flex flex-wrap gap-1.5 items-center">
          {pages.map((page) => (
            <div key={page.id} className="flex items-center">
              {editingPageId === page.id ? (
                <div className="flex items-center gap-0.5">
                  <Input
                    value={editingPageName}
                    onChange={(e) => setEditingPageName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRenamePage();
                      if (e.key === "Escape") setEditingPageId(null);
                    }}
                    className="h-7 w-24 text-xs"
                    autoFocus
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={commitRenamePage}
                  >
                    <Check className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <button
                  onClick={() => setActivePageId(page.id)}
                  onDoubleClick={() => startRenamePage(page.id)}
                  className={cn(
                    "px-2.5 py-1 rounded-md text-xs transition-colors",
                    page.id === activePage?.id
                      ? "bg-primary/15 text-primary font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  )}
                >
                  {page.name}
                </button>
              )}
            </div>
          ))}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={addPage}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        {pages.length > 1 && activePage && editingPageId !== activePage.id && (
          <div className="flex gap-1.5 mt-1.5">
            <button
              onClick={() => startRenamePage(activePage.id)}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              Rename
            </button>
            <span className="text-[10px] text-muted-foreground/30">|</span>
            <button
              onClick={() => removePage(activePage.id)}
              className="text-[10px] text-destructive/70 hover:text-destructive"
            >
              Delete page
            </button>
          </div>
        )}
      </div>

      <Separator />

      {/* Bookmarks list for active page */}
      {activePage && (
        <div>
          <span className="text-xs text-muted-foreground mb-2 block">
            Bookmarks — {activePage.name}
          </span>

          <ScrollArea className="max-h-48">
            <div className="space-y-1.5">
              {activePage.bookmarks.map((bookmark) => (
                <div
                  key={bookmark.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-muted/30 group"
                >
                  <img
                    src={`https://www.google.com/s2/favicons?domain=${
                      (() => { try { return new URL(bookmark.url).hostname; } catch { return ""; } })()
                    }&sz=16`}
                    alt=""
                    className="w-4 h-4 rounded-sm shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs truncate">{bookmark.title}</div>
                    <div className="text-[10px] text-muted-foreground truncate">{bookmark.url}</div>
                  </div>
                  <button
                    onClick={() => removeBookmark(bookmark.id)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-destructive/60 hover:text-destructive shrink-0"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </ScrollArea>

          {/* Add bookmark form */}
          <div className="mt-3 space-y-2">
            <div className="flex gap-2">
              <Input
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="URL (e.g. github.com)"
                className="h-8 text-xs flex-1"
                onKeyDown={(e) => { if (e.key === "Enter") addBookmark(); }}
              />
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Title (optional)"
                className="h-8 text-xs w-28"
                onKeyDown={(e) => { if (e.key === "Enter") addBookmark(); }}
              />
              <Button
                variant="secondary"
                size="sm"
                className="h-8 px-2.5"
                onClick={addBookmark}
                disabled={!newUrl.trim()}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {pages.length === 0 && (
        <div className="text-center py-4">
          <p className="text-xs text-muted-foreground mb-2">No pages yet</p>
          <Button variant="secondary" size="sm" onClick={addPage}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add first page
          </Button>
        </div>
      )}
    </div>
  );
}
