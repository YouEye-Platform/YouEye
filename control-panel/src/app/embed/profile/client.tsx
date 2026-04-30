"use client";

/**
 * Profile Embed Client
 *
 * Lets users edit their own first name, last name, and avatar.
 * Changes are saved to Authentik via CP backend routes.
 * Avatar updates are sent to the parent UI via postMessage.
 */

import { useEffect, useState, useCallback, useRef } from "react";

// ─── Avatar Presets ──────────────────────────────────────

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

/** Read a file/blob as a data URL */
function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

// ─── Component ───────────────────────────────────────────

interface ProfileEmbedClientProps {
  username: string;
  isAdmin: boolean;
}

interface ProfileData {
  firstName: string;
  lastName: string;
  email: string;
  avatarUrl?: string;
}

export function ProfileEmbedClient({ username, isAdmin }: ProfileEmbedClientProps) {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchProfile = useCallback(async () => {
    try {
      const res = await fetch("/api/user/profile");
      if (!res.ok) throw new Error("Failed to load profile");
      const data = await res.json();
      setProfile(data);
      setFirstName(data.firstName || "");
      setLastName(data.lastName || "");
      if (data.avatarUrl) setAvatarPreview(data.avatarUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  // Report height to parent for auto-sizing
  useEffect(() => {
    const report = () => {
      const h = document.body.scrollHeight;
      window.parent.postMessage({ type: "youeye-embed-resize", height: h }, "*");
    };
    const observer = new ResizeObserver(report);
    observer.observe(document.body);
    window.parent.postMessage({ type: "youeye-embed-ready" }, "*");
    return () => observer.disconnect();
  }, []);

  // Listen for avatar sync from parent UI
  // If UI has an avatar locally but Authentik doesn't, use the UI's avatar
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === "youeye-embed-avatar" && e.data.avatarUrl && !avatarPreview) {
        setAvatarPreview(e.data.avatarUrl);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [avatarPreview]);

  // ─── Name Save ──────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSaved(false);

    try {
      const res = await fetch("/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim() }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save");
      }

      const updated = await res.json();
      setProfile(updated);
      setSaved(true);

      window.parent.postMessage({
        type: "youeye-profile-updated",
        firstName: updated.firstName,
        lastName: updated.lastName,
      }, "*");

      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  // ─── Avatar Upload ──────────────────────────────────

  const uploadAvatar = async (blob: Blob) => {
    setAvatarUploading(true);
    setAvatarError("");

    try {
      // Read as data URL to send to parent
      const dataUrl = await readAsDataUrl(blob);

      // Upload to CP → Authentik
      const formData = new FormData();
      formData.append("file", blob, "avatar.png");
      const res = await fetch("/api/user/avatar", { method: "POST", body: formData });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Upload failed");
      }

      setAvatarPreview(dataUrl);
      setShowPicker(false);

      // Notify parent UI with the image data
      window.parent.postMessage({
        type: "youeye-avatar-updated",
        dataUrl,
      }, "*");
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadAvatar(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handlePresetSelect = async (preset: AvatarPreset) => {
    const blob = await renderPresetToBlob(preset.emoji, preset.bg);
    await uploadAvatar(blob);
  };

  const handleAvatarRemove = async () => {
    setAvatarUploading(true);
    setAvatarError("");

    try {
      const res = await fetch("/api/user/avatar", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Remove failed");
      }

      setAvatarPreview(null);
      window.parent.postMessage({ type: "youeye-avatar-updated", dataUrl: null }, "*");
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setAvatarUploading(false);
    }
  };

  // ─── Render ─────────────────────────────────────────

  const hasChanges = profile && (firstName.trim() !== (profile.firstName || "") || lastName.trim() !== (profile.lastName || ""));

  const initials = ([firstName, lastName].filter(Boolean).join(" ") || username || "?")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <div className="embed-card">
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div className="embed-skeleton" style={{ width: 56, height: 56, borderRadius: "50%" }} />
            <div style={{ flex: 1 }}>
              <div className="embed-skeleton" style={{ width: "60%", height: 14, marginBottom: 8 }} />
              <div className="embed-skeleton" style={{ width: "40%", height: 12 }} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      {/* Avatar Card */}
      <div className="embed-card">
        <div className="embed-card-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="12" cy="10" r="3" />
            <path d="M7 21v-1a5 5 0 0 1 10 0v1" />
          </svg>
          Profile Picture
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12 }}>
          <div style={{ position: "relative", width: 56, height: 56, flexShrink: 0 }}>
            {avatarPreview ? (
              <img
                src={avatarPreview}
                alt="Avatar"
                style={{ width: 56, height: 56, borderRadius: "50%", objectFit: "cover" }}
              />
            ) : (
              <div style={{
                width: 56, height: 56, borderRadius: "50%",
                background: "var(--embed-primary)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "white", fontSize: 18, fontWeight: 600,
              }}>
                {initials}
              </div>
            )}
            {avatarUploading && (
              <div style={{
                position: "absolute", inset: 0, borderRadius: "50%",
                background: "rgba(0,0,0,0.5)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <span style={{
                  width: 18, height: 18,
                  border: "2px solid white", borderTopColor: "transparent",
                  borderRadius: "50%", display: "inline-block",
                  animation: "embed-spin 0.6s linear infinite",
                }} />
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <label className="embed-btn" style={{ cursor: "pointer" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Upload
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={handleFileUpload}
                disabled={avatarUploading}
              />
            </label>
            <button
              className="embed-btn"
              onClick={() => setShowPicker(!showPicker)}
              disabled={avatarUploading}
              style={showPicker ? { borderColor: "var(--embed-primary)", color: "var(--embed-primary)" } : {}}
            >
              {showPicker ? "\u2715" : "\u{1F600}"} {showPicker ? "Close" : "Presets"}
            </button>
            {avatarPreview && (
              <button
                className="embed-btn"
                onClick={handleAvatarRemove}
                disabled={avatarUploading}
                style={{ color: "var(--embed-danger)" }}
              >
                Remove
              </button>
            )}
          </div>
        </div>

        {avatarError && (
          <div style={{ fontSize: 12, color: "var(--embed-danger)", marginBottom: 8 }}>{avatarError}</div>
        )}

        {showPicker && (
          <div style={{
            padding: 10, borderRadius: 8,
            border: "1px solid var(--embed-border)",
            background: "var(--embed-bg, transparent)",
          }}>
            <p className="embed-muted" style={{ fontSize: 11, marginBottom: 8 }}>Choose an avatar preset:</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 6 }}>
              {AVATAR_PRESETS.map((preset, i) => (
                <button
                  key={i}
                  onClick={() => handlePresetSelect(preset)}
                  disabled={avatarUploading}
                  style={{
                    width: 34, height: 34, borderRadius: "50%",
                    border: "none", cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 16,
                    background: `linear-gradient(135deg, ${preset.bg[0]}, ${preset.bg[1]})`,
                    transition: "transform 0.15s",
                    opacity: avatarUploading ? 0.5 : 1,
                  }}
                  onMouseEnter={(e) => { (e.target as HTMLElement).style.transform = "scale(1.15)"; }}
                  onMouseLeave={(e) => { (e.target as HTMLElement).style.transform = "scale(1)"; }}
                >
                  {preset.emoji}
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="embed-muted" style={{ fontSize: 11, marginTop: 8 }}>
          Your picture is synced to your account and visible to connected apps.
        </p>
      </div>

      {/* Account Name Card */}
      <div className="embed-card">
        <div className="embed-card-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="8" r="4" />
            <path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
          </svg>
          Account Name
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div>
            <label className="embed-label" style={{ display: "block", marginBottom: 4 }}>First Name</label>
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="First name"
              style={{
                width: "100%", padding: "8px 12px",
                background: "var(--embed-bg, transparent)",
                border: "1px solid var(--embed-border)",
                borderRadius: 6, color: "var(--embed-text)",
                fontSize: 14, outline: "none",
              }}
            />
          </div>
          <div>
            <label className="embed-label" style={{ display: "block", marginBottom: 4 }}>Last Name</label>
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="Last name"
              style={{
                width: "100%", padding: "8px 12px",
                background: "var(--embed-bg, transparent)",
                border: "1px solid var(--embed-border)",
                borderRadius: 6, color: "var(--embed-text)",
                fontSize: 14, outline: "none",
              }}
            />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          <div>
            <label className="embed-label" style={{ display: "block", marginBottom: 4 }}>Username</label>
            <div className="embed-muted" style={{ padding: "8px 12px", fontSize: 14, border: "1px solid var(--embed-border)", borderRadius: 6, opacity: 0.7 }}>
              {username}
            </div>
          </div>
          <div>
            <label className="embed-label" style={{ display: "block", marginBottom: 4 }}>Email</label>
            <div className="embed-muted" style={{ padding: "8px 12px", fontSize: 14, border: "1px solid var(--embed-border)", borderRadius: 6, opacity: 0.7 }}>
              {profile?.email || "\u2014"}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            className="embed-btn"
            onClick={handleSave}
            disabled={saving || !hasChanges}
            style={{
              background: hasChanges ? "var(--embed-primary)" : "var(--embed-card-bg)",
              color: hasChanges ? "white" : "var(--embed-text)",
              opacity: saving || !hasChanges ? 0.5 : 1,
            }}
          >
            {saving ? (
              <>
                <span style={{ width: 14, height: 14, border: "2px solid currentColor", borderTopColor: "transparent", borderRadius: "50%", animation: "embed-spin 0.6s linear infinite", display: "inline-block" }} />
                Saving...
              </>
            ) : "Save Name"}
          </button>
          {saved && <span style={{ fontSize: 13, color: "var(--embed-success)" }}>Saved to account</span>}
          {error && <span style={{ fontSize: 13, color: "var(--embed-danger)" }}>{error}</span>}
        </div>

        {isAdmin && (
          <div style={{ marginTop: 12, padding: "6px 10px", borderRadius: 6, fontSize: 12, color: "var(--embed-primary)", border: "1px solid color-mix(in srgb, var(--embed-primary) 30%, transparent)" }}>
            &#10022; Administrator
          </div>
        )}
      </div>

      <style>{`
        @keyframes embed-spin {
          to { transform: rotate(360deg); }
        }
        input:focus {
          border-color: var(--embed-primary) !important;
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--embed-primary) 20%, transparent);
        }
      `}</style>
    </div>
  );
}
