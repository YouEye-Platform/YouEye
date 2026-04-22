/**
 * Profile Settings
 *
 * Account name editing is handled by the CP embed (synced to Authentik).
 * Bio, timezone, and avatar are UI-local fields.
 * Username/email come from Authentik SSO and are display-only.
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { Save, Loader2, MapPin, FileText, Upload, Smile, X } from "lucide-react";

// ─── Avatar Presets ──────────────────────────────────────

interface AvatarPreset {
  emoji: string;
  bg: [string, string]; // gradient stops
}

const AVATAR_PRESETS: AvatarPreset[] = [
  // Animals
  { emoji: "\u{1F431}", bg: ["#f59e0b", "#d97706"] },
  { emoji: "\u{1F436}", bg: ["#8b5cf6", "#7c3aed"] },
  { emoji: "\u{1F98A}", bg: ["#ef4444", "#dc2626"] },
  { emoji: "\u{1F43C}", bg: ["#6366f1", "#4f46e5"] },
  { emoji: "\u{1F981}", bg: ["#f97316", "#ea580c"] },
  { emoji: "\u{1F438}", bg: ["#22c55e", "#16a34a"] },
  { emoji: "\u{1F427}", bg: ["#06b6d4", "#0891b2"] },
  { emoji: "\u{1F985}", bg: ["#92400e", "#78350f"] },
  // Objects & Symbols
  { emoji: "\u{1F680}", bg: ["#3b82f6", "#2563eb"] },
  { emoji: "\u2B50", bg: ["#eab308", "#ca8a04"] },
  { emoji: "\u{1F3B5}", bg: ["#ec4899", "#db2777"] },
  { emoji: "\u{1F3AE}", bg: ["#8b5cf6", "#7c3aed"] },
  { emoji: "\u{1F4DA}", bg: ["#14b8a6", "#0d9488"] },
  { emoji: "\u{1F3A8}", bg: ["#f472b6", "#ec4899"] },
  { emoji: "\u{1F4F7}", bg: ["#64748b", "#475569"] },
  { emoji: "\u2615", bg: ["#92400e", "#78350f"] },
  // Nature & Space
  { emoji: "\u{1F30A}", bg: ["#06b6d4", "#0891b2"] },
  { emoji: "\u{1F319}", bg: ["#6366f1", "#4f46e5"] },
  { emoji: "\u2600\uFE0F", bg: ["#f59e0b", "#d97706"] },
  { emoji: "\u{1F33F}", bg: ["#22c55e", "#16a34a"] },
  { emoji: "\u{1F338}", bg: ["#f472b6", "#ec4899"] },
  { emoji: "\u{1F30B}", bg: ["#ef4444", "#b91c1c"] },
  // Abstract
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

async function renderPresetToBlob(emoji: string, bg: [string, string]): Promise<Blob> {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  // Gradient circle background
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, bg[0]);
  gradient.addColorStop(1, bg[1]);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  // Emoji centered
  ctx.font = `${size * 0.52}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, size / 2, size / 2 + size * 0.03);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob!), "image/png");
  });
}

// ─── Component ───────────────────────────────────────────

interface ProfileSettingsProps {
  userId: string;
  username: string;
  name: string;
  email: string;
  isAdmin: boolean;
  profileEmbedUrl: string;
}

interface LocalProfileData {
  bio: string;
  timezone: string;
}

export function ProfileSettings({
  userId,
  username,
  name,
  email,
  isAdmin,
  profileEmbedUrl,
}: ProfileSettingsProps) {
  const t = useTranslations("settings.profile");
  const { resolvedTheme } = useTheme();
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [displayName, setDisplayName] = useState(name);
  const embedRef = useRef<HTMLIFrameElement>(null);
  const [embedReady, setEmbedReady] = useState(false);
  const [embedHeight, setEmbedHeight] = useState(200);

  const [profile, setProfile] = useState<LocalProfileData>({
    bio: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  // Load local profile fields (bio, timezone, avatar) from API on mount
  useEffect(() => {
    fetch("/api/v1/user/profile")
      .then((r) => r.json())
      .then((data) => {
        setProfile({
          bio: data.bio || "",
          timezone: data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        if (data.image) {
          setAvatarUrl(data.image);
        }
        // Update display name from latest DB state
        const fullName = [data.firstName, data.lastName].filter(Boolean).join(" ");
        if (fullName) setDisplayName(fullName);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Send current theme to embed iframe
  const sendThemeToEmbed = useCallback(() => {
    if (!embedRef.current?.contentWindow || !resolvedTheme) return;
    const origin = (() => { try { return new URL(profileEmbedUrl).origin; } catch { return "*"; } })();
    embedRef.current.contentWindow.postMessage(
      { type: "youeye-embed-theme", theme: resolvedTheme },
      origin
    );
  }, [resolvedTheme, profileEmbedUrl]);

  // Listen for profile updates from the CP embed
  const handleMessage = useCallback((e: MessageEvent) => {
    if (e.data?.type === "youeye-embed-ready" || e.data?.type === "youeye-embed-resize") {
      setEmbedReady(true);
      sendThemeToEmbed();
    }
    if (e.data?.type === "youeye-embed-resize" && typeof e.data.height === "number") {
      setEmbedHeight(Math.max(e.data.height, 100));
    }
    if (e.data?.type === "youeye-profile-updated") {
      // Name was changed in the CP embed — update local DB and display
      const newName = [e.data.firstName, e.data.lastName].filter(Boolean).join(" ");
      if (newName) setDisplayName(newName);

      // Sync firstName/lastName to UI's local DB so it persists across SSO re-login
      fetch("/api/v1/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: e.data.firstName || null,
          lastName: e.data.lastName || null,
        }),
      }).catch(() => {});
    }
  }, [sendThemeToEmbed]);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // Propagate theme changes to embed
  useEffect(() => {
    if (embedReady) sendThemeToEmbed();
  }, [resolvedTheme, embedReady, sendThemeToEmbed]);

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const res = await fetch("/api/v1/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setAvatarUploading(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/v1/user/avatar", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Avatar upload failed");
        return;
      }

      const bustUrl = data.url + "?t=" + Date.now();
      setAvatarUrl(bustUrl);
      window.dispatchEvent(new CustomEvent("avatar-updated", { detail: { url: bustUrl } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Avatar upload failed");
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleAvatarRemove = async () => {
    try {
      const res = await fetch("/api/v1/user/avatar", { method: "DELETE" });
      if (res.ok) {
        setAvatarUrl(null);
        window.dispatchEvent(new CustomEvent("avatar-updated", { detail: { url: null } }));
      }
    } catch {
      // Ignore
    }
  };

  const handlePresetSelect = async (preset: AvatarPreset) => {
    setAvatarUploading(true);
    setError("");
    try {
      const blob = await renderPresetToBlob(preset.emoji, preset.bg);
      const formData = new FormData();
      formData.append("file", blob, "avatar.png");

      const res = await fetch("/api/v1/user/avatar", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");

      const bustUrl = data.url + "?t=" + Date.now();
      setAvatarUrl(bustUrl);
      setShowPicker(false);
      window.dispatchEvent(new CustomEvent("avatar-updated", { detail: { url: bustUrl } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set avatar");
    } finally {
      setAvatarUploading(false);
    }
  };

  const initials = (displayName || username || "?")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  const timezones = (() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Europe/Moscow", "Asia/Tokyo", "Asia/Shanghai", "Australia/Sydney"];
    }
  })();

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div>
          <div className="h-6 w-48 bg-muted rounded" />
          <div className="h-4 w-64 bg-muted rounded mt-2" />
        </div>
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-muted" />
          <div className="space-y-2">
            <div className="h-4 w-32 bg-muted rounded" />
            <div className="h-3 w-20 bg-muted rounded" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("title")}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t("description")}
        </p>
      </div>

      {/* Avatar */}
      <div className="space-y-3">
        <div className="flex items-center gap-4">
          <div className="relative">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt="Avatar"
                className="w-16 h-16 rounded-full object-cover"
              />
            ) : (
              <div className="w-16 h-16 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-lg font-semibold">
                {initials}
              </div>
            )}
            {avatarUploading && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-full">
                <Loader2 className="w-5 h-5 text-white animate-spin" />
              </div>
            )}
          </div>

          <div>
            <p className="font-medium">{displayName || username}</p>
            <p className="text-sm text-muted-foreground">
              {isAdmin ? t("administrator") : t("user")}
            </p>
          </div>
        </div>

        {/* Avatar action buttons */}
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-input bg-background hover:bg-accent cursor-pointer transition-colors">
            <Upload className="w-3.5 h-3.5" />
            {t("avatarUpload")}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleAvatarUpload}
              disabled={avatarUploading}
            />
          </label>
          <button
            onClick={() => setShowPicker(!showPicker)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
              showPicker
                ? "border-primary bg-primary/10 text-primary"
                : "border-input bg-background hover:bg-accent"
            }`}
            disabled={avatarUploading}
          >
            {showPicker ? <X className="w-3.5 h-3.5" /> : <Smile className="w-3.5 h-3.5" />}
            {showPicker ? t("avatarPickerClose") : t("avatarPickerOpen")}
          </button>
          {avatarUrl && (
            <button
              onClick={handleAvatarRemove}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-input bg-background hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors"
              disabled={avatarUploading}
            >
              {t("avatarRemove")}
            </button>
          )}
        </div>

        {/* Template avatar picker */}
        {showPicker && (
          <div className="p-3 border border-border rounded-lg bg-muted/30">
            <p className="text-xs text-muted-foreground mb-2">{t("avatarPickerHint")}</p>
            <div className="grid grid-cols-8 gap-2">
              {AVATAR_PRESETS.map((preset, i) => (
                <button
                  key={i}
                  onClick={() => handlePresetSelect(preset)}
                  disabled={avatarUploading}
                  className="w-10 h-10 rounded-full flex items-center justify-center text-lg hover:scale-110 hover:ring-2 hover:ring-primary/50 transition-transform disabled:opacity-50"
                  style={{
                    background: `linear-gradient(135deg, ${preset.bg[0]}, ${preset.bg[1]})`,
                  }}
                  title={preset.emoji}
                >
                  {preset.emoji}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Account Name — CP embed (synced to Authentik) */}
      <div className="max-w-lg">
        <div className="relative">
          {!embedReady && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg border border-border bg-background" style={{ minHeight: 100 }}>
              <div className="space-y-3 w-full max-w-md px-8">
                <div className="h-4 w-3/4 rounded bg-muted animate-pulse" />
                <div className="h-4 w-full rounded bg-muted animate-pulse" />
              </div>
            </div>
          )}
          <iframe
            ref={embedRef}
            src={profileEmbedUrl}
            title="Account Name"
            sandbox="allow-scripts allow-same-origin allow-forms"
            style={{
              width: "100%",
              height: embedHeight,
              border: "none",
              borderRadius: 8,
              opacity: embedReady ? 1 : 0,
              transition: "opacity 0.2s ease",
            }}
          />
        </div>
      </div>

      {/* Local fields: bio, timezone */}
      <div className="space-y-4 max-w-lg">
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <FileText className="w-4 h-4" />
            {t("bio")}
          </label>
          <textarea
            value={profile.bio}
            onChange={(e) => setProfile({ ...profile, bio: e.target.value })}
            className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[80px] resize-y"
            placeholder={t("bioPlaceholder")}
            rows={3}
          />
        </div>

        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <MapPin className="w-4 h-4" />
            {t("timezone")}
          </label>
          <select
            value={profile.timezone}
            onChange={(e) => setProfile({ ...profile, timezone: e.target.value })}
            className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {timezones.map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </select>
        </div>

        {/* Save button (bio & timezone) */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {t("save")}
          </button>
          {saved && (
            <span className="text-sm text-green-600">{t("saved")}</span>
          )}
          {error && (
            <span className="text-sm text-destructive">{error}</span>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          {t("userId")}: {userId}
        </p>
      </div>
    </div>
  );
}
