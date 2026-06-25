/**
 * IconPicker — Three-tab component for selecting app icons.
 *
 * Tabs:
 * 1. Upload — pick image from computer
 * 2. Icons — searchable grid of all Lucide icons
 * 3. Emoji — searchable emoji grid
 *
 * Returns the selected icon as a string:
 *   - Upload: URL path (e.g. "/user-assets/.../app-icon-xxx.png")
 *   - Lucide: kebab-case name (e.g. "sticky-note")
 *   - Emoji: "emoji:🎬"
 */

"use client";

import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Upload,
  Search,
  Smile,
  ImageIcon,
  Loader2,
  X,
} from "lucide-react";
import * as LucideIcons from "lucide-react";
import type { ComponentType } from "react";

// ─── Types ────────────────────────────────────────────────────

export interface IconPickerResult {
  /** "lucide" | "emoji" | "upload" */
  type: "lucide" | "emoji" | "upload";
  /** The value to store: icon name, "emoji:X", or URL path */
  value: string;
}

interface IconPickerProps {
  /** Current icon value (lucide name, emoji:X, or URL) */
  currentIcon?: string | null;
  /** Called when user selects an icon */
  onSelect: (result: IconPickerResult) => void;
  /** Optional: upload endpoint (defaults to /api/v1/user-assets/upload) */
  uploadEndpoint?: string;
  /** Whether to show compact layout */
  compact?: boolean;
}

// ─── Lucide Icon List (built at module load) ──────────────────

const LUCIDE_ICON_ENTRIES: Array<{ name: string; component: ComponentType<{ className?: string }> }> = [];

// Build list from lucide-react exports
// PascalCase export names → kebab-case for storage
function pascalToKebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

const SKIP_EXPORTS = new Set([
  "default",
  "createLucideIcon",
  "icons",
  "Icon",
  "LucideIcon",
  "createElement",
]);

for (const [exportName, component] of Object.entries(LucideIcons)) {
  if (SKIP_EXPORTS.has(exportName)) continue;
  if (typeof component !== "object" && typeof component !== "function") continue;
  // Only include actual icon components (they have render or $$typeof)
  if (
    exportName[0] !== exportName[0].toUpperCase() ||
    exportName.startsWith("Lucide")
  )
    continue;

  const kebab = pascalToKebab(exportName);
  LUCIDE_ICON_ENTRIES.push({
    name: kebab,
    component: component as ComponentType<{ className?: string }>,
  });
}

// Sort alphabetically
LUCIDE_ICON_ENTRIES.sort((a, b) => a.name.localeCompare(b.name));

// ─── Emoji Data ───────────────────────────────────────────────

interface EmojiCategory {
  name: string;
  emojis: string[];
}

