"use client";

import { useEffect, useState, useCallback } from "react";

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

function isSystemUser(user: UserInfo): boolean {
  if (user.username === "akadmin") return true;
  if (user.path?.includes("goauthentik.io")) return true;
  if (user.type === "service_account" || user.type === "internal_service_account") return true;
  return false;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "Never";
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return dateStr; }
}

type DialogState =
  | { type: "none" }
  | { type: "create" }
  | { type: "password"; user: UserInfo }
  | { type: "delete"; user: UserInfo };

export function UsersEmbedClient() {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ type: "none" });
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const [createForm, setCreateForm] = useState({ username: "", name: "", email: "", password: "" });
  const [createLoading, setCreateLoading] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const toast = (ok: boolean, msg: string) => {
    setFeedback({ ok, msg });
    setTimeout(() => setFeedback(null), 4000);
  };

  const fetchUsers = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/ui-bridge/users");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setUsers(json.users ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const handleCreate = async () => {
    if (!createForm.username || !createForm.name || !createForm.password) return;
    setCreateLoading(true);
    try {
      const res = await fetch("/api/ui-bridge/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createForm),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(body.error);
      }
      toast(true, `User "${createForm.username}" created`);
      setDialog({ type: "none" });
      setCreateForm({ username: "", name: "", email: "", password: "" });
      fetchUsers();
    } catch (err) {
      toast(false, err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setCreateLoading(false);
    }
  };

  const handleSetPassword = async () => {
    if (dialog.type !== "password" || !newPassword) return;
    setPasswordLoading(true);
    try {
      const res = await fetch(`/api/ui-bridge/users/${dialog.user.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-password", password: newPassword }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(body.error);
      }
      toast(true, `Password updated for "${dialog.user.username}"`);
      setDialog({ type: "none" });
      setNewPassword("");
    } catch (err) {
      toast(false, err instanceof Error ? err.message : "Failed");
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleToggle = async (user: UserInfo, action: "toggle-active" | "toggle-admin") => {
    setActionLoading(`${action}-${user.id}`);
    try {
      const res = await fetch(`/api/ui-bridge/users/${user.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error("Action failed");
      const label = action === "toggle-active"
        ? (user.is_active ? "deactivated" : "activated")
        : (user.is_superuser ? "demoted" : "promoted to admin");
      toast(true, `${user.username} ${label}`);
      fetchUsers();
    } catch (err) {
      toast(false, err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async () => {
    if (dialog.type !== "delete") return;
    setDeleteLoading(true);
    try {
      const res = await fetch(`/api/ui-bridge/users/${dialog.user.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      toast(true, `User "${dialog.user.username}" deleted`);
      setDialog({ type: "none" });
      fetchUsers();
    } catch (err) {
      toast(false, err instanceof Error ? err.message : "Failed");
    } finally {
      setDeleteLoading(false);
    }
  };

  const filtered = showSystem ? users : users.filter(u => !isSystemUser(u));

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <div className="embed-skeleton" style={{ height: 20, width: 200, marginBottom: 16 }} />
        <div className="embed-card" style={{ padding: 0 }}>
          {[1, 2, 3, 4].map(i => (
            <div key={i} style={{ padding: "12px 16px", borderBottom: "1px solid var(--embed-border)" }}>
              <div className="embed-skeleton" style={{ height: 14, width: "100%" }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) return <div className="embed-error">{error}</div>;

  return (
    <div style={{ padding: 16 }}>
      {/* Feedback */}
      {feedback && (
        <div style={{
          padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13,
          background: feedback.ok ? "color-mix(in srgb, var(--embed-success) 10%, transparent)" : "color-mix(in srgb, var(--embed-danger) 10%, transparent)",
          color: feedback.ok ? "var(--embed-success)" : "var(--embed-danger)",
          border: `1px solid ${feedback.ok ? "color-mix(in srgb, var(--embed-success) 20%, transparent)" : "color-mix(in srgb, var(--embed-danger) 20%, transparent)"}`,
        }}>
          {feedback.msg}
        </div>
      )}

      {/* Header */}
      <div className="embed-header">
        <div>
          <div className="embed-title">Users</div>
          <div className="embed-subtitle">Manage users and permissions via Authentik</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="embed-btn" onClick={() => setShowSystem(!showSystem)}>
            {showSystem ? "Hide system" : "Show system"}
          </button>
          <button className="embed-btn" onClick={() => { setRefreshing(true); fetchUsers(); }} disabled={refreshing}>
            {refreshing ? "..." : "Refresh"}
          </button>
          <button className="embed-btn" style={{ borderColor: "var(--embed-primary)", color: "var(--embed-primary)" }}
            onClick={() => setDialog({ type: "create" })}>
            + Add User
          </button>
        </div>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="embed-card" style={{ textAlign: "center", padding: 32 }}>
          <div className="embed-muted">No users found.</div>
        </div>
      ) : (
        <div className="embed-card" style={{ padding: 0 }}>
          <table className="embed-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last Login</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(u => (
                <tr key={u.id}>
                  <td style={{ fontWeight: 500 }}>
                    {u.username}
                    {isSystemUser(u) && (
                      <span className="embed-badge" style={{ marginLeft: 6, fontSize: 10 }}>system</span>
                    )}
                  </td>
                  <td>{u.name}</td>
                  <td className="embed-muted">{u.email}</td>
                  <td>
                    <span className="embed-badge" style={u.is_superuser
                      ? { color: "var(--embed-primary)", borderColor: "color-mix(in srgb, var(--embed-primary) 30%, transparent)" }
                      : {}
                    }>
                      {u.is_superuser ? "Admin" : "User"}
                    </span>
                  </td>
                  <td>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="embed-dot" style={{
                        width: 6, height: 6,
                        background: u.is_active ? "var(--embed-success)" : "var(--embed-text-muted)",
                      }} />
                      <span style={{ fontSize: 13, color: u.is_active ? "var(--embed-success)" : "var(--embed-text-muted)" }}>
                        {u.is_active ? "Active" : "Inactive"}
                      </span>
                    </span>
                  </td>
                  <td className="embed-muted" style={{ fontSize: 12 }}>{formatDate(u.last_login)}</td>
                  <td style={{ textAlign: "right" }}>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 4 }}>
                      <button className="embed-btn" style={{ padding: "3px 8px", fontSize: 12 }}
                        title="Set password" onClick={() => { setNewPassword(""); setDialog({ type: "password", user: u }); }}>
                        Key
                      </button>
                      <button className="embed-btn" style={{ padding: "3px 8px", fontSize: 12 }}
                        title={u.is_active ? "Deactivate" : "Activate"}
                        disabled={actionLoading === `toggle-active-${u.id}`}
                        onClick={() => handleToggle(u, "toggle-active")}>
                        {actionLoading === `toggle-active-${u.id}` ? "..." : u.is_active ? "Deactivate" : "Activate"}
                      </button>
                      <button className="embed-btn" style={{ padding: "3px 8px", fontSize: 12 }}
                        title={u.is_superuser ? "Remove admin" : "Make admin"}
                        disabled={actionLoading === `toggle-admin-${u.id}`}
                        onClick={() => handleToggle(u, "toggle-admin")}>
                        {actionLoading === `toggle-admin-${u.id}` ? "..." : u.is_superuser ? "Demote" : "Promote"}
                      </button>
                      <button className="embed-btn" style={{
                        padding: "3px 8px", fontSize: 12,
                        borderColor: "var(--embed-danger)", color: "var(--embed-danger)",
                      }}
                        title="Delete" onClick={() => setDialog({ type: "delete", user: u })}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create User Dialog */}
      {dialog.type === "create" && (
        <Overlay onClose={() => setDialog({ type: "none" })}>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>Add User</div>
          <div className="embed-muted" style={{ fontSize: 13, marginBottom: 16 }}>
            Create a new user in Authentik. They can sign in via SSO.
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            <Field label="Username" value={createForm.username} placeholder="johndoe"
              onChange={v => setCreateForm(f => ({ ...f, username: v }))} />
            <Field label="Full Name" value={createForm.name} placeholder="John Doe"
              onChange={v => setCreateForm(f => ({ ...f, name: v }))} />
            <Field label="Email" value={createForm.email} placeholder="john@example.com" type="email"
              onChange={v => setCreateForm(f => ({ ...f, email: v }))} />
            <Field label="Password" value={createForm.password} placeholder="Secure password" type="password"
              onChange={v => setCreateForm(f => ({ ...f, password: v }))} />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button className="embed-btn" onClick={() => setDialog({ type: "none" })}>Cancel</button>
            <button className="embed-btn" style={{ borderColor: "var(--embed-primary)", color: "var(--embed-primary)" }}
              onClick={handleCreate}
              disabled={createLoading || !createForm.username || !createForm.name || !createForm.password}>
              {createLoading ? "Creating..." : "Create User"}
            </button>
          </div>
        </Overlay>
      )}

      {/* Set Password Dialog */}
      {dialog.type === "password" && (
        <Overlay onClose={() => setDialog({ type: "none" })}>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>Set Password</div>
          <div className="embed-muted" style={{ fontSize: 13, marginBottom: 16 }}>
            Set a new password for {dialog.user.username}.
          </div>
          <Field label="New Password" value={newPassword} placeholder="New password" type="password"
            onChange={setNewPassword} />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button className="embed-btn" onClick={() => setDialog({ type: "none" })}>Cancel</button>
            <button className="embed-btn" style={{ borderColor: "var(--embed-primary)", color: "var(--embed-primary)" }}
              onClick={handleSetPassword} disabled={passwordLoading || !newPassword}>
              {passwordLoading ? "Saving..." : "Set Password"}
            </button>
          </div>
        </Overlay>
      )}

      {/* Delete Confirmation */}
      {dialog.type === "delete" && (
        <Overlay onClose={() => setDialog({ type: "none" })}>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>Delete User</div>
          <div className="embed-muted" style={{ fontSize: 13, marginBottom: 16 }}>
            Are you sure you want to delete &ldquo;{dialog.user.username}&rdquo;? This cannot be undone.
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="embed-btn" onClick={() => setDialog({ type: "none" })}>Cancel</button>
            <button className="embed-btn" style={{ borderColor: "var(--embed-danger)", color: "var(--embed-danger)" }}
              onClick={handleDelete} disabled={deleteLoading}>
              {deleteLoading ? "Deleting..." : "Delete"}
            </button>
          </div>
        </Overlay>
      )}
    </div>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{
      position: "fixed", inset: 0, display: "flex", alignItems: "flex-start", justifyContent: "center",
      paddingTop: 80, zIndex: 100,
    }} onClick={onClose}>
      <div className="embed-card" style={{ maxWidth: 420, width: "90%" }} onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function Field({ label, value, placeholder, type, onChange }: {
  label: string; value: string; placeholder: string; type?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{label}</div>
      <input
        type={type || "text"}
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        style={{
          width: "100%", padding: "6px 10px", fontSize: 13, borderRadius: 6,
          border: "1px solid var(--embed-border)", background: "var(--embed-bg)",
          color: "var(--embed-text)", outline: "none",
        }}
      />
    </div>
  );
}
