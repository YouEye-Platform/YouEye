"use client";

import { PageHeader } from "./page-header";

import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { KeyRound, Loader2, Shapes, Upload, X } from "lucide-react";
import { uiSettingsApi } from "./api-base";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ProfileIconPicker } from "./profile-icon-picker";
import { IDENTITY_PASSWORD_MAX_LENGTH, IDENTITY_PASSWORD_MIN_LENGTH, validateIdentityPassword } from "@/lib/identity/password-policy";
import { useRef as useInterfaceTranslationRef } from "react";

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
  const translateInterface = useInterfaceTranslations("interface");
  const interfaceTranslationRef = useInterfaceTranslationRef(translateInterface);
  interfaceTranslationRef.current = translateInterface;

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
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [everywhereOpen, setEverywhereOpen] = useState(false);
  const [everywherePassword, setEverywherePassword] = useState("");
  const [everywhereBusy, setEverywhereBusy] = useState(false);
  const [everywhereError, setEverywhereError] = useState("");
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
        if (!cancelled) setError(interfaceTranslationRef.current("m92907d8c7089"));
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
      if (!accountRes.ok) throw new Error((await accountRes.json().catch(() => ({}))).error || translateInterface("maf651c36a34f"));
      if (!localRes.ok) throw new Error((await localRes.json().catch(() => ({}))).error || translateInterface("m75eb4fadd0bd"));
      const updated = await accountRes.json();
      setAccount(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(translateInterface("m53ad6f999b1f"));
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
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || translateInterface("m41350c4cfc97"));
      setAvatarUrl(preview);
      broadcastAvatarUpdate(preview);
    } catch (err) {
      setError(translateInterface("m41350c4cfc97"));
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
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || translateInterface("m551cf24672df"));
      setAvatarUrl(null);
      broadcastAvatarUpdate(null);
    } catch (err) {
      setError(translateInterface("m551cf24672df"));
    } finally {
      setAvatarUploading(false);
    }
  }

  async function choosePreset(presetId: string) {
    setSelectedPreset(presetId);
    setAvatarUploading(true);
    setError("");
    try {
      const res = await fetch("/api/user/avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presetId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || translateInterface("m211280022dea"));
      if (body.url) {
        setAvatarUrl(body.url);
        broadcastAvatarUpdate(body.url);
      }
      setIconPickerOpen(false);
    } catch (err) {
      setError(translateInterface("m211280022dea"));
    } finally {
      setAvatarUploading(false);
    }
  }

  function resetPasswordForm() {
    setCurrentPassword("");
    setNewPassword("");
    setRepeatPassword("");
    setPasswordError("");
  }

  async function changePassword() {
    setPasswordError("");
    setPasswordMessage("");
    const policyError = validateIdentityPassword(newPassword);
    if (policyError) return setPasswordError(policyError);
    if (newPassword !== repeatPassword) return setPasswordError(translateInterface("mb6eb82cd3300"));
    setPasswordBusy(true);
    try {
      const csrfRes = await fetch("/settings/api/auth/csrf", { cache: "no-store" });
      const csrfBody = await csrfRes.json().catch(() => ({}));
      if (!csrfRes.ok || !csrfBody.csrfToken) throw new Error(translateInterface("mfdd8ed13bfe2"));
      const res = await fetch("/settings/api/user/password", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfBody.csrfToken },
        body: JSON.stringify({ currentPassword, newPassword, repeatPassword }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || translateInterface("m79a493be1607"));
      resetPasswordForm();
      setPasswordOpen(false);
      setPasswordMessage(translateInterface("me86128d643be"));
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : translateInterface("m79a493be1607"));
    } finally {
      setPasswordBusy(false);
    }
  }

  async function signOutEverywhere() {
    setEverywhereBusy(true);
    setEverywhereError("");
    try {
      const csrfRes = await fetch("/settings/api/auth/csrf", { cache: "no-store" });
      const csrf = await csrfRes.json().catch(() => ({}));
      if (!csrfRes.ok || !csrf.csrfToken) throw new Error(translateInterface("mfdd8ed13bfe2"));
      const res = await fetch("/settings/api/identity/sign-out-everywhere", {
        method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.csrfToken },
        body: JSON.stringify({ password: everywherePassword }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || translateInterface("m84fdb64b9bb0"));
      window.location.assign("/settings/login");
    } catch (error) {
      setEverywhereError(error instanceof Error ? error.message : translateInterface("m84fdb64b9bb0"));
      setEverywhereBusy(false);
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
      <PageHeader title={translateInterface("md696a35bdd18")} description={translateInterface("mb127e1008b08")} />

      {/* Identity card */}
      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center gap-4 p-5">
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
          <div className="min-w-0 flex-1">
            <p className="truncate text-[17px] font-bold leading-tight">{fullName}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{isAdmin ? translateInterface("me7d3e769f3f5") : translateInterface("mb512d97e7cbf")}</p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={avatarUploading}
              onClick={() => setIconPickerOpen(true)}
            >
              <Shapes className="size-4" /> {translateInterface("m1ae4fec7b2da")}</Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={avatarUploading}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="size-4" /> {translateInterface("m32258ba63e80")}</Button>
            {avatarUrl && (
              <Button type="button" variant="ghost" size="sm" disabled={avatarUploading} onClick={removeAvatar}>
                {translateInterface("mc3812fc4acb8")}</Button>
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

      {iconPickerOpen && (
        <Card className="p-5">
          <ProfileIconPicker selectedId={selectedPreset} busy={avatarUploading} onChoose={choosePreset} onClose={() => setIconPickerOpen(false)} />
        </Card>
      )}

      {/* Details card */}
      <Card className="gap-0 py-0">
        <div className="space-y-4 p-5">
          <h2 className="text-[15px] font-semibold">{translateInterface("m45989de49fb7")}</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className={FIELD_LABEL}>{translateInterface("m702ef921ed1d")}</span>
              <Input value={firstName} onChange={(event) => setFirstName(event.target.value)} />
            </label>
            <label className="block space-y-1.5">
              <span className={FIELD_LABEL}>{translateInterface("m7b4888049459")}</span>
              <Input value={lastName} onChange={(event) => setLastName(event.target.value)} />
            </label>
          </div>

          <label className="block space-y-1.5">
            <span className={FIELD_LABEL}>{translateInterface("me3b89e9d33f8")}</span>
            <Input value={account?.username || username} disabled className="bg-muted text-muted-foreground" />
          </label>

          <label className="block space-y-1.5">
            <span className={FIELD_LABEL}>{translateInterface("m969ccbd3cf63")}</span>
            <Input
              value={account?.email || email || ""}
              disabled
              placeholder="—"
              className="bg-muted text-muted-foreground"
            />
          </label>

          <label className="block space-y-1.5">
            <span className={FIELD_LABEL}>{translateInterface("m3933b1802161")}</span>
            <textarea
              value={local.bio}
              onChange={(event) => setLocal((current) => ({ ...current, bio: event.target.value }))}
              rows={3}
              placeholder={translateInterface("m05502c5ded28")}
              className={cn(NATIVE_CONTROL, "min-h-20 resize-y")}
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className={FIELD_LABEL}>{translateInterface("m4ceca1d52ced")}</span>
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
              {translateInterface("mdd0ae7a5cbcf")}</Button>
            {saved && <span className="text-sm text-green-600 dark:text-green-500">{translateInterface("mb5c120b316c2")}</span>}
            {error && <span className="text-sm text-destructive">{error}</span>}
          </div>

          <p className="text-xs text-muted-foreground">{translateInterface("m2dbd28b1ad53")}{local.userId || userId || "—"}</p>
        </div>
      </Card>

      <Card className="gap-0 py-0">
        <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-[15px] font-semibold"><KeyRound className="size-4" /> {translateInterface("m8f6fb4eb7f42")}</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">{translateInterface("m65176f60cb2b")}</p>
          </div>
          <Button type="button" variant="outline" onClick={() => { resetPasswordForm(); setPasswordOpen(true); }}>{translateInterface("m3f9c991f63a9")}</Button>
        </div>
        <div className="flex flex-col gap-3 border-t p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold">{translateInterface("maf180fca9025")}</h3>
            <p className="mt-1 text-[13px] text-muted-foreground">{translateInterface("m3f467574a62d")}</p>
          </div>
          <Button type="button" variant="outline" onClick={() => { setEverywherePassword(""); setEverywhereError(""); setEverywhereOpen(true); }}>{translateInterface("maf180fca9025")}</Button>
        </div>
        {passwordMessage && <p className="border-t px-5 py-3 text-sm text-primary">{passwordMessage}</p>}
      </Card>

      {everywhereOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md space-y-4 rounded-xl border bg-card p-5 shadow-lg" role="dialog" aria-modal="true" aria-labelledby="sign-out-everywhere-title">
            <h3 id="sign-out-everywhere-title" className="text-lg font-semibold">{translateInterface("mbb01934e466b")}</h3>
            <p className="text-sm text-muted-foreground">{translateInterface("mb6fa5869d488")}</p>
            <label className="block space-y-1.5"><span className={FIELD_LABEL}>{translateInterface("m72ed2bd767ce")}</span><Input type="password" autoComplete="current-password" value={everywherePassword} onChange={event => setEverywherePassword(event.target.value)} disabled={everywhereBusy} /></label>
            {everywhereError && <p className="text-sm text-destructive">{everywhereError}</p>}
            <div className="flex justify-end gap-2"><Button variant="outline" disabled={everywhereBusy} onClick={() => setEverywhereOpen(false)}>{translateInterface("m19766ed6ccb2")}</Button><Button disabled={everywhereBusy || !everywherePassword} onClick={() => void signOutEverywhere()}>{everywhereBusy && <Loader2 className="size-4 animate-spin" />} {" "}{translateInterface("maf180fca9025")}</Button></div>
          </div>
        </div>
      )}

      {passwordOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md space-y-4 rounded-xl border bg-card p-5 shadow-lg" role="dialog" aria-modal="true" aria-labelledby="change-password-title">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 id="change-password-title" className="text-[19px] font-semibold">{translateInterface("m3f9c991f63a9")}</h3>
                <p className="mt-1 text-[13px] text-muted-foreground">{translateInterface("me0673a903b84")}</p>
              </div>
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => setPasswordOpen(false)} disabled={passwordBusy} aria-label={translateInterface("m7d9eb7acb13e")}><X className="size-4" /></Button>
            </div>
            <label className="block space-y-1.5">
              <span className={FIELD_LABEL}>{translateInterface("m72ed2bd767ce")}</span>
              <Input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} disabled={passwordBusy} />
            </label>
            <label className="block space-y-1.5">
              <span className={FIELD_LABEL}>{translateInterface("m3dd9df4441fb")}</span>
              <Input type="password" autoComplete="new-password" minLength={IDENTITY_PASSWORD_MIN_LENGTH} maxLength={IDENTITY_PASSWORD_MAX_LENGTH} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} disabled={passwordBusy} />
            </label>
            <label className="block space-y-1.5">
              <span className={FIELD_LABEL}>{translateInterface("m0c89ec93844f")}</span>
              <Input type="password" autoComplete="new-password" minLength={IDENTITY_PASSWORD_MIN_LENGTH} maxLength={IDENTITY_PASSWORD_MAX_LENGTH} value={repeatPassword} onChange={(event) => setRepeatPassword(event.target.value)} disabled={passwordBusy} />
            </label>
            {passwordError && <p className="text-sm text-destructive">{passwordError}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setPasswordOpen(false)} disabled={passwordBusy}>{translateInterface("m19766ed6ccb2")}</Button>
              <Button type="button" onClick={changePassword} disabled={passwordBusy || !currentPassword || !newPassword || !repeatPassword}>
                {passwordBusy && <Loader2 className="size-4 animate-spin" />} {" "}{translateInterface("m3f9c991f63a9")}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
