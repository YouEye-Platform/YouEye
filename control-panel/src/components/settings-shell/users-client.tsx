"use client";
import {useLocale} from "next-intl";

import { PageHeader } from "./page-header";

import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, RefreshCw, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { IDENTITY_PASSWORD_MAX_LENGTH, IDENTITY_PASSWORD_MIN_LENGTH, validateIdentityPassword } from "@/lib/identity/password-policy";

interface IdentityUser {
  pk?: string | number;
  id?: string | number;
  username: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  is_active: boolean;
  is_superuser: boolean;
  last_login: string | null;
  type?: string;
  path?: string;
}

function userId(user: IdentityUser) {
  return String(user.pk ?? user.id ?? "");
}

function initialsOf(user: IdentityUser) {
  const source = (user.name || user.username || "?").trim();
  return source
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}



export function UsersClient() {
  const translateInterface = useInterfaceTranslations("interface");
  const locale = useLocale();
function lastSeen(iso: string | null): string {
  if (!iso) return translateInterface("mfde96b0ea420");
  const date = new Date(iso), seconds = (date.getTime() - Date.now()) / 1000;
  if (!Number.isFinite(seconds)) return translateInterface("mfde96b0ea420");
  const unit = Math.abs(seconds) < 60 ? "second" : Math.abs(seconds) < 3600 ? "minute" : Math.abs(seconds) < 86400 ? "hour" : "day";
  const time = Math.abs(seconds) < 604800
    ? new Intl.RelativeTimeFormat(locale, {numeric: "auto"}).format(Math.round(seconds / {second:1,minute:60,hour:3600,day:86400}[unit]), unit)
    : new Intl.DateTimeFormat(locale, {dateStyle: "medium"}).format(date);
  return translateInterface("m61e516c22c9a", {time});
}


  const [users, setUsers] = useState<IdentityUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Create ("Add person")
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newFirstName, setNewFirstName] = useState("");
  const [newLastName, setNewLastName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRepeatPassword, setNewRepeatPassword] = useState("");
  const [newRole, setNewRole] = useState<"user" | "admin">("user");
  const [newActive, setNewActive] = useState(true);

  // Manage
  const [manage, setManage] = useState<IdentityUser | null>(null);
  const [mFirstName, setMFirstName] = useState("");
  const [mLastName, setMLastName] = useState("");
  const [mEmail, setMEmail] = useState("");
  const [mAdmin, setMAdmin] = useState(false);
  const [mActive, setMActive] = useState(true);
  const [mPassword, setMPassword] = useState("");
  const [mRepeatPassword, setMRepeatPassword] = useState("");
  const [mBusy, setMBusy] = useState(false);
  const [mError, setMError] = useState("");
  const [deleteArmed, setDeleteArmed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await fetch("/api/apps/identity/users");
    if (res.ok) {
      const data = await res.json();
      setUsers(data.results || data.users || []);
    } else {
      setError((await res.json().catch(() => ({}))).error || translateInterface("m6a8bcb8d2639"));
    }
    setLoading(false);
  }, [translateInterface]);

  useEffect(() => {
    load();
  }, [load]);

  async function mutationHeaders() {
	const response = await fetch("/settings/api/auth/csrf", { cache: "no-store" });
	const body = await response.json();
	if (!response.ok || !body.csrfToken) throw new Error(translateInterface("mfdd8ed13bfe2"));
	return { "Content-Type": "application/json", "X-CSRF-Token": body.csrfToken as string };
  }

  function resetCreateForm() {
    setNewUsername("");
    setNewFirstName("");
    setNewLastName("");
    setNewEmail("");
    setNewPassword("");
    setNewRepeatPassword("");
    setNewRole("user");
    setNewActive(true);
    setCreateError("");
  }

  async function createUser() {
    const username = newUsername.trim();
    const firstName = newFirstName.trim();
    const lastName = newLastName.trim();
    const email = newEmail.trim();
    setCreateError("");
    if (!firstName || !username || !email || !newPassword || !newRepeatPassword) {
      setCreateError(translateInterface("mcc5ab5d937ad"));
      return;
    }
	if (newPassword !== newRepeatPassword) {
	  setCreateError(translateInterface("mb6eb82cd3300"));
	  return;
	}
	const passwordError = validateIdentityPassword(newPassword);
	if (passwordError) {
	  setCreateError(passwordError);
	  return;
	}
    setCreating(true);
    try {
	  const headers = await mutationHeaders();
      const res = await fetch("/api/apps/identity/users", {
		method: "POST",
		headers,
        body: JSON.stringify({ username, firstName, lastName, email, password: newPassword, repeatPassword: newRepeatPassword, is_active: newActive, isAdmin: newRole === "admin" }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || translateInterface("m384bef0cb927"));
      setCreateOpen(false);
      resetCreateForm();
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : translateInterface("m384bef0cb927"));
    } finally {
      setCreating(false);
    }
  }

  function openManage(user: IdentityUser) {
    setManage(user);
    setMFirstName(user.firstName || user.name?.split(" ")[0] || "");
    setMLastName(user.lastName || "");
    setMEmail(user.email || "");
    setMAdmin(user.is_superuser);
    setMActive(user.is_active);
    setMPassword("");
    setMRepeatPassword("");
    setMError("");
    setDeleteArmed(false);
  }

  async function saveManage() {
    if (!manage) return;
    setMBusy(true);
    setMError("");
	if (mPassword) {
	  if (mPassword !== mRepeatPassword) {
		setMError(translateInterface("mb6eb82cd3300"));
		setMBusy(false);
		return;
	  }
	  const passwordError = validateIdentityPassword(mPassword);
	  if (passwordError) {
		setMError(passwordError);
		setMBusy(false);
		return;
	  }
	}
    try {
	  const headers = await mutationHeaders();
      const res = await fetch(`/api/apps/identity/users/${userId(manage)}`, {
		method: "PATCH",
		headers,
        body: JSON.stringify({ firstName: mFirstName.trim(), lastName: mLastName.trim(), email: mEmail.trim(), is_active: mActive, is_superuser: mAdmin }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || translateInterface("m53ad6f999b1f"));
      if (mPassword) {
        const pr = await fetch(`/api/apps/identity/users/${userId(manage)}/password`, {
          method: "POST",
		  headers,
          body: JSON.stringify({ password: mPassword, repeatPassword: mRepeatPassword }),
        });
        if (!pr.ok) throw new Error((await pr.json().catch(() => ({}))).error || translateInterface("m4ac76c52df40"));
      }
      setManage(null);
      await load();
    } catch (err) {
      setMError(err instanceof Error ? err.message : translateInterface("m53ad6f999b1f"));
    } finally {
      setMBusy(false);
    }
  }

  async function removeManaged() {
    if (!manage) return;
    setMBusy(true);
    setMError("");
    try {
	  const headers = await mutationHeaders();
	  const res = await fetch(`/api/apps/identity/users/${userId(manage)}`, { method: "DELETE", headers });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || translateInterface("m7a91db72b733"));
      setManage(null);
      await load();
    } catch (err) {
      setMError(err instanceof Error ? err.message : translateInterface("m7a91db72b733"));
    } finally {
      setMBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title={translateInterface("m7db20897053b")} description={translateInterface("m802f5286af98")} />

      {/* People list */}
      <Card className="gap-0 py-0">
        <div className="flex items-center justify-between gap-4 border-b p-4">
          <h2 className="text-[15px] font-semibold">{loading ? translateInterface("m7db20897053b") : translateInterface("peopleCount", {count: users.length})}</h2>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon-sm" onClick={load} aria-label={translateInterface("m0e9161011702")}>
              <RefreshCw className="size-4" />
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> {" "}{translateInterface("m66848b5361f4")}</Button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="p-6 text-sm text-destructive">{error}</div>
        ) : users.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">{translateInterface("md7647966904f")}</div>
        ) : (
          <div className="divide-y">
            {users.map((user) => (
              <div key={userId(user) || user.username} className={`flex items-center gap-3 p-4 ${user.is_active ? "" : "opacity-60"}`}>
                <div
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[12px] font-semibold text-primary"
                >
                  {initialsOf(user)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-medium">
                    <span className="truncate">{user.name || user.username}</span>
                    {user.is_superuser && (
                      <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                        {translateInterface("mc1c224b03cd9")}</span>
                    )}
                  </p>
                  <p className="truncate text-[13px] text-muted-foreground">
                    {user.username}
                    {user.email ? ` · ${user.email}` : ""}
                    {user.is_active ? ` · ${lastSeen(user.last_login)}` : translateInterface("m78a523a3e0ab")}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => openManage(user)}>
                  {translateInterface("m5a23444828db")}</Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Add person modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg space-y-4 rounded-xl border bg-background p-5 shadow-lg">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold">{translateInterface("m66848b5361f4")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{translateInterface("m4cd374a24e2c")}</p>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={() => { setCreateOpen(false); resetCreateForm(); }} aria-label={translateInterface("m7d9eb7acb13e")}>
                <X className="size-4" />
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="new-first-name">{translateInterface("m702ef921ed1d")}</Label>
                <Input id="new-first-name" value={newFirstName} onChange={(e) => setNewFirstName(e.target.value)} disabled={creating} autoComplete="given-name" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-last-name">{translateInterface("m7b4888049459")}{" "}<span className="text-muted-foreground">{translateInterface("m0059798b7f70")}</span></Label>
                <Input id="new-last-name" value={newLastName} onChange={(e) => setNewLastName(e.target.value)} disabled={creating} autoComplete="family-name" />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="new-username">{translateInterface("me3b89e9d33f8")}</Label>
                <Input id="new-username" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} disabled={creating} autoComplete="username" />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="new-email">{translateInterface("m969ccbd3cf63")}</Label>
                <Input id="new-email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} disabled={creating} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-password">{translateInterface("me7cf3ef4f17c")}</Label>
				<Input id="new-password" type="password" minLength={IDENTITY_PASSWORD_MIN_LENGTH} maxLength={IDENTITY_PASSWORD_MAX_LENGTH} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} disabled={creating} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-repeat-password">{translateInterface("mb74070f90e8c")}</Label>
                <Input id="new-repeat-password" type="password" minLength={IDENTITY_PASSWORD_MIN_LENGTH} maxLength={IDENTITY_PASSWORD_MAX_LENGTH} value={newRepeatPassword} onChange={(e) => setNewRepeatPassword(e.target.value)} disabled={creating} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{translateInterface("m14736a2eb9f4")}</Label>
              <div className="grid grid-cols-2 gap-2">
                {(["user", "admin"] as const).map((role) => (
                  <button
                    key={role}
                    type="button"
                    onClick={() => setNewRole(role)}
                    disabled={creating}
                    className={`flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                      newRole === role ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"
                    }`}
                  >
                    {role === "admin" && <ShieldCheck className="size-4" />}
                    {role === "admin" ? translateInterface("mc1c224b03cd9") : translateInterface("mb512d97e7cbf")}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 text-sm"><Label htmlFor="new-active">{translateInterface("m92340695899b")}</Label><Switch id="new-active" checked={newActive} onCheckedChange={setNewActive} disabled={creating} /></div>
            {createError && <p className="text-sm text-destructive">{createError}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setCreateOpen(false); resetCreateForm(); }} disabled={creating}>
                {translateInterface("m19766ed6ccb2")}</Button>
              <Button onClick={createUser} disabled={creating}>
                {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                {translateInterface("m66848b5361f4")}</Button>
            </div>
          </div>
        </div>
      )}

      {/* Manage modal */}
      {manage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg space-y-4 rounded-xl border bg-background p-5 shadow-lg">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold">{translateInterface("m5a23444828db")}{" "}{manage.name || manage.username}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{manage.username}</p>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={() => setManage(null)} aria-label={translateInterface("m7d9eb7acb13e")}>
                <X className="size-4" />
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="m-first-name">{translateInterface("m702ef921ed1d")}</Label>
                <Input id="m-first-name" value={mFirstName} onChange={(e) => setMFirstName(e.target.value)} disabled={mBusy} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="m-last-name">{translateInterface("m7b4888049459")}{" "}<span className="text-muted-foreground">{translateInterface("m0059798b7f70")}</span></Label>
                <Input id="m-last-name" value={mLastName} onChange={(e) => setMLastName(e.target.value)} disabled={mBusy} />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="m-email">{translateInterface("m969ccbd3cf63")}</Label>
                <Input id="m-email" type="email" value={mEmail} onChange={(e) => setMEmail(e.target.value)} disabled={mBusy} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{translateInterface("m14736a2eb9f4")}</Label>
              <div className="grid grid-cols-2 gap-2">
                {([false, true] as const).map((admin) => (
                  <button
                    key={String(admin)}
                    type="button"
                    onClick={() => setMAdmin(admin)}
                    disabled={mBusy}
                    className={`flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                      mAdmin === admin ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"
                    }`}
                  >
                    {admin && <ShieldCheck className="size-4" />}
                    {admin ? translateInterface("mc1c224b03cd9") : translateInterface("mb512d97e7cbf")}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 text-sm"><Label htmlFor="manage-active">{translateInterface("m856d470da6f0")}</Label><Switch id="manage-active" checked={mActive} onCheckedChange={setMActive} disabled={mBusy} /></div>
            <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="m-password">{translateInterface("me0edfeb3a71a")}</Label>
              <Input
                id="m-password"
                type="password"
				value={mPassword}
				minLength={IDENTITY_PASSWORD_MIN_LENGTH}
				maxLength={IDENTITY_PASSWORD_MAX_LENGTH}
                onChange={(e) => setMPassword(e.target.value)}
                disabled={mBusy}
                placeholder={translateInterface("m25a1ae17f01b")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="m-repeat-password">{translateInterface("mb74070f90e8c")}</Label>
              <Input id="m-repeat-password" type="password" value={mRepeatPassword} minLength={IDENTITY_PASSWORD_MIN_LENGTH} maxLength={IDENTITY_PASSWORD_MAX_LENGTH} onChange={(e) => setMRepeatPassword(e.target.value)} disabled={mBusy} placeholder={translateInterface("m25a1ae17f01b")} />
            </div>
            </div>
            {mError && <p className="text-sm text-destructive">{mError}</p>}
            <div className="flex items-center justify-between gap-2 border-t pt-4">
              {deleteArmed ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">{translateInterface("maf102679b073")}</span>
                  <Button variant="destructive" size="sm" onClick={removeManaged} disabled={mBusy}>
                    {translateInterface("meebdd24a77d9")}</Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleteArmed(false)} disabled={mBusy}>
                    {translateInterface("m19766ed6ccb2")}</Button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteArmed(true)} disabled={mBusy}>
                  {translateInterface("md2f352eb9691")}</Button>
              )}
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setManage(null)} disabled={mBusy}>
                  {translateInterface("m19766ed6ccb2")}</Button>
                <Button onClick={saveManage} disabled={mBusy}>
                  {mBusy && <Loader2 className="size-4 animate-spin" />}
                  {translateInterface("mdd0ae7a5cbcf")}</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