const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    name: "Smileys",
    emojis: [
      "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "😊",
      "😇", "🥰", "😍", "🤩", "😘", "😋", "😛", "😜", "🤪", "😎",
      "🤓", "🧐", "🤠", "🥳", "😏", "😶", "🫠", "🤔", "🤫", "🫡",
      "🤗", "😬", "😮", "😲", "🥱", "😴", "🤯", "😈", "👻", "💀",
    ],
  },
  {
    name: "Hands & People",
    emojis: [
      "👋", "🤚", "✋", "🖖", "👌", "🤌", "🤏", "✌️", "🤞", "🫰",
      "🤙", "👈", "👉", "👆", "👇", "☝️", "👍", "👎", "✊", "👊",
      "🤛", "🤜", "👏", "🙌", "🫶", "👐", "🤲", "🤝", "🙏", "💪",
      "👤", "👥", "🧑‍💻", "🧑‍🎨", "🧑‍🔬", "🧑‍🚀", "🧑‍🏫", "🧑‍⚕️", "🧑‍🍳", "🧑‍🔧",
    ],
  },
  {
    name: "Animals & Nature",
    emojis: [
      "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯",
      "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🦅", "🦉",
      "🦇", "🐺", "🐗", "🐴", "🦄", "🐝", "🦋", "🐌", "🐛", "🐞",
      "🌸", "🌺", "🌻", "🌹", "🌷", "🌱", "🌿", "🍀", "🌲", "🌳",
    ],
  },
  {
    name: "Food & Drink",
    emojis: [
      "🍎", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐", "🍒", "🍑",
      "🥑", "🥦", "🥬", "🥕", "🌽", "🌶️", "🫑", "🍕", "🍔", "🍟",
      "🌭", "🥪", "🌮", "🍜", "🍝", "🍣", "🍱", "🍰", "🧁", "🍩",
      "☕", "🍵", "🧃", "🥤", "🍺", "🍷", "🥂", "🧊", "🫗", "🍴",
    ],
  },
  {
    name: "Activities",
    emojis: [
      "⚽", "🏀", "🏈", "⚾", "🥎", "🎾", "🏐", "🏉", "🎱", "🏓",
      "🏸", "🥅", "🏒", "⛳", "🏹", "🎣", "🤿", "🥊", "🎮", "🕹️",
      "🎲", "🧩", "♟️", "🎭", "🎨", "🎬", "🎤", "🎧", "🎵", "🎹",
      "🎸", "🎺", "🎻", "🥁", "🎯", "🎪", "🎠", "🎡", "🎢", "🏆",
    ],
  },
  {
    name: "Travel & Places",
    emojis: [
      "🚗", "🚕", "🚌", "🚎", "🏎️", "🚓", "🚑", "🚒", "🚐", "🛻",
      "🚚", "🚛", "🚜", "✈️", "🛩️", "🚀", "🛸", "🚁", "⛵", "🚢",
      "🏠", "🏡", "🏢", "🏣", "🏥", "🏦", "🏪", "🏫", "🏛️", "⛪",
      "🕌", "🗼", "🗽", "🗻", "🏔️", "🌋", "🏕", "🏖️", "🌅", "🌌",
    ],
  },
  {
    name: "Objects",
    emojis: [
      "⌚", "📱", "💻", "⌨️", "🖥️", "🖨️", "🖱️", "💾", "💿", "📀",
      "📷", "📹", "🎥", "📺", "📻", "🔊", "📢", "📣", "🔔", "🔕",
      "📡", "🔋", "🔌", "💡", "🔦", "🕯️", "📚", "📖", "📝", "✏️",
      "📌", "📎", "🔑", "🗝️", "🔒", "🔓", "🧲", "🔧", "🔨", "⚙️",
    ],
  },
  {
    name: "Symbols",
    emojis: [
      "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔",
      "❤️‍🔥", "💕", "💞", "💓", "💗", "💖", "💘", "💝", "⭐", "🌟",
      "✨", "💫", "🔥", "💥", "💢", "💦", "💨", "🕊️", "🎀", "🎁",
      "✅", "❌", "⚠️", "🚫", "💯", "🔴", "🟢", "🔵", "🟡", "🟣",
    ],
  },
];

// Flat list for search
const ALL_EMOJIS = EMOJI_CATEGORIES.flatMap((c) =>
  c.emojis.map((e) => ({ emoji: e, category: c.name }))
);

// ─── Component ────────────────────────────────────────────────

