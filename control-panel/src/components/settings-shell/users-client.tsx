"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await fetch("/api/apps/authentik/users");
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold"><Users className="h-5 w-5" />Users</h2>
          <p className="mt-1 text-sm text-muted-foreground">Manage YouEye users and access.</p>
        </div>
        <div className="flex gap-2">
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
    </div>
  );
}
