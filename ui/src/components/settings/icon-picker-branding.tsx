/**
 * IconPickerBranding — Server icon/favicon picker with four tabs + style controls.
 *
 * Tabs: Letter | Icons | Emoji | Upload
 * Style: Background (solid/gradient/transparent) + Shape (circle/rounded-square/square)
 *
 * Client-side canvas renders the preview. On save, renders to PNG blob and uploads
 * to /api/v1/branding/icon along with the IconConfig JSON.
 */

"use client";

import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Upload,
  Search,
  Smile,
  Type as TypeIcon,
  ImageIcon,
  Loader2,
  X,
  Circle,
  Square,
  RectangleHorizontal,
} from "lucide-react";
import * as LucideIcons from "lucide-react";
import type { ComponentType } from "react";
import type { IconConfig } from "@/lib/icon-config";
import type { SiteNameStyle } from "@/lib/db/queries/branding";

// ─── Props ─────────────────────────────────────────────────────

interface IconPickerBrandingProps {
  config: IconConfig;
  onChange: (config: IconConfig) => void;
  siteName: string;
  siteNameStyle: SiteNameStyle | null;
}

// ─── Lucide icons list (reuse from icon-picker.tsx pattern) ────

const LUCIDE_ENTRIES: Array<{
  name: string;
  component: ComponentType<{ className?: string }>;
}> = [];

function pascalToKebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

const SKIP = new Set([
  "default", "createLucideIcon", "icons", "Icon", "LucideIcon", "createElement",
]);

for (const [name, comp] of Object.entries(LucideIcons)) {
  if (SKIP.has(name)) continue;
  if (typeof comp !== "object" && typeof comp !== "function") continue;
  if (name[0] !== name[0].toUpperCase() || name.startsWith("Lucide")) continue;
  LUCIDE_ENTRIES.push({
    name: pascalToKebab(name),
    component: comp as ComponentType<{ className?: string }>,
  });
}
LUCIDE_ENTRIES.sort((a, b) => a.name.localeCompare(b.name));

// ─── Emoji data ────────────────────────────────────────────────

const EMOJI_CATEGORIES = [
  { name: "Smileys", emojis: ["😀","😎","🤩","🥳","😈","👻","💀","🤖","👽","🎃"] },
  { name: "Animals", emojis: ["🐶","🐱","🦊","🐻","🐼","🐯","🦁","🐸","🦉","🦋"] },
  { name: "Nature", emojis: ["🌸","🌺","🌻","🍀","🌲","🌊","🔥","⭐","✨","🌈"] },
  { name: "Objects", emojis: ["💻","🖥️","📱","💡","🔑","⚙️","🔧","📡","🎯","🏆"] },
  { name: "Symbols", emojis: ["❤️","💜","💙","💚","💛","🧡","🖤","💎","🔴","🟣"] },
  { name: "Food", emojis: ["🍎","🍊","🍋","🍉","🍕","🍔","☕","🍺","🧁","🍩"] },
  { name: "Travel", emojis: ["🚀","🛸","✈️","🏠","🏔️","🌅","🌌","⛵","🗼","🏕️"] },
  { name: "Activities", emojis: ["🎮","🎨","🎬","🎤","🎵","🎸","🎲","🧩","🎭","🎪"] },
];

// ─── Canvas rendering ──────────────────────────────────────────