export function IconPicker({
  currentIcon,
  onSelect,
  uploadEndpoint = "/api/v1/user-assets/upload",
  compact = false,
}: IconPickerProps) {
  const [activeTab, setActiveTab] = useState<string>("icons");
  const [iconSearch, setIconSearch] = useState("");
  const [emojiSearch, setEmojiSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Determine current icon type for highlighting
  const currentType = currentIcon?.startsWith("emoji:")
    ? "emoji"
    : currentIcon?.startsWith("/") || currentIcon?.startsWith("http")
      ? "upload"
      : "lucide";

  // ─── Lucide search ─────────────────────────────────────

  const filteredIcons = useMemo(() => {
    if (!iconSearch.trim()) return LUCIDE_ICON_ENTRIES.slice(0, 200);
    const q = iconSearch.toLowerCase();
    return LUCIDE_ICON_ENTRIES.filter((i) => i.name.includes(q)).slice(0, 200);
  }, [iconSearch]);

  // ─── Emoji search ──────────────────────────────────────

  const filteredEmojis = useMemo(() => {
    if (!emojiSearch.trim()) return EMOJI_CATEGORIES;
    const q = emojiSearch.toLowerCase();
    return EMOJI_CATEGORIES.map((cat) => ({
      ...cat,
      emojis: cat.emojis.filter(() => cat.name.toLowerCase().includes(q)),
    })).filter((cat) => cat.emojis.length > 0);
  }, [emojiSearch]);

  // ─── Upload handler ────────────────────────────────────

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Preview
      const reader = new FileReader();
      reader.onload = () => setUploadPreview(reader.result as string);
      reader.readAsDataURL(file);

      // Upload
      setUploading(true);
      try {
        const form = new FormData();
        form.append("file", file);
        form.append("type", "app-icon");

        const res = await fetch(uploadEndpoint, {
          method: "POST",
          body: form,
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: "Upload failed" }));
          console.error("Upload failed:", data.error);
          return;
        }

        const data = await res.json();
        onSelect({ type: "upload", value: data.url });
      } catch (err) {
        console.error("Upload error:", err);
      } finally {
        setUploading(false);
      }
    },
    [onSelect, uploadEndpoint]
  );

  const gridH = compact ? "h-[200px]" : "h-[280px]";

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
      <TabsList className="w-full grid grid-cols-3">
        <TabsTrigger value="icons" className="gap-1.5 text-xs">
          <Search className="h-3.5 w-3.5" />
          Icons
        </TabsTrigger>
        <TabsTrigger value="emoji" className="gap-1.5 text-xs">
          <Smile className="h-3.5 w-3.5" />
          Emoji
        </TabsTrigger>
        <TabsTrigger value="upload" className="gap-1.5 text-xs">
          <Upload className="h-3.5 w-3.5" />
          Upload
        </TabsTrigger>
      </TabsList>

      {/* ─── Icons Tab ─────────────────────────────────── */}
      <TabsContent value="icons" className="mt-3 space-y-2">
        <Input
          placeholder="Search icons..."
          value={iconSearch}
          onChange={(e) => setIconSearch(e.target.value)}
          className="h-8 text-xs"
        />
        <ScrollArea className={gridH}>
          <div className="grid grid-cols-8 gap-1 p-1">
            {filteredIcons.map((entry) => {
              const Icon = entry.component;
              const isActive =
                currentType === "lucide" && currentIcon === entry.name;
              return (
                <button
                  key={entry.name}
                  type="button"
                  title={entry.name}
                  onClick={() =>
                    onSelect({ type: "lucide", value: entry.name })
                  }
                  className={`flex items-center justify-center w-8 h-8 rounded-md transition-colors ${
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-accent"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </button>
              );
            })}
          </div>
          {filteredIcons.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-6">
              No icons match &ldquo;{iconSearch}&rdquo;
            </p>
          )}
        </ScrollArea>
      </TabsContent>

      {/* ─── Emoji Tab ─────────────────────────────────── */}
      <TabsContent value="emoji" className="mt-3 space-y-2">
        <Input
          placeholder="Search emoji by category..."
          value={emojiSearch}
          onChange={(e) => setEmojiSearch(e.target.value)}
          className="h-8 text-xs"
        />
        <ScrollArea className={gridH}>
          <div className="space-y-3 p-1">
            {filteredEmojis.map((cat) => (
              <div key={cat.name}>
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                  {cat.name}
                </p>
                <div className="grid grid-cols-10 gap-0.5">
                  {cat.emojis.map((emoji) => {
                    const val = `emoji:${emoji}`;
                    const isActive = currentIcon === val;
                    return (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() =>
                          onSelect({ type: "emoji", value: val })
                        }
                        className={`flex items-center justify-center w-7 h-7 rounded transition-colors text-base ${
                          isActive
                            ? "bg-primary/20 ring-1 ring-primary"
                            : "hover:bg-accent"
                        }`}
                      >
                        {emoji}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </TabsContent>

      {/* ─── Upload Tab ────────────────────────────────── */}
      <TabsContent value="upload" className="mt-3">
        <div className="flex flex-col items-center gap-4 py-6">
          {uploadPreview || (currentType === "upload" && currentIcon) ? (
            <div className="relative">
              <img
                src={uploadPreview ?? currentIcon!}
                alt="Icon preview"
                className="w-20 h-20 rounded-xl object-cover border"
              />
              <button
                type="button"
                onClick={() => {
                  setUploadPreview(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                className="absolute -top-2 -right-2 bg-destructive text-destructive-foreground rounded-full p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <div className="w-20 h-20 rounded-xl border-2 border-dashed border-muted-foreground/30 flex items-center justify-center">
              <ImageIcon className="h-8 w-8 text-muted-foreground/40" />
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"
            onChange={handleFileSelect}
            className="hidden"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="gap-2"
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            {uploading ? "Uploading..." : "Choose Image"}
          </Button>
          <p className="text-[10px] text-muted-foreground">
            PNG, JPEG, WebP, SVG, GIF — max 2MB
          </p>
        </div>
      </TabsContent>
    </Tabs>
  );
}
