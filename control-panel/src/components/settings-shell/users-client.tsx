"use client";

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

function lastSeen(iso: string | null) {
  if (!iso) return "never signed in";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "—";
  const diffMin = Math.floor((Date.now() - time) / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  if (diffMin < 1) return "last seen just now";
  if (diffMin < 60) return `last seen ${diffMin}m ago`;
  if (diffHr < 24) return `last seen ${diffHr}h ago`;
  if (diffDay === 1) return "last seen yesterday";
  if (diffDay < 30) return `last seen ${diffDay}d ago`;
  return `last seen ${new Date(iso).toLocaleDateString()}`;
}

export function UsersClient() {
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
      setError((await res.json().catch(() => ({}))).error || "Failed to load users");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function mutationHeaders() {
	const response = await fetch("/settings/api/auth/csrf", { cache: "no-store" });
	const body = await response.json();
	if (!response.ok || !body.csrfToken) throw new Error("Could not prepare a protected request");
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
      setCreateError("First name, username, email, password, and repeat password are required");
      return;
    }
	if (newPassword !== newRepeatPassword) {
	  setCreateError("Passwords do not match");
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
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to add person");
      setCreateOpen(false);
      resetCreateForm();
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to add person");
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
		setMError("Passwords do not match");
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
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Save failed");
      if (mPassword) {
        const pr = await fetch(`/api/apps/identity/users/${userId(manage)}/password`, {
          method: "POST",
		  headers,
          body: JSON.stringify({ password: mPassword, repeatPassword: mRepeatPassword }),
        });
        if (!pr.ok) throw new Error((await pr.json().catch(() => ({}))).error || "Password update failed");
      }
      setManage(null);
      await load();
    } catch (err) {
      setMError(err instanceof Error ? err.message : "Save failed");
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
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Remove failed");
      setManage(null);
      await load();
    } catch (err) {
      setMError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setMBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">People</h1>
        <p className="mt-1 text-sm text-muted-foreground">Who can sign in to this server</p>
      </div>

      {/* People list */}
      <Card className="gap-0 py-0">
        <div className="flex items-center justify-between gap-4 border-b p-4">
          <h2 className="text-[15px] font-semibold">{loading ? "People" : `${users.length} ${users.length === 1 ? "person" : "people"}`}</h2>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon-sm" onClick={load} aria-label="Refresh">
              <RefreshCw className="size-4" />
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> Add person
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="p-6 text-sm text-destructive">{error}</div>
        ) : users.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">No people yet. Add the first person above.</div>
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
                        Admin
                      </span>
                    )}
                  </p>
                  <p className="truncate text-[13px] text-muted-foreground">
                    {user.username}
                    {user.email ? ` · ${user.email}` : ""}
                    {user.is_active ? ` · ${lastSeen(user.last_login)}` : " · deactivated"}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => openManage(user)}>
                  Manage
                </Button>
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
                <h3 className="text-base font-semibold">Add person</h3>
                <p className="mt-1 text-sm text-muted-foreground">Create an account and choose its role.</p>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={() => { setCreateOpen(false); resetCreateForm(); }} aria-label="Close">
                <X className="size-4" />
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="new-first-name">First name</Label>
                <Input id="new-first-name" value={newFirstName} onChange={(e) => setNewFirstName(e.target.value)} disabled={creating} autoComplete="given-name" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-last-name">Last name <span className="text-muted-foreground">(optional)</span></Label>
                <Input id="new-last-name" value={newLastName} onChange={(e) => setNewLastName(e.target.value)} disabled={creating} autoComplete="family-name" />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="new-username">Username</Label>
                <Input id="new-username" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} disabled={creating} autoComplete="username" />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="new-email">Email</Label>
                <Input id="new-email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} disabled={creating} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-password">Password</Label>
				<Input id="new-password" type="password" minLength={IDENTITY_PASSWORD_MIN_LENGTH} maxLength={IDENTITY_PASSWORD_MAX_LENGTH} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} disabled={creating} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-repeat-password">Repeat password</Label>
                <Input id="new-repeat-password" type="password" minLength={IDENTITY_PASSWORD_MIN_LENGTH} maxLength={IDENTITY_PASSWORD_MAX_LENGTH} value={newRepeatPassword} onChange={(e) => setNewRepeatPassword(e.target.value)} disabled={creating} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
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
                    {role === "admin" ? "Admin" : "User"}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 text-sm"><Label htmlFor="new-active">Active</Label><Switch id="new-active" checked={newActive} onCheckedChange={setNewActive} disabled={creating} /></div>
            {createError && <p className="text-sm text-destructive">{createError}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setCreateOpen(false); resetCreateForm(); }} disabled={creating}>
                Cancel
              </Button>
              <Button onClick={createUser} disabled={creating}>
                {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                Add person
              </Button>
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
                <h3 className="text-base font-semibold">Manage {manage.name || manage.username}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{manage.username}</p>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={() => setManage(null)} aria-label="Close">
                <X className="size-4" />
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="m-first-name">First name</Label>
                <Input id="m-first-name" value={mFirstName} onChange={(e) => setMFirstName(e.target.value)} disabled={mBusy} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="m-last-name">Last name <span className="text-muted-foreground">(optional)</span></Label>
                <Input id="m-last-name" value={mLastName} onChange={(e) => setMLastName(e.target.value)} disabled={mBusy} />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="m-email">Email</Label>
                <Input id="m-email" type="email" value={mEmail} onChange={(e) => setMEmail(e.target.value)} disabled={mBusy} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
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
                    {admin ? "Admin" : "User"}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 text-sm"><Label htmlFor="manage-active">Active (can sign in)</Label><Switch id="manage-active" checked={mActive} onCheckedChange={setMActive} disabled={mBusy} /></div>
            <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="m-password">Reset password</Label>
              <Input
                id="m-password"
                type="password"
				value={mPassword}
				minLength={IDENTITY_PASSWORD_MIN_LENGTH}
				maxLength={IDENTITY_PASSWORD_MAX_LENGTH}
                onChange={(e) => setMPassword(e.target.value)}
                disabled={mBusy}
                placeholder="Leave blank to keep current"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="m-repeat-password">Repeat password</Label>
              <Input id="m-repeat-password" type="password" value={mRepeatPassword} minLength={IDENTITY_PASSWORD_MIN_LENGTH} maxLength={IDENTITY_PASSWORD_MAX_LENGTH} onChange={(e) => setMRepeatPassword(e.target.value)} disabled={mBusy} placeholder="Leave blank to keep current" />
            </div>
            </div>
            {mError && <p className="text-sm text-destructive">{mError}</p>}
            <div className="flex items-center justify-between gap-2 border-t pt-4">
              {deleteArmed ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Remove this person?</span>
                  <Button variant="destructive" size="sm" onClick={removeManaged} disabled={mBusy}>
                    Confirm
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleteArmed(false)} disabled={mBusy}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteArmed(true)} disabled={mBusy}>
                  Remove person
                </Button>
              )}
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setManage(null)} disabled={mBusy}>
                  Cancel
                </Button>
                <Button onClick={saveManage} disabled={mBusy}>
                  {mBusy && <Loader2 className="size-4 animate-spin" />}
                  Save changes
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
