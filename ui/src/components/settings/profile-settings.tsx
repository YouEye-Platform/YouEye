/**
 * Profile Settings
 *
 * Account name and avatar are handled by the CP embed (synced to Authentik).
 * Bio and timezone are UI-local fields.
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
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
  const { resolvedTheme } = useTheme();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [displayName, setDisplayName] = useState(name);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
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
        const fullName = [data.firstName, data.lastName].filter(Boolean).join(" ");
        if (fullName) setDisplayName(fullName);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Send current theme + avatar to embed iframe
  const sendThemeToEmbed = useCallback(() => {
    if (!embedRef.current?.contentWindow || !resolvedTheme) return;
    const origin = (() => { try { return new URL(profileEmbedUrl).origin; } catch { return "*"; } })();
    embedRef.current.contentWindow.postMessage(
      { type: "youeye-embed-theme", theme: resolvedTheme },
      origin
    );
    // Also send the current avatar URL so the embed can display it
    // even if Authentik doesn't have the avatar synced yet
    if (avatarUrl) {
      embedRef.current.contentWindow.postMessage(
        { type: "youeye-embed-avatar", avatarUrl },
        origin
      );
    }
  }, [resolvedTheme, profileEmbedUrl, avatarUrl]);

  // Listen for updates from the CP embed
  const handleMessage = useCallback((e: MessageEvent) => {
    if (e.data?.type === "youeye-embed-ready" || e.data?.type === "youeye-embed-resize") {
      setEmbedReady(true);
      sendThemeToEmbed();
    }
    if (e.data?.type === "youeye-embed-resize" && typeof e.data.height === "number") {
      setEmbedHeight(Math.max(e.data.height, 100));
    }
    if (e.data?.type === "youeye-profile-updated") {
      const newName = [e.data.firstName, e.data.lastName].filter(Boolean).join(" ");
      if (newName) setDisplayName(newName);

      fetch("/api/v1/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: e.data.firstName || null,
          lastName: e.data.lastName || null,
        }),
      })
        .then(() => {
          if (newName) {
            window.dispatchEvent(new CustomEvent("name-updated", { detail: { name: newName } }));
          }
        })
        .catch((err) => console.warn("[profile] Name sync failed:", err));
    }
    if (e.data?.type === "youeye-avatar-updated") {
      if (e.data.dataUrl) {
        // CP embed uploaded avatar — update browser state immediately.
        // Server-side persistence is handled by CP→UI bridge push.
        // Client-side upload is a fallback in case the bridge push hasn't landed yet.
        setAvatarUrl(e.data.dataUrl);
        window.dispatchEvent(new CustomEvent("avatar-updated", { detail: { url: e.data.dataUrl } }));

        fetch(e.data.dataUrl)
          .then((r) => r.blob())
          .then((blob) => {
            const formData = new FormData();
            formData.append("file", blob, "avatar.png");
            return fetch("/api/v1/user/avatar", { method: "POST", body: formData });
          })
          .then((r) => {
            if (r && !r.ok) console.warn("[avatar] Client-side fallback upload failed:", r.status);
          })
          .catch((err) => console.warn("[avatar] Client-side fallback upload error:", err));
      } else {
        // Avatar removed
        setAvatarUrl(null);
        window.dispatchEvent(new CustomEvent("avatar-updated", { detail: { url: null } }));
        fetch("/api/v1/user/avatar", { method: "DELETE" })
          .catch((err) => console.warn("[avatar] Client-side fallback delete error:", err));
      }
    }
  }, [sendThemeToEmbed]);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

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

      {/* Profile embed — avatar + account name (from CP, synced to Authentik) */}
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
            src={(() => {
              try {
                const url = new URL(profileEmbedUrl);
                if (resolvedTheme) url.searchParams.set("theme", resolvedTheme);
                return url.toString();
              } catch { return profileEmbedUrl; }
            })()}
            title="Profile Settings"
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
