"use client";

import { useState, useEffect, useCallback, useMemo, CSSProperties } from "react";
import type { SiteNameStyle } from "@/lib/db/queries/branding";
import { CHARACTER_SHAPE_PRESETS } from "@/lib/wordart-presets";
import { Trash2, Plus, Server, Loader2, Pencil, Check, X } from "lucide-react";

interface Preset {
  id: string;
  name: string;
  style: SiteNameStyle;
  scope: string;
  createdAt: string | null;
}

interface WordArtGalleryProps {
  siteName: string;
  serverDefault: SiteNameStyle;
  currentStyle: SiteNameStyle;
  onApply: (style: SiteNameStyle) => void;
  onSave: (name: string) => Promise<void>;
  scope: "user" | "server";
}

function MiniPreview({ name, style }: { name: string; style: SiteNameStyle }) {
  const charShape = style.charShapeId
    ? CHARACTER_SHAPE_PRESETS.find((s) => s.id === style.charShapeId) ?? null
    : null;
  const text = name || "YouEye";
  const display = text.length > 8 ? text.slice(0, 7) + "\u2026" : text;

  const baseStyle = useMemo((): CSSProperties => {
    const base: CSSProperties = {
      fontFamily: `"${style.fontFamily}", sans-serif`,
      fontSize: "0.85rem",
      fontWeight: style.fontWeight,
      letterSpacing: style.letterSpacing,
      textTransform: style.textTransform as CSSProperties["textTransform"],
      textShadow: style.textShadow === "none" ? undefined : style.textShadow,
      lineHeight: 1.2,
      WebkitTextStroke: style.textStroke || "unset",
      transform: charShape ? undefined : style.transform || undefined,
      display: "inline-block",
      whiteSpace: "nowrap",
    };
    if (style.gradient?.enabled) {
      return {
        ...base,
        color: "transparent",
        backgroundImage: `linear-gradient(${style.gradient.direction}, ${style.gradient.from}, ${style.gradient.to})`,
        WebkitBackgroundClip: "text",
        WebkitTextFillColor: "transparent",
        backgroundClip: "text",
      };
    }
    return { ...base, color: style.color };
  }, [style, charShape]);

  if (charShape) {
    const intensity = style.charShapeIntensity ?? 1;
    return (
      <span style={{ ...baseStyle, display: "inline-flex", alignItems: "baseline" }}>
        {display.split("").map((ch, i) => (
          <span
            key={i}
            style={{
              display: "inline-block",
              transform: charShape.charTransform(i, display.length, intensity),
            }}
          >
            {ch === " " ? "\u00A0" : ch}
          </span>
        ))}
      </span>
    );
  }
  return <span style={baseStyle}>{display}</span>;
}

