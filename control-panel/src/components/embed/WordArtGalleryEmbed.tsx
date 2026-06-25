"use client";

import { useState, useEffect, useCallback, useMemo, CSSProperties } from "react";
import { CHARACTER_SHAPE_PRESETS, type SiteNameStyle } from "@/lib/wordart-presets";

interface Preset {
  id: string;
  name: string;
  style: SiteNameStyle;
  scope: string;
}

interface Props {
  siteName: string;
  currentStyle: SiteNameStyle;
  onApply: (style: SiteNameStyle) => void;
}

function MiniPreview({ name, style }: { name: string; style: SiteNameStyle }) {
  const charShape = style.charShapeId
    ? CHARACTER_SHAPE_PRESETS.find((s) => s.id === style.charShapeId) ?? null
    : null;
  const text = name.length > 8 ? name.slice(0, 7) + "\u2026" : name || "YouEye";

  const baseStyle = useMemo((): CSSProperties => {
    const base: CSSProperties = {
      fontFamily: `"${style.fontFamily}", sans-serif`,
      fontSize: "0.8rem",
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
        {text.split("").map((ch, i) => (
          <span
            key={i}
            style={{
              display: "inline-block",
              transform: charShape.charTransform(i, text.length, intensity),
            }}
          >
            {ch === " " ? "\u00A0" : ch}
          </span>
        ))}
      </span>
    );
  }
  return <span style={baseStyle}>{text}</span>;
}

export default function WordArtGalleryEmbed({ siteName, currentStyle, onApply }: Props) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSave, setShowSave] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const loadPresets = useCallback(async () => {
    try {
      const res = await fetch("/api/ui/wordart-presets");
      if (!res.ok) return;
      const data = await res.json();
      setPresets(data.presets ?? []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadPresets(); }, [loadPresets]);

  const handleSave = async () => {
    if (!saveName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/ui/wordart-presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: saveName.trim(), style: currentStyle }),
      });
      if (res.ok) {
        setSaveName("");
        setShowSave(false);
        await loadPresets();
      }
    } finally { setSaving(false); }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch("/api/ui/wordart-presets", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) setPresets((p) => p.filter((x) => x.id !== id));
  };

  const handleRename = async (id: string) => {
    if (!renameValue.trim()) return;
    const res = await fetch("/api/ui/wordart-presets", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name: renameValue.trim() }),
    });
    if (res.ok) {
      setPresets((p) => p.map((x) => (x.id === id ? { ...x, name: renameValue.trim() } : x)));
    }
    setRenamingId(null);
  };

  const cardStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid var(--embed-border)",
    cursor: "pointer",
    transition: "border-color 0.15s",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--embed-muted)" }}>
          Saved Server Presets
        </span>
        <button
          className="embed-btn"
          onClick={() => setShowSave(!showSave)}
          style={{ fontSize: 12, padding: "4px 10px" }}
        >
          + Save Current
        </button>
      </div>

      {showSave && (
        <div style={{ display: "flex", gap: 8, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--embed-border)", background: "var(--embed-bg-muted, rgba(0,0,0,0.1))" }}>
          <input
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            placeholder="Preset name..."
            autoFocus
            style={{ flex: 1, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--embed-border)", background: "var(--embed-bg, transparent)", color: "var(--embed-text)", fontSize: 13, outline: "none" }}
          />
          <button
            className="embed-btn"
            onClick={handleSave}
            disabled={saving || !saveName.trim()}
            style={{ fontSize: 12, padding: "4px 10px", background: "var(--embed-primary)", color: "#fff", borderColor: "var(--embed-primary)" }}
          >
            {saving ? "..." : "Save"}
          </button>
          <button className="embed-btn" onClick={() => { setShowSave(false); setSaveName(""); }} style={{ fontSize: 12, padding: "4px 8px" }}>
            &times;
          </button>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: 16, color: "var(--embed-muted)" }}>Loading...</div>
      ) : presets.length === 0 ? (
        <div style={{ textAlign: "center", padding: 16, color: "var(--embed-muted)", fontSize: 12 }}>
          No server presets saved yet. Customize the style above and save it as a preset.
        </div>
      ) : (
        presets.map((preset) => (
          <div
            key={preset.id}
            style={cardStyle}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = "var(--embed-primary, #8B5CF6)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = "var(--embed-border)")}
          >
            <div
              onClick={() => onApply(preset.style)}
              style={{ flexShrink: 0, width: 100, height: 36, borderRadius: 6, background: "#0a0a0a", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", cursor: "pointer" }}
            >
              <MiniPreview name={siteName} style={preset.style} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {renamingId === preset.id ? (
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRename(preset.id);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    autoFocus
                    style={{ flex: 1, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--embed-border)", background: "var(--embed-bg, transparent)", color: "var(--embed-text)", fontSize: 13, outline: "none" }}
                  />
                  <button onClick={() => handleRename(preset.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--embed-primary)", fontSize: 14, padding: 2 }}>&check;</button>
                  <button onClick={() => setRenamingId(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--embed-muted)", fontSize: 14, padding: 2 }}>&times;</button>
                </div>
              ) : (
                <span
                  onClick={() => onApply(preset.style)}
                  style={{ fontSize: 13, fontWeight: 500, cursor: "pointer", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--embed-text)" }}
                >
                  {preset.name}
                </span>
              )}
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <button
                onClick={() => { setRenamingId(preset.id); setRenameValue(preset.name); }}
                title="Rename"
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--embed-muted)", fontSize: 13, padding: "2px 4px" }}
              >
                &#9998;
              </button>
              <button
                onClick={() => handleDelete(preset.id)}
                title="Delete"
                style={{ background: "none", border: "none", cursor: "pointer", color: "#ef4444", fontSize: 13, padding: "2px 4px" }}
              >
                &times;
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
