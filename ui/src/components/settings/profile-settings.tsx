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
import { Save, Loader2, MapPin, FileText } from "lucide-react";

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
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
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

  // Listen for profile updates from the CP embed
  const handleMessage = useCallback((e: MessageEvent) => {
    if (e.data?.type === "youeye-embed-ready" || e.data?.type === "youeye-embed-resize") {
      setEmbedReady(true);
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
  }, []);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

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

      setAvatarUrl(data.url + "?t=" + Date.now());
      window.dispatchEvent(new CustomEvent("avatar-updated", { detail: { url: data.url } }));
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
      <div className="flex items-center gap-4">
        <div className="relative group">
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
          <label className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer">
            <span className="text-xs text-white font-medium">
              {avatarUploading ? "..." : t("avatarEdit")}
            </span>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleAvatarUpload}
              disabled={avatarUploading}
            />
          </label>
        </div>

        <div>
          <p className="font-medium">{displayName || username}</p>
          <p className="text-sm text-muted-foreground">
            {isAdmin ? t("administrator") : t("user")}
          </p>
          {avatarUrl && (
            <button
              onClick={handleAvatarRemove}
              className="text-xs text-destructive hover:underline mt-1"
            >
              Remove avatar
            </button>
          )}
        </div>
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