function renderPreview(
  canvas: HTMLCanvasElement,
  config: IconConfig,
  siteName: string,
  siteNameStyle: SiteNameStyle | null,
  size: number = 128
) {
  const ctx = canvas.getContext("2d")!;
  canvas.width = size;
  canvas.height = size;
  ctx.clearRect(0, 0, size, size);

  // Background
  const { background, shape } = config;
  if (background.type !== "transparent") {
    // Clip to shape
    ctx.beginPath();
    if (shape === "circle") {
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    } else if (shape === "rounded-square") {
      const r = size * 0.2;
      ctx.roundRect(0, 0, size, size, r);
    } else {
      ctx.rect(0, 0, size, size);
    }
    ctx.closePath();

    if (background.type === "gradient" && background.gradient) {
      const grad = ctx.createLinearGradient(0, 0, size, size);
      grad.addColorStop(0, background.gradient.from);
      grad.addColorStop(1, background.gradient.to);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = background.color || "#8B5CF6";
    }
    ctx.fill();
  }

  // Content
  ctx.save();
  // Clip again for content
  ctx.beginPath();
  if (shape === "circle") {
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  } else if (shape === "rounded-square") {
    ctx.roundRect(0, 0, size, size, size * 0.2);
  } else {
    ctx.rect(0, 0, size, size);
  }
  ctx.clip();

  if (config.mode === "letter") {
    const letter = config.letter || siteName?.[0] || "Y";
    const style = siteNameStyle;
    const fontFamily = style?.fontFamily || "sans-serif";
    const fontWeight = style?.fontWeight || 700;
    const fontSize = Math.round(size * 0.55);
    ctx.font = `${fontWeight} ${fontSize}px "${fontFamily}", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    if (style?.gradient?.enabled) {
      const grad = ctx.createLinearGradient(0, 0, size, 0);
      grad.addColorStop(0, style.gradient.from);
      grad.addColorStop(1, style.gradient.to);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = style?.color || "#ffffff";
    }

    const display =
      style?.textTransform === "uppercase"
        ? letter.toUpperCase()
        : style?.textTransform === "lowercase"
          ? letter.toLowerCase()
          : letter;
    ctx.fillText(display, size / 2, size / 2 + 2);
  } else if (config.mode === "emoji" && config.emoji) {
    const fontSize = Math.round(size * 0.6);
    ctx.font = `${fontSize}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(config.emoji, size / 2, size / 2 + 2);
  } else if (config.mode === "lucide") {
    // For lucide, draw a placeholder — actual SVG drawn via DOM
    ctx.fillStyle = config.lucideColor || "#ffffff";
    ctx.font = `bold ${Math.round(size * 0.4)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("⬡", size / 2, size / 2);
  }

  ctx.restore();
}

async function renderToBlob(
  config: IconConfig,
  siteName: string,
  siteNameStyle: SiteNameStyle | null,
  size: number = 512
): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  renderPreview(canvas, config, siteName, siteNameStyle, size);

  // For lucide mode, draw the SVG icon properly
  if (config.mode === "lucide" && config.lucideIcon) {
    const ctx = canvas.getContext("2d")!;
    // Find the Lucide icon component's SVG element from DOM
    const tempDiv = document.createElement("div");
    tempDiv.style.position = "absolute";
    tempDiv.style.left = "-9999px";
    document.body.appendChild(tempDiv);

    // Create SVG manually
    const iconSize = Math.round(size * 0.5);
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("width", String(iconSize));
    svg.setAttribute("height", String(iconSize));
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", config.lucideColor || "#ffffff");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");

    // Get icon paths from a hidden rendered icon
    const iconEl = document.querySelector(
      `[data-lucide-preview="${config.lucideIcon}"]`
    );
    if (iconEl) {
      svg.innerHTML = iconEl.innerHTML;
    }

    const svgStr = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    const svgBlob = new Blob([svgStr], { type: "image/svg+xml" });
    const url = URL.createObjectURL(svgBlob);

    await new Promise<void>((resolve) => {
      img.onload = () => {
        const offset = (size - iconSize) / 2;
        ctx.drawImage(img, offset, offset, iconSize, iconSize);
        URL.revokeObjectURL(url);
        resolve();
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve();
      };
      img.src = url;
    });

    document.body.removeChild(tempDiv);
  }

  return new Promise((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
}

// ─── Component ─────────────────────────────────────────────────

export function IconPickerBranding({
  config,
  onChange,
  siteName,
  siteNameStyle,
}: IconPickerBrandingProps) {
  const [activeTab, setActiveTab] = useState<string>(config.mode);
  const [iconSearch, setIconSearch] = useState("");
  const [emojiSearch, setEmojiSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadPreview, setUploadPreview] = useState<string | null>(
    config.mode === "upload" ? config.uploadUrl || null : null
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Draw preview whenever config changes
  useEffect(() => {
    if (canvasRef.current) {
      renderPreview(canvasRef.current, config, siteName, siteNameStyle, 128);
    }
  }, [config, siteName, siteNameStyle]);

  // Tab change = mode change
  const handleTabChange = useCallback(
    (tab: string) => {
      setActiveTab(tab);
      const modeMap: Record<string, IconConfig["mode"]> = {
        letter: "letter",
        icons: "lucide",
        emoji: "emoji",
        upload: "upload",
      };
      const mode = modeMap[tab] || "letter";
      if (mode !== config.mode) {
        onChange({ ...config, mode });
      }
    },
    [config, onChange]
  );

  // Filtered lucide icons
  const filteredIcons = useMemo(() => {
    if (!iconSearch.trim()) return LUCIDE_ENTRIES.slice(0, 200);
    const q = iconSearch.toLowerCase();
    return LUCIDE_ENTRIES.filter((i) => i.name.includes(q)).slice(0, 200);
  }, [iconSearch]);

  // Filtered emoji
  const filteredEmojis = useMemo(() => {
    if (!emojiSearch.trim()) return EMOJI_CATEGORIES;
    const q = emojiSearch.toLowerCase();
    return EMOJI_CATEGORIES.filter((c) => c.name.toLowerCase().includes(q));
  }, [emojiSearch]);

  // Upload handler
  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setUploading(true);

      const reader = new FileReader();
      reader.onload = () => setUploadPreview(reader.result as string);
      reader.readAsDataURL(file);

      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("type", "favicon");
        const res = await fetch("/api/v1/branding/upload", {
          method: "POST",
          body: formData,
        });
        if (res.ok) {
          const data = await res.json();
          onChange({ ...config, mode: "upload", uploadUrl: data.url });
        }
      } catch (err) {
        console.error("Upload error:", err);
      } finally {
        setUploading(false);
      }
    },
    [config, onChange]
  );

  return (
    <div className="space-y-4">
      {/* Preview row */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3">
          {/* Large preview */}
          <div className="relative">
            <canvas
              ref={canvasRef}
              width={128}
              height={128}
              className="w-16 h-16 rounded-lg"
              style={{ imageRendering: "auto" }}
            />
          </div>
          {/* Small previews */}
          <div className="flex flex-col gap-1">
            <canvas
              width={32}
              height={32}
              className="w-4 h-4"
              ref={(el) => {
                if (el) renderPreview(el, config, siteName, siteNameStyle, 32);
              }}
            />
            <span className="text-[9px] text-muted-foreground">favicon</span>
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Server Icon</p>
          <p>Used as favicon across UI, Control Panel, and Authentik login</p>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
        <TabsList className="w-full grid grid-cols-4">
          <TabsTrigger value="letter" className="gap-1.5 text-xs">
            <TypeIcon className="h-3.5 w-3.5" />
            Letter
          </TabsTrigger>
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

        {/* Letter Tab */}
        <TabsContent value="letter" className="mt-3 space-y-3">
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              Letter (defaults to first letter of site name)
            </label>
            <Input
              value={config.letter || ""}
              onChange={(e) =>
                onChange({ ...config, letter: e.target.value.slice(0, 2) })
              }
              placeholder={siteName?.[0] || "Y"}
              maxLength={2}
              className="h-8 text-xs w-20"
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            Uses your WordArt font and color. Updates automatically when WordArt changes.
          </p>
        </TabsContent>

        {/* Icons Tab */}
        <TabsContent value="icons" className="mt-3 space-y-2">
          <Input
            placeholder="Search icons..."
            value={iconSearch}
            onChange={(e) => setIconSearch(e.target.value)}
            className="h-8 text-xs"
          />
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              Icon Color
            </label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={config.lucideColor || "#ffffff"}
                onChange={(e) =>
                  onChange({ ...config, lucideColor: e.target.value })
                }
                className="w-8 h-8 rounded border cursor-pointer"
              />
              <span className="text-xs font-mono text-muted-foreground">
                {config.lucideColor || "#ffffff"}
              </span>
            </div>
          </div>
          <ScrollArea className="h-[200px]">
            <div className="grid grid-cols-8 gap-1 p-1">
              {filteredIcons.map((entry) => {
                const Icon = entry.component;
                const isActive =
                  config.mode === "lucide" &&
                  config.lucideIcon === entry.name;
                return (
                  <button
                    key={entry.name}
                    type="button"
                    title={entry.name}
                    onClick={() =>
                      onChange({
                        ...config,
                        mode: "lucide",
                        lucideIcon: entry.name,
                      })
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
          </ScrollArea>
          {/* Hidden SVG for rendering */}
          {config.lucideIcon && (() => {
            const entry = LUCIDE_ENTRIES.find(
              (e) => e.name === config.lucideIcon
            );
            if (!entry) return null;
            const LIcon = entry.component;
            return (
              <div className="hidden">
                <LIcon
                  className="h-6 w-6"
                  // @ts-expect-error custom data attribute for canvas rendering
                  data-lucide-preview={config.lucideIcon}
                />
              </div>
            );
          })()}
        </TabsContent>

        {/* Emoji Tab */}
        <TabsContent value="emoji" className="mt-3 space-y-2">
          <Input
            placeholder="Search emoji by category..."
            value={emojiSearch}
            onChange={(e) => setEmojiSearch(e.target.value)}
            className="h-8 text-xs"
          />
          <ScrollArea className="h-[200px]">
            <div className="space-y-3 p-1">
              {filteredEmojis.map((cat) => (
                <div key={cat.name}>
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                    {cat.name}
                  </p>
                  <div className="grid grid-cols-10 gap-0.5">
                    {cat.emojis.map((emoji) => {
                      const isActive =
                        config.mode === "emoji" && config.emoji === emoji;
                      return (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() =>
                            onChange({ ...config, mode: "emoji", emoji })
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

        {/* Upload Tab */}
        <TabsContent value="upload" className="mt-3">
          <div className="flex flex-col items-center gap-4 py-4">
            {uploadPreview || config.uploadUrl ? (
              <div className="relative">
                <img
                  src={uploadPreview ?? config.uploadUrl!}
                  alt="Icon preview"
                  className="w-16 h-16 rounded-xl object-cover border"
                />
                <button
                  type="button"
                  onClick={() => {
                    setUploadPreview(null);
                    onChange({ ...config, uploadUrl: undefined });
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                  className="absolute -top-2 -right-2 bg-destructive text-destructive-foreground rounded-full p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <div className="w-16 h-16 rounded-xl border-2 border-dashed border-muted-foreground/30 flex items-center justify-center">
                <ImageIcon className="h-6 w-6 text-muted-foreground/40" />
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon"
              onChange={handleFileSelect}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs hover:bg-muted transition-colors disabled:opacity-50"
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {uploading ? "Uploading..." : "Choose Image"}
            </button>
            <p className="text-[10px] text-muted-foreground">
              PNG, JPEG, WebP, SVG, ICO — max 100KB
            </p>
          </div>
        </TabsContent>
      </Tabs>

      {/* Style controls (background + shape) — shown for all modes except upload */}
      {config.mode !== "upload" && (
        <div className="space-y-3 border-t pt-3">
          {/* Shape */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              Shape
            </label>
            <div className="flex gap-2">
              {(
                [
                  { id: "rounded-square" as const, icon: RectangleHorizontal, label: "Rounded" },
                  { id: "circle" as const, icon: Circle, label: "Circle" },
                  { id: "square" as const, icon: Square, label: "Square" },
                ] as const
              ).map(({ id, icon: ShapeIcon, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => onChange({ ...config, shape: id })}
                  className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors ${
                    config.shape === id
                      ? "border-primary bg-primary/10 text-primary"
                      : "hover:bg-accent"
                  }`}
                >
                  <ShapeIcon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Background */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              Background
            </label>
            <div className="flex gap-2">
              {(["solid", "gradient", "transparent"] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() =>
                    onChange({
                      ...config,
                      background: {
                        ...config.background,
                        type,
                        color: type === "solid" ? (config.background.color || "#8B5CF6") : config.background.color,
                        gradient:
                          type === "gradient"
                            ? config.background.gradient || {
                                from: "#8B5CF6",
                                to: "#EC4899",
                              }
                            : config.background.gradient,
                      },
                    })
                  }
                  className={`rounded-md border px-3 py-1.5 text-xs transition-colors capitalize ${
                    config.background.type === type
                      ? "border-primary bg-primary/10 text-primary"
                      : "hover:bg-accent"
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>

            {/* Color picker for solid */}
            {config.background.type === "solid" && (
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={config.background.color || "#8B5CF6"}
                  onChange={(e) =>
                    onChange({
                      ...config,
                      background: { ...config.background, color: e.target.value },
                    })
                  }
                  className="w-8 h-8 rounded border cursor-pointer"
                />
                <span className="text-xs font-mono text-muted-foreground">
                  {config.background.color || "#8B5CF6"}
                </span>
              </div>
            )}

            {/* Gradient pickers */}
            {config.background.type === "gradient" && config.background.gradient && (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1">
                  <input
                    type="color"
                    value={config.background.gradient.from}
                    onChange={(e) =>
                      onChange({
                        ...config,
                        background: {
                          ...config.background,
                          gradient: {
                            ...config.background.gradient!,
                            from: e.target.value,
                          },
                        },
                      })
                    }
                    className="w-7 h-7 rounded border cursor-pointer"
                  />
                  <span className="text-[10px] text-muted-foreground">From</span>
                </div>
                <div className="flex items-center gap-1">
                  <input
                    type="color"
                    value={config.background.gradient.to}
                    onChange={(e) =>
                      onChange({
                        ...config,
                        background: {
                          ...config.background,
                          gradient: {
                            ...config.background.gradient!,
                            to: e.target.value,
                          },
                        },
                      })
                    }
                    className="w-7 h-7 rounded border cursor-pointer"
                  />
                  <span className="text-[10px] text-muted-foreground">To</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Utility: render icon to blob for upload */
export { renderToBlob };
