"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { uiSettingsApi } from "./api-base";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

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

const FIELD_LABEL = "text-[13px] font-medium text-muted-foreground";
// Native controls (textarea / 400-item timezone select) styled to the shadcn Input recipe.
const NATIVE_CONTROL =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";

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
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { url?: string | null } | undefined;
      setAvatarUrl(detail?.url || null);
    };
    window.addEventListener("avatar-updated", handler);
    return () => window.removeEventListener("avatar-updated", handler);
  }, []);

  const fullName = useMemo(
    () => [firstName, lastName].filter(Boolean).join(" ") || account?.username || name || username,
    [firstName, lastName, account?.username, name, username]
  );

  const initials = useMemo(() => {
    const source = [firstName, lastName].filter(Boolean).join(" ") || name || username || "?";
    return source
      .split(" ")
      .map((part) => part[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
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
      <div className="space-y-6">
        <div>
          <div className="h-7 w-40 animate-pulse rounded bg-muted" />
          <div className="mt-2 h-4 w-56 animate-pulse rounded bg-muted" />
        </div>
        <Card className="gap-0 py-0">
          <div className="flex items-center gap-4 p-5">
            <div className="size-16 animate-pulse rounded-full bg-muted" />
            <div className="space-y-2">
              <div className="h-4 w-32 animate-pulse rounded bg-muted" />
              <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </Card>
        <Card className="gap-0 py-0">
          <div className="space-y-4 p-5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-9 w-full animate-pulse rounded bg-muted" />
            ))}
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Profile</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your account on this server</p>
      </div>

      {/* Identity card */}
      <Card className="gap-0 py-0">
        <div className="flex items-center gap-4 p-5">
          <div className="relative">
            <Avatar className="size-16">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt="" className="object-cover" /> : null}
              <AvatarFallback className="bg-primary text-lg font-semibold text-primary-foreground">
                {initials}
              </AvatarFallback>
            </Avatar>
            {avatarUploading && (
              <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50">
                <Loader2 className="size-5 animate-spin text-white" />
              </div>
            )}
          </div>
          <div className="min-w-0">
            <p className="truncate text-[17px] font-bold leading-tight">{fullName}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{isAdmin ? "Administrator" : "User"}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={avatarUploading}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="size-4" /> Change photo
            </Button>
            {avatarUrl && (
              <Button type="button" variant="ghost" size="sm" disabled={avatarUploading} onClick={removeAvatar}>
                Remove
              </Button>
            )}
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
          </div>
        </div>
      </Card>

      {/* Details card */}
      <Card className="gap-0 py-0">
        <div className="space-y-4 p-5">
          <h2 className="text-[15px] font-semibold">Details</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className={FIELD_LABEL}>First name</span>
              <Input value={firstName} onChange={(event) => setFirstName(event.target.value)} />
            </label>
            <label className="block space-y-1.5">
              <span className={FIELD_LABEL}>Last name</span>
              <Input value={lastName} onChange={(event) => setLastName(event.target.value)} />
            </label>
          </div>

          <label className="block space-y-1.5">
            <span className={FIELD_LABEL}>Username</span>
            <Input value={account?.username || username} disabled className="bg-muted text-muted-foreground" />
          </label>

          <label className="block space-y-1.5">
            <span className={FIELD_LABEL}>Email</span>
            <Input
              value={account?.email || email || ""}
              disabled
              placeholder="—"
              className="bg-muted text-muted-foreground"
            />
          </label>

          <label className="block space-y-1.5">
            <span className={FIELD_LABEL}>Bio</span>
            <textarea
              value={local.bio}
              onChange={(event) => setLocal((current) => ({ ...current, bio: event.target.value }))}
              rows={3}
              placeholder="A line about you (shown on your profile)"
              className={cn(NATIVE_CONTROL, "min-h-20 resize-y")}
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className={FIELD_LABEL}>Timezone</span>
              <select
                value={local.timezone}
                onChange={(event) => setLocal((current) => ({ ...current, timezone: event.target.value }))}
                className={cn(NATIVE_CONTROL, "h-9 py-1")}
              >
                {timezones.map((timezone) => (
                  <option key={timezone} value={timezone}>
                    {timezone}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              Save changes
            </Button>
            {saved && <span className="text-sm text-green-600 dark:text-green-500">Saved</span>}
            {error && <span className="text-sm text-destructive">{error}</span>}
          </div>

          <p className="text-xs text-muted-foreground">User ID: {local.userId || userId || "—"}</p>
        </div>
      </Card>
    </div>
  );
}
