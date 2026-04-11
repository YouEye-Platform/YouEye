/**
 * User Management Settings — Full CRUD
 *
 * Displays Authentik users with create, set-password, toggle-active,
 * toggle-admin, and delete operations via the Control Panel bridge.
 * System users (akadmin, service accounts) hidden by default.
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Users,
  ShieldCheck,
  RefreshCw,
  Loader2,
  UserCheck,
  UserX,
  Plus,
  Key,
  Power,
  Shield,
  Trash2,
  Eye,
  EyeOff,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { BridgeUnavailable } from "@/components/settings/admin/bridge-unavailable";

interface UserInfo {
  id: number;
  username: string;
  name: string;
  email: string;
  is_active: boolean;
  is_superuser: boolean;
  last_login: string | null;
  type?: string;
  path?: string;
}

/** System user patterns to hide by default */
function isSystemUser(user: UserInfo): boolean {
  const systemUsernames = ["akadmin"];
  const systemPaths = ["goauthentik.io"];
  if (systemUsernames.includes(user.username)) return true;
  if (user.path && systemPaths.some((p) => user.path?.includes(p))) return true;
  if (user.type === "service_account" || user.type === "internal_service_account") return true;
  return false;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "Never";
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

export function UserSettings() {
  const t = useTranslations("settings.users");
  const tc = useTranslations("common");
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showSystemUsers, setShowSystemUsers] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Create user dialog
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ username: "", name: "", email: "", password: "" });
  const [createLoading, setCreateLoading] = useState(false);

  // Set password dialog
  const [passwordTarget, setPasswordTarget] = useState<UserInfo | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [passwordLoading, setPasswordLoading] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<UserInfo | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Toast-style feedback
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const showFeedback = (type: "success" | "error", message: string) => {
    setFeedback({ type, message });
    setTimeout(() => setFeedback(null), 4000);
  };

  const fetchUsers = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/admin/users");
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json = await res.json();
      setUsers(json.users ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load user data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchUsers();
  };

  const handleCreate = async () => {
    if (!createForm.username || !createForm.name || !createForm.password) return;
    setCreateLoading(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createForm),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(body.error);
      }
      showFeedback("success", `User "${createForm.username}" created`);
      setShowCreate(false);
      setCreateForm({ username: "", name: "", email: "", password: "" });
      fetchUsers();
    } catch (err) {
      showFeedback("error", err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setCreateLoading(false);
    }
  };

  const handleSetPassword = async () => {
    if (!passwordTarget || !newPassword) return;
    setPasswordLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${passwordTarget.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-password", password: newPassword }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(body.error);
      }
      showFeedback("success", `Password updated for "${passwordTarget.username}"`);
      setPasswordTarget(null);
      setNewPassword("");
    } catch (err) {
      showFeedback("error", err instanceof Error ? err.message : "Failed to set password");
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleToggle = async (user: UserInfo, action: "toggle-active" | "toggle-admin") => {
    setActionLoading(`${action}-${user.id}`);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(body.error);
      }
      const label = action === "toggle-active"
        ? (user.is_active ? "deactivated" : "activated")
        : (user.is_superuser ? "demoted" : "promoted to admin");
      showFeedback("success", `${user.username} ${label}`);
      fetchUsers();
    } catch (err) {
      showFeedback("error", err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(body.error);
      }
      showFeedback("success", `User "${deleteTarget.username}" deleted`);
      setDeleteTarget(null);
      fetchUsers();
    } catch (err) {
      showFeedback("error", err instanceof Error ? err.message : "Failed to delete user");
    } finally {
      setDeleteLoading(false);
    }
  };

  const filteredUsers = showSystemUsers ? users : users.filter((u) => !isSystemUser(u));

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Manage users and their permissions.
          </p>
        </div>
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Manage users and their permissions.
          </p>
        </div>
        <BridgeUnavailable message={error} onRetry={handleRefresh} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Feedback banner */}
      {feedback && (
        <div
          className={`flex items-center gap-2 p-3 rounded-lg text-sm ${
            feedback.type === "success"
              ? "bg-green-500/10 text-green-600 dark:text-green-400"
              : "bg-destructive/10 text-destructive"
          }`}
        >
          {feedback.message}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Manage users and their permissions. Data sourced from Authentik.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowSystemUsers(!showSystemUsers)}
          >
            {showSystemUsers ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
            {showSystemUsers ? "Hide system" : "Show system"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            {refreshing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Refresh
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
            {t("createUser")}
          </Button>
        </div>
      </div>

      {/* Users table */}
      {filteredUsers.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <Users className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No users found.</p>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Username</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Login</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredUsers.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">
                    {user.username}
                    {isSystemUser(user) && (
                      <Badge variant="outline" className="ml-2 text-xs">system</Badge>
                    )}
                  </TableCell>
                  <TableCell>{user.name}</TableCell>
                  <TableCell className="text-muted-foreground">{user.email}</TableCell>
                  <TableCell>
                    {user.is_superuser ? (
                      <Badge className="bg-primary/10 text-primary border-primary/20">
                        <ShieldCheck className="h-3 w-3" />
                        Admin
                      </Badge>
                    ) : (
                      <Badge variant="secondary">User</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {user.is_active ? (
                      <div className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
                        <UserCheck className="h-3.5 w-3.5" />
                        <span className="text-sm">Active</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <UserX className="h-3.5 w-3.5" />
                        <span className="text-sm">Inactive</span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatDate(user.last_login)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="Set password"
                        onClick={() => setPasswordTarget(user)}
                      >
                        <Key className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title={user.is_active ? "Deactivate" : "Activate"}
                        disabled={actionLoading === `toggle-active-${user.id}`}
                        onClick={() => handleToggle(user, "toggle-active")}
                      >
                        {actionLoading === `toggle-active-${user.id}` ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Power className={`h-4 w-4 ${user.is_active ? "text-green-500" : "text-muted-foreground"}`} />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title={user.is_superuser ? "Remove admin" : "Make admin"}
                        disabled={actionLoading === `toggle-admin-${user.id}`}
                        onClick={() => handleToggle(user, "toggle-admin")}
                      >
                        {actionLoading === `toggle-admin-${user.id}` ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Shield className={`h-4 w-4 ${user.is_superuser ? "text-primary" : "text-muted-foreground"}`} />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        title="Delete user"
                        onClick={() => setDeleteTarget(user)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Create user dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add User</DialogTitle>
            <DialogDescription>
              Create a new user in Authentik. They can sign in via SSO.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <label className="text-sm font-medium">Username</label>
              <Input
                placeholder="johndoe"
                value={createForm.username}
                onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium">Full Name</label>
              <Input
                placeholder="John Doe"
                value={createForm.name}
                onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium">Email</label>
              <Input
                type="email"
                placeholder="john@example.com"
                value={createForm.email}
                onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium">Password</label>
              <Input
                type="password"
                placeholder="Secure password"
                value={createForm.password}
                onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={createLoading || !createForm.username || !createForm.name || !createForm.password}
            >
              {createLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              Create User
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Set password dialog */}
      <Dialog open={!!passwordTarget} onOpenChange={(open) => { if (!open) { setPasswordTarget(null); setNewPassword(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set Password</DialogTitle>
            <DialogDescription>
              Set a new password for {passwordTarget?.username}.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <label className="text-sm font-medium">New Password</label>
              <Input
                type="password"
                placeholder="New password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setPasswordTarget(null); setNewPassword(""); }}>
              Cancel
            </Button>
            <Button onClick={handleSetPassword} disabled={passwordLoading || !newPassword}>
              {passwordLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              Set Password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete User</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{deleteTarget?.username}&quot;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
