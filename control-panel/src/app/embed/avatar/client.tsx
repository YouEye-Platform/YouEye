"use client";

/**
 * Avatar Embed Client — minimal avatar picker for onboarding.
 *
 * Standalone embed showing just avatar upload/presets.
 * Sends youeye-avatar-updated postMessage to parent.
 */

import { useEffect, useState, useRef } from "react";

interface AvatarPreset {
  emoji: string;
  bg: [string, string];
}

const AVATAR_PRESETS: AvatarPreset[] = [
  { emoji: "\u{1F431}", bg: ["#f59e0b", "#d97706"] },
  { emoji: "\u{1F436}", bg: ["#8b5cf6", "#7c3aed"] },
  { emoji: "\u{1F98A}", bg: ["#ef4444", "#dc2626"] },
  { emoji: "\u{1F43C}", bg: ["#6366f1", "#4f46e5"] },
  { emoji: "\u{1F981}", bg: ["#f97316", "#ea580c"] },
  { emoji: "\u{1F438}", bg: ["#22c55e", "#16a34a"] },
  { emoji: "\u{1F427}", bg: ["#06b6d4", "#0891b2"] },
  { emoji: "\u{1F985}", bg: ["#92400e", "#78350f"] },
  { emoji: "\u{1F680}", bg: ["#3b82f6", "#2563eb"] },
  { emoji: "\u2B50", bg: ["#eab308", "#ca8a04"] },
  { emoji: "\u{1F3B5}", bg: ["#ec4899", "#db2777"] },
  { emoji: "\u{1F3AE}", bg: ["#8b5cf6", "#7c3aed"] },
  { emoji: "\u{1F4DA}", bg: ["#14b8a6", "#0d9488"] },
  { emoji: "\u{1F3A8}", bg: ["#f472b6", "#ec4899"] },
  { emoji: "\u{1F4F7}", bg: ["#64748b", "#475569"] },
  { emoji: "\u2615", bg: ["#92400e", "#78350f"] },
  { emoji: "\u{1F30A}", bg: ["#06b6d4", "#0891b2"] },
  { emoji: "\u{1F319}", bg: ["#6366f1", "#4f46e5"] },
  { emoji: "\u2600\uFE0F", bg: ["#f59e0b", "#d97706"] },
  { emoji: "\u{1F33F}", bg: ["#22c55e", "#16a34a"] },
  { emoji: "\u{1F338}", bg: ["#f472b6", "#ec4899"] },
  { emoji: "\u{1F30B}", bg: ["#ef4444", "#b91c1c"] },
  { emoji: "\u{1F48E}", bg: ["#06b6d4", "#0891b2"] },
  { emoji: "\u{1F52E}", bg: ["#a855f7", "#9333ea"] },
  { emoji: "\u26A1", bg: ["#eab308", "#ca8a04"] },
  { emoji: "\u{1F525}", bg: ["#ef4444", "#dc2626"] },
  { emoji: "\u{1F308}", bg: ["#8b5cf6", "#ec4899"] },
  { emoji: "\u{1F3AF}", bg: ["#ef4444", "#dc2626"] },
  { emoji: "\u{1F47E}", bg: ["#22c55e", "#16a34a"] },
  { emoji: "\u{1F916}", bg: ["#64748b", "#475569"] },
  { emoji: "\u{1F984}", bg: ["#d946ef", "#a855f7"] },
  { emoji: "\u{1F47D}", bg: ["#22d3ee", "#06b6d4"] },
];

function renderPresetToBlob(emoji: string, bg: [string, string]): Promise<Blob> {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, bg[0]);
  gradient.addColorStop(1, bg[1]);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = `${size * 0.52}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, size / 2, size / 2 + size * 0.03);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob!), "image/png");
  });
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

export function AvatarEmbedClient({ username }: { username: string }) {
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const report = () => {
      window.parent.postMessage({ type: "youeye-embed-resize", height: document.body.scrollHeight }, "*");
    };
    const observer = new ResizeObserver(report);
    observer.observe(document.body);
    window.parent.postMessage({ type: "youeye-embed-ready" }, "*");
    return () => observer.disconnect();
  }, []);

  const uploadAvatar = async (blob: Blob) => {
    setUploading(true);
    setError("");

    try {
      const dataUrl = await readAsDataUrl(blob);
      setPreview(dataUrl);
      // Always notify parent first — parent handles saving on UI side
      window.parent.postMessage({ type: "youeye-avatar-updated", dataUrl }, "*");

      // Try CP-side save (may fail without session during onboarding — non-fatal)
      const formData = new FormData();
      formData.append("file", blob, "avatar.png");
      await fetch("/api/user/avatar", { method: "POST", body: formData }).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadAvatar(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const initials = (username || "?").slice(0, 2).toUpperCase();

  return (
    <div style={{ padding: 16, textAlign: "center" }}>
      {/* Preview */}
      <div style={{ marginBottom: 16, display: "flex", justifyContent: "center" }}>
        <div style={{ position: "relative", width: 80, height: 80 }}>
          {preview ? (
            <img src={preview} alt="Avatar" style={{ width: 80, height: 80, borderRadius: "50%", objectFit: "cover" }} />
          ) : (
            <div style={{
              width: 80, height: 80, borderRadius: "50%",
              background: "var(--embed-primary)",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "white", fontSize: 24, fontWeight: 600,
            }}>
              {initials}
            </div>
          )}
          {uploading && (
            <div style={{
              position: "absolute", inset: 0, borderRadius: "50%",
              background: "rgba(0,0,0,0.5)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <span style={{
                width: 20, height: 20,
                border: "2px solid white", borderTopColor: "transparent",
                borderRadius: "50%", display: "inline-block",
                animation: "embed-spin 0.6s linear infinite",
              }} />
            </div>
          )}
        </div>
      </div>

      {error && <div style={{ fontSize: 12, color: "var(--embed-danger)", marginBottom: 8 }}>{error}</div>}

      {/* Preset Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 6, marginBottom: 12 }}>
        {AVATAR_PRESETS.map((preset, i) => (
          <button
            key={i}
            onClick={() => { renderPresetToBlob(preset.emoji, preset.bg).then(uploadAvatar); }}
            disabled={uploading}
            style={{
              width: 34, height: 34, borderRadius: "50%",
              border: "none", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 16,
              background: `linear-gradient(135deg, ${preset.bg[0]}, ${preset.bg[1]})`,
              transition: "transform 0.15s",
              opacity: uploading ? 0.5 : 1,
            }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.transform = "scale(1.15)"; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.transform = "scale(1)"; }}
          >
            {preset.emoji}
          </button>
        ))}
      </div>

      {/* Upload button */}
      <label className="embed-btn" style={{ cursor: "pointer", display: "inline-flex" }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        Upload your own
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={handleFile}
          disabled={uploading}
        />
      </label>

      <style>{`
        @keyframes embed-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
