"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, ShieldCheck, UserPlus, Users, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface IdentityUser {
  pk?: string | number;
  id?: string | number;
  username: string;
  name: string;
  email: string;
  is_active: boolean;
  is_superuser: boolean;
  last_login: string | null;
  type?: string;
  path?: string;
}

function isSystemUser(user: IdentityUser) {
  if (user.username === "akadmin") return true;
  if (user.type === "service_account" || user.type === "internal_service_account") return true;
  return !!user.path?.includes("goauthentik.io");
}

export function UsersClient() {
  const [users, setUsers] = useState<IdentityUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSystem, setShowSystem] = useState(false);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"user" | "admin">("user");
  const [newActive, setNewActive] = useState(true);

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

  useEffect(() => { load(); }, [load]);

  const visible = showSystem ? users : users.filter((user) => !isSystemUser(user));

  function resetCreateForm() {
    setNewUsername("");
    setNewName("");
    setNewEmail("");
    setNewPassword("");
    setNewRole("user");
    setNewActive(true);
    setCreateError("");
  }

  async function createUser() {
    const username = newUsername.trim();
    const name = newName.trim();
    const email = newEmail.trim();

    setCreateError("");
    if (!username || !name || !newPassword) {
      setCreateError("Username, display name, and password are required");
      return;
    }

    setCreating(true);
    try {
      const res = await fetch("/api/apps/identity/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          name,
          email,
          password: newPassword,
          is_active: newActive,
          isAdmin: newRole === "admin",
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to create user");
      }
      setCreateOpen(false);
      resetCreateForm();
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold"><Users className="h-5 w-5" />Users</h2>
          <p className="mt-1 text-sm text-muted-foreground">Manage YouEye users and access.</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" onClick={() => setCreateOpen(true)}><UserPlus className="h-4 w-4" />New User</Button>
          <Button variant="outline" size="sm" onClick={() => setShowSystem((value) => !value)}>{showSystem ? "Hide system" : "Show system"}</Button>
          <Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-4 w-4" />Refresh</Button>
        </div>
      </div>
      {loading ? <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div> : error ? <div className="rounded-lg border p-6 text-sm text-destructive">{error}</div> : (
        <div className="rounded-lg border divide-y">
          {visible.map((user) => (
            <div key={user.pk || user.id || user.username} className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <p className="font-medium">{user.name || user.username}</p>
                <p className="text-sm text-muted-foreground">{user.username}{user.email ? ` · ${user.email}` : ""}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                {user.is_superuser && <Badge>Admin</Badge>}
                <Badge variant={user.is_active ? "secondary" : "outline"}>{user.is_active ? "Active" : "Inactive"}</Badge>
              </div>
            </div>
          ))}
        </div>
      )}

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg space-y-4 rounded-lg border bg-background p-5 shadow-lg">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="flex items-center gap-2 text-base font-semibold"><UserPlus className="h-4 w-4" />Create User</h3>
                <p className="mt-1 text-sm text-muted-foreground">Add a YouEye account and choose its role.</p>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  setCreateOpen(false);
                  resetCreateForm();
                }}
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="new-username">Username</Label>
                <Input id="new-username" value={newUsername} onChange={(event) => setNewUsername(event.target.value)} disabled={creating} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-name">Display Name</Label>
                <Input id="new-name" value={newName} onChange={(event) => setNewName(event.target.value)} disabled={creating} />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="new-email">Email</Label>
                <Input id="new-email" type="email" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} disabled={creating} />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="new-password">Password</Label>
                <Input id="new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} disabled={creating} />
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
                    {role === "admin" && <ShieldCheck className="h-4 w-4" />}
                    {role === "admin" ? "Admin" : "User"}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={newActive}
                onChange={(event) => setNewActive(event.target.checked)}
                disabled={creating}
              />
              <span>Active</span>
            </label>
            {createError && <p className="text-sm text-destructive">{createError}</p>}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setCreateOpen(false);
                  resetCreateForm();
                }}
                disabled={creating}
              >
                Cancel
              </Button>
              <Button onClick={createUser} disabled={creating}>
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                Create
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