export function WordArtGallery({
  siteName,
  serverDefault,
  currentStyle,
  onApply,
  onSave,
  scope,
}: WordArtGalleryProps) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingName, setSavingName] = useState("");
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [saving, setSaving] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const apiBase =
    scope === "user" ? "/api/v1/user/wordart/presets" : "/api/ui/wordart-presets";

  const loadPresets = useCallback(async () => {
    try {
      const res = await fetch(apiBase);
      if (!res.ok) return;
      const data = await res.json();
      setPresets(data.presets ?? []);
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, [apiBase]);

  useEffect(() => {
    loadPresets();
  }, [loadPresets]);

  const handleSave = async () => {
    if (!savingName.trim()) return;
    setSaving(true);
    try {
      await onSave(savingName.trim());
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: savingName.trim(), style: currentStyle }),
      });
      if (res.ok) {
        setSavingName("");
        setShowSaveInput(false);
        await loadPresets();
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch(apiBase, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      setPresets((prev) => prev.filter((p) => p.id !== id));
    }
  };

  const handleRename = async (id: string) => {
    if (!renameValue.trim()) return;
    const res = await fetch(apiBase, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name: renameValue.trim() }),
    });
    if (res.ok) {
      setPresets((prev) =>
        prev.map((p) => (p.id === id ? { ...p, name: renameValue.trim() } : p))
      );
    }
    setRenamingId(null);
  };

  const userPresets = presets.filter((p) => p.scope === "user");
  const serverPresets = presets.filter((p) => p.scope === "server");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Saved Designs
        </h4>
        <button
          onClick={() => setShowSaveInput(!showSaveInput)}
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Save Current
        </button>
      </div>

      {showSaveInput && (
        <div className="flex items-center gap-2 p-3 rounded-lg border bg-muted/30">
          <input
            type="text"
            value={savingName}
            onChange={(e) => setSavingName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            placeholder="Design name..."
            autoFocus
            className="flex-1 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
          <button
            onClick={handleSave}
            disabled={saving || !savingName.trim()}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
          </button>
          <button
            onClick={() => {
              setShowSaveInput(false);
              setSavingName("");
            }}
            className="rounded-md border px-2 py-1.5 text-xs hover:bg-muted"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-20">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-3">
          {scope === "user" && (
            <button
              onClick={() => onApply(serverDefault)}
              className="w-full group relative flex items-center gap-3 rounded-lg border-2 border-dashed border-muted-foreground/20 hover:border-primary/40 p-3 transition-all hover:bg-muted/30"
            >
              <div className="flex-shrink-0 w-28 h-10 rounded bg-gray-950 flex items-center justify-center overflow-hidden">
                <MiniPreview name={siteName} style={serverDefault} />
              </div>
              <div className="flex-1 text-left">
                <div className="text-sm font-medium flex items-center gap-1.5">
                  <Server className="h-3.5 w-3.5 text-muted-foreground" />
                  Server Default
                </div>
                <div className="text-xs text-muted-foreground">
                  Reset to the server-wide style
                </div>
              </div>
            </button>
          )}

          {(scope === "user" ? [...serverPresets, ...userPresets] : serverPresets).map(
            (preset) => (
              <div
                key={preset.id}
                className="group relative flex items-center gap-3 rounded-lg border hover:border-primary/40 p-3 transition-all hover:bg-muted/30"
              >
                <button
                  onClick={() => onApply(preset.style)}
                  className="flex-shrink-0 w-28 h-10 rounded bg-gray-950 flex items-center justify-center overflow-hidden cursor-pointer"
                >
                  <MiniPreview name={siteName} style={preset.style} />
                </button>
                <div className="flex-1 min-w-0">
                  {renamingId === preset.id ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleRename(preset.id);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        autoFocus
                        className="flex-1 rounded border bg-background px-2 py-0.5 text-sm outline-none focus:ring-1 focus:ring-primary/40"
                      />
                      <button
                        onClick={() => handleRename(preset.id)}
                        className="p-0.5 hover:text-primary"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setRenamingId(null)}
                        className="p-0.5 hover:text-muted-foreground"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => onApply(preset.style)}
                      className="text-left w-full cursor-pointer"
                    >
                      <div className="text-sm font-medium truncate flex items-center gap-1.5">
                        {preset.scope === "server" && scope === "user" && (
                          <Server className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                        )}
                        {preset.name}
                      </div>
                    </button>
                  )}
                </div>
                {(preset.scope === "user" || scope === "server") && (
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => {
                        setRenamingId(preset.id);
                        setRenameValue(preset.name);
                      }}
                      className="p-1 rounded hover:bg-muted"
                      title="Rename"
                    >
                      <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                    </button>
                    <button
                      onClick={() => handleDelete(preset.id)}
                      className="p-1 rounded hover:bg-destructive/10"
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </button>
                  </div>
                )}
              </div>
            )
          )}

          {presets.length === 0 && scope === "user" && (
            <p className="text-xs text-muted-foreground text-center py-4">
              No saved designs yet. Customize above and click &quot;Save Current&quot;.
            </p>
          )}
          {presets.length === 0 && scope === "server" && (
            <p className="text-xs text-muted-foreground text-center py-4">
              No server presets saved yet. Customize the style above and save it as a preset.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
