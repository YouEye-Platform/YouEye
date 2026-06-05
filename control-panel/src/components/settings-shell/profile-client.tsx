"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Loader2, MapPin, Save } from "lucide-react";
import { uiSettingsApi } from "./api-base";

interface ProfileClientProps {
  userId?: string;
  username: string;
  name: string;
  email: string;
  isAdmin: boolean;
}

interface AccountProfile {
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  avatarUrl?: string | null;
}

interface LocalProfile {
  userId?: string;
  bio: string;
  timezone: string;
  image?: string | null;
}

function broadcastAvatarUpdate(url: string | null) {
  window.dispatchEvent(new CustomEvent("avatar-updated", { detail: { url } }));
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

export function ProfileClient({ userId, username, name, email, isAdmin }: ProfileClientProps) {
  const [account, setAccount] = useState<AccountProfile | null>(null);
  const [local, setLocal] = useState<LocalProfile>({
    bio: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [avatarUploading, setAvatarUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [accountRes, localRes] = await Promise.all([
          fetch("/api/user/profile"),
          fetch(uiSettingsApi("profile")),
        ]);
        const accountData = accountRes.ok ? await accountRes.json() : null;
        const localData = localRes.ok ? await localRes.json() : null;
        if (cancelled) return;
        if (accountData) {
          setAccount(accountData);
          setFirstName(accountData.firstName || "");
          setLastName(accountData.lastName || "");
          setAvatarUrl(accountData.avatarUrl || localData?.image || null);
        }
        if (localData) {
          setLocal({
            userId: localData.userId,
            bio: localData.bio || "",
            timezone: localData.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
            image: localData.image || null,
          });
          if (!accountData?.avatarUrl) setAvatarUrl(localData.image || null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load profile");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { url?: string | null } | undefined;
      setAvatarUrl(detail?.url || null);
    };
    window.addEventListener("avatar-updated", handler);
    return () => window.removeEventListener("avatar-updated", handler);
  }, []);

  const initials = useMemo(() => {
    const source = [firstName, lastName].filter(Boolean).join(" ") || name || username || "?";
    return source.split(" ").map((part) => part[0]).join("").toUpperCase().slice(0, 2);
  }, [firstName, lastName, name, username]);

  const timezones = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return ["UTC", "America/New_York", "Europe/London", "Europe/Berlin", "Asia/Tokyo", "Australia/Sydney"];
    }
  }, []);

  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const [accountRes, localRes] = await Promise.all([
        fetch("/api/user/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim() }),
        }),
        fetch(uiSettingsApi("profile"), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bio: local.bio, timezone: local.timezone }),
        }),
      ]);
      if (!accountRes.ok) throw new Error((await accountRes.json().catch(() => ({}))).error || "Account save failed");
      if (!localRes.ok) throw new Error((await localRes.json().catch(() => ({}))).error || "Profile save failed");
      const updated = await accountRes.json();
      setAccount(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function uploadAvatar(file: File) {
    setAvatarUploading(true);
    setError("");
    try {
      const preview = await readAsDataUrl(file);
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/user/avatar", { method: "POST", body: formData });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Avatar upload failed");
      setAvatarUrl(preview);
      broadcastAvatarUpdate(preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Avatar upload failed");
    } finally {
      setAvatarUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function removeAvatar() {
    setAvatarUploading(true);
    setError("");
    try {
      const res = await fetch("/api/user/avatar", { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Avatar removal failed");
      setAvatarUrl(null);
      broadcastAvatarUpdate(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Avatar removal failed");
    } finally {
      setAvatarUploading(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div>
          <div className="h-6 w-48 rounded bg-muted" />
          <div className="mt-2 h-4 w-64 rounded bg-muted" />
        </div>
        <div className="flex items-center gap-4">
          <div className="h-16 w-16 rounded-full bg-muted" />
          <div className="space-y-2">
            <div className="h-4 w-32 rounded bg-muted" />
            <div className="h-3 w-20 rounded bg-muted" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Profile</h2>
        <p className="mt-1 text-sm text-muted-foreground">Manage your account name, avatar, bio, and timezone.</p>
      </div>

      <div className="flex max-w-lg items-center gap-4">
        <div className="relative">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="Avatar" className="h-16 w-16 rounded-full object-cover" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary text-lg font-semibold text-primary-foreground">
              {initials}
            </div>
          )}
          {avatarUploading && (
            <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50">
              <Loader2 className="h-5 w-5 animate-spin text-white" />
            </div>
          )}
        </div>
        <div className="min-w-0">
          <p className="font-medium">{[firstName, lastName].filter(Boolean).join(" ") || account?.username || username}</p>
          <p className="text-sm text-muted-foreground">{isAdmin ? "Administrator" : "User"}</p>
          <div className="mt-1 flex gap-3 text-xs">
            <label className="cursor-pointer text-primary hover:underline">
              Change avatar
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                disabled={avatarUploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) uploadAvatar(file);
                }}
              />
            </label>
            {avatarUrl && (
              <button type="button" onClick={removeAvatar} disabled={avatarUploading} className="text-destructive hover:underline">
                Remove
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-lg space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <label className="space-y-1.5 text-sm">
            <span className="font-medium text-muted-foreground">First name</span>
            <input value={firstName} onChange={(event) => setFirstName(event.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="font-medium text-muted-foreground">Last name</span>
            <input value={lastName} onChange={(event) => setLastName(event.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          </label>
        </div>

        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-muted-foreground">Username</span>
          <div className="rounded-md bg-muted px-3 py-2 text-sm">{account?.username || username}</div>
        </label>

        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-muted-foreground">Email</span>
          <div className="rounded-md bg-muted px-3 py-2 text-sm">{account?.email || email || "—"}</div>
        </label>

        <label className="block space-y-1.5 text-sm">
          <span className="flex items-center gap-2 font-medium text-muted-foreground"><FileText className="h-4 w-4" /> Bio</span>
          <textarea value={local.bio} onChange={(event) => setLocal((current) => ({ ...current, bio: event.target.value }))} rows={3} className="min-h-20 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </label>

        <label className="block space-y-1.5 text-sm">
          <span className="flex items-center gap-2 font-medium text-muted-foreground"><MapPin className="h-4 w-4" /> Timezone</span>
          <select value={local.timezone} onChange={(event) => setLocal((current) => ({ ...current, timezone: event.target.value }))} className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
            {timezones.map((timezone) => <option key={timezone} value={timezone}>{timezone}</option>)}
          </select>
        </label>

        <div className="flex items-center gap-3">
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save
          </button>
          {saved && <span className="text-sm text-green-600">Saved</span>}
          {error && <span className="text-sm text-destructive">{error}</span>}
        </div>

        <p className="text-xs text-muted-foreground">User ID: {local.userId || userId || "—"}</p>
      </div>
    </div>
  );
}
