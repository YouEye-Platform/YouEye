"use client";

import { PageHeader } from "./page-header";

import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Loader2, Shapes, Upload, X } from "lucide-react";
import { uiSettingsApi } from "./api-base";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ProfileIconPicker } from "./profile-icon-picker";
import { IDENTITY_PASSWORD_MAX_LENGTH, IDENTITY_PASSWORD_MIN_LENGTH, validateIdentityPassword } from "@/lib/identity/password-policy";
import { useLatestRef } from "@/lib/use-latest-ref";

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
// The native textarea styled to the shadcn Input recipe.
const NATIVE_CONTROL =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";

export function ProfileClient({ userId, username, name, email, isAdmin }: ProfileClientProps) {
  const translateInterface = useInterfaceTranslations("interface");
  const interfaceTranslationRef = useLatestRef(translateInterface);

  const [account, setAccount] = useState<AccountProfile | null>(null);
  const t = useTranslations("settingsYou.profile");
  // The time zone moved to Language & region; it saves through the same profile PATCH, which takes partial bodies.
  const [local, setLocal] = useState<LocalProfile>({ bio: "" });
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
  }, [interfaceTranslationRef]);

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
          body: JSON.stringify({ bio: local.bio }),
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
      <div aria-busy="true">
        <div className="settings-page-header">
          <div className="h-7 w-40 animate-pulse rounded bg-muted" />
          <div className="mt-2 h-4 w-56 animate-pulse rounded bg-muted" />
        </div>
        <div className="settings-sections">
          <div className="settings-profile-head">
            <div className="size-[72px] animate-pulse rounded-full bg-muted" />
            <div className="space-y-2">
              <div className="h-4 w-32 animate-pulse rounded bg-muted" />
              <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            </div>
          </div>
          <div className="settings-group">
            <div className="settings-fields">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-9 w-full animate-pulse rounded bg-muted" />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const shownUsername = account?.username || username;
  const shownEmail = account?.email || email || "";
  const shownUserId = local.userId || userId || "";

  return (
    <div>
      <PageHeader title={translateInterface("md696a35bdd18")} description={translateInterface("mb127e1008b08")} />

      <div className="settings-sections">
        {/* Photo and name */}
        <section className="settings-section" aria-label={t("photoAndName")}>
          <div className="settings-profile-head">
            <div className="relative shrink-0">
              <Avatar className="size-[72px]">
                {avatarUrl ? <AvatarImage src={avatarUrl} alt="" className="object-cover" /> : null}
                <AvatarFallback className="bg-primary text-xl font-semibold text-primary-foreground">
                  {initials}
                </AvatarFallback>
              </Avatar>
              {avatarUploading && (
                <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50">
                  <Loader2 className="size-5 animate-spin text-white" aria-hidden="true" />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1 basis-40">
              <p className="truncate text-xl font-semibold leading-tight tracking-tight">{fullName}</p>
              <p className="mt-0.5 truncate text-sm text-muted-foreground">
                {isAdmin ? translateInterface("me7d3e769f3f5") : translateInterface("mb512d97e7cbf")}
              </p>
            </div>
            <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
              <Button type="button" variant="outline" size="sm" disabled={avatarUploading} onClick={() => fileInputRef.current?.click()}>
                <Upload className="size-4" aria-hidden="true" />{t("uploadPhoto")}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={avatarUploading} aria-expanded={iconPickerOpen} onClick={() => setIconPickerOpen((open) => !open)}>
                <Shapes className="size-4" aria-hidden="true" />{t("chooseIcon")}
              </Button>
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
          {iconPickerOpen && (
            <div className="settings-group p-4">
              <ProfileIconPicker selectedId={selectedPreset} busy={avatarUploading} onChoose={choosePreset} onClose={() => setIconPickerOpen(false)} />
            </div>
          )}
        </section>

        {error && <p role="alert" className="settings-note text-destructive">{error}</p>}

        {/* Details */}
        <section className="settings-section" aria-labelledby="profile-details">
          <h2 id="profile-details" className="settings-section-title">{translateInterface("m45989de49fb7")}</h2>
          <div className="settings-group">
            <div className="settings-fields">
              <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <label className="block min-w-0">
                  <span className="settings-field-label">{translateInterface("m702ef921ed1d")}</span>
                  <Input value={firstName} autoComplete="given-name" onChange={(event) => setFirstName(event.target.value)} />
                </label>
                <label className="block min-w-0">
                  <span className="settings-field-label">{translateInterface("m7b4888049459")}</span>
                  <Input value={lastName} autoComplete="family-name" onChange={(event) => setLastName(event.target.value)} />
                </label>
              </div>
              <label className="block min-w-0">
                <span className="settings-field-label">{translateInterface("m3933b1802161")}</span>
                <textarea
                  value={local.bio}
                  onChange={(event) => setLocal((current) => ({ ...current, bio: event.target.value }))}
                  rows={3}
                  placeholder={translateInterface("m05502c5ded28")}
                  className={cn(NATIVE_CONTROL, "min-h-20 resize-y")}
                />
              </label>
              <div className="flex min-w-0 flex-wrap items-center gap-3">
                <Button onClick={save} disabled={saving}>
                  {saving && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                  {translateInterface("mdd0ae7a5cbcf")}</Button>
                <span role="status" className="min-w-0 text-sm text-green-700 dark:text-green-500">{saved ? translateInterface("mb5c120b316c2") : ""}</span>
              </div>
            </div>
            {/* Set by the server; shown, not editable here. */}
            <div className="settings-item">
              <span className="settings-item-text">
                <span className="settings-item-label">{translateInterface("m969ccbd3cf63")}</span>
              </span>
              <span className="settings-item-value">{shownEmail || t("noEmail")}</span>
            </div>
            <div className="settings-item">
              <span className="settings-item-text">
                <span className="settings-item-label">{translateInterface("me3b89e9d33f8")}</span>
                <span className="settings-item-hint">{t("usernameFixed")}</span>
              </span>
              <span className="settings-item-value">{shownUsername}</span>
            </div>
          </div>
        </section>

        {/* Security */}
        <section className="settings-section" aria-labelledby="profile-security">
          <h2 id="profile-security" className="settings-section-title">{translateInterface("m8f6fb4eb7f42")}</h2>
          <div className="settings-group">
            <button type="button" className="settings-row" aria-haspopup="dialog" onClick={() => { resetPasswordForm(); setPasswordMessage(""); setPasswordOpen(true); }}>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-foreground">{translateInterface("m3f9c991f63a9")}</span>
                <span className="block text-[13px] text-muted-foreground">{translateInterface("m65176f60cb2b")}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
            <button type="button" className="settings-row" aria-haspopup="dialog" onClick={() => { setEverywherePassword(""); setEverywhereError(""); setEverywhereOpen(true); }}>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-foreground">{translateInterface("maf180fca9025")}</span>
                <span className="block text-[13px] text-muted-foreground">{translateInterface("m3f467574a62d")}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          </div>
          <p role="status" className="settings-note empty:hidden">{passwordMessage}</p>
        </section>

        {/* Internal identifiers: folded, for support. */}
        {shownUserId && (
          <details className="settings-details">
            <summary>{t("accountDetails")}</summary>
            <dl className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 px-1 text-[13px] text-muted-foreground">
              <dt>{t("userId")}</dt>
              <dd className="min-w-0 select-all font-mono text-[12.5px] [overflow-wrap:anywhere]">{shownUserId}</dd>
            </dl>
          </details>
        )}
      </div>

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
