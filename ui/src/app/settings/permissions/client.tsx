"use client";

import { useState } from "react";
import {
  ArrowRight,
  Globe,
  Link2,
  Check,
  X,
  Trash2,
  Plus,
  Shield,
} from "lucide-react";

interface Bridge {
  id: string;
  from: string;
  to: string;
  direction: string;
  active: boolean;
  aclName?: string;
  approvedBy?: string;
}

interface InternetGrant {
  id: string;
  appId: string;
  containerName: string;
  hosts: string[];
  blanket: boolean;
  active: boolean;
  approvedBy: string;
  approvedAt: string;
}

interface Suggestion {
  id: string;
  type: "bridge" | "internet";
  fromAppId: string;
  fromAppName: string;
  targetAppId?: string;
  targetAppName?: string;
  hosts?: string[];
  targetInstalled?: boolean;
  dismissed: boolean;
}

interface Props {
  bridges: Bridge[];
  grants: InternetGrant[];
  suggestions: Suggestion[];
}

export function PermissionsClient({ bridges: initialBridges, grants: initialGrants, suggestions: initialSuggestions }: Props) {
  const [bridges, setBridges] = useState(initialBridges);
  const [grants, setGrants] = useState(initialGrants);
  const [suggestions, setSuggestions] = useState(initialSuggestions);

  const activeBridges = bridges.filter((b) => b.active);
  const activeGrants = grants.filter((g) => g.active);
  const activeSuggestions = suggestions.filter((s) => !s.dismissed);

  async function revokeBridge(id: string) {
    const res = await fetch(`/api/v1/admin/proxy-cp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: `/api/bridges/${id}`, method: "DELETE" }),
    });
    if (res.ok) {
      setBridges(bridges.filter((b) => b.id !== id));
    }
  }

  async function revokeGrant(id: string) {
    const res = await fetch(`/api/v1/admin/proxy-cp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: `/api/internet-grants/${id}`, method: "DELETE" }),
    });
    if (res.ok) {
      setGrants(grants.filter((g) => g.id !== id));
    }
  }

  async function dismissSuggestion(id: string) {
    const res = await fetch(`/api/v1/admin/proxy-cp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: `/api/suggestions`,
        method: "POST",
        body: { action: "dismiss", id },
      }),
    });
    if (res.ok) {
      setSuggestions(suggestions.map((s) => s.id === id ? { ...s, dismissed: true } : s));
    }
  }

  async function acceptSuggestion(s: Suggestion) {
    if (s.type === "bridge" && s.targetAppId) {
      const res = await fetch(`/api/v1/admin/proxy-cp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: `/api/bridges`,
          method: "POST",
          body: {
            from: s.fromAppId,
            to: s.targetAppId,
            direction: "one-way",
            approvedBy: "admin",
            activate: true,
          },
        }),
      });
      if (res.ok) {
        setSuggestions(suggestions.filter((x) => x.id !== s.id));
        // Refresh bridges
        const bridgesRes = await fetch("/api/v1/admin/proxy-cp?path=/api/bridges");
        if (bridgesRes.ok) setBridges(await bridgesRes.json());
      }
    } else if (s.type === "internet" && s.hosts) {
      const res = await fetch(`/api/v1/admin/proxy-cp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: `/api/internet-grants`,
          method: "POST",
          body: {
            appId: s.fromAppId,
            containerName: `app-${s.fromAppId}-main`,
            hosts: s.hosts,
            approvedBy: "admin",
          },
        }),
      });
      if (res.ok) {
        setSuggestions(suggestions.filter((x) => x.id !== s.id));
        const grantsRes = await fetch("/api/v1/admin/proxy-cp?path=/api/internet-grants");
        if (grantsRes.ok) setGrants(await grantsRes.json());
      }
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold flex items-center gap-2 mb-1">
          <Shield className="h-5 w-5" />
          Network &amp; Permissions
        </h2>
        <p className="text-sm text-muted-foreground">
          Manage app-to-app connections and internet access.
        </p>
      </div>

      {/* Active Connections */}
      <section>
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
          Active Connections
        </h3>
        {activeBridges.length === 0 && activeGrants.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">No active connections.</p>
        ) : (
          <div className="space-y-2">
            {activeBridges.map((b) => (
              <div
                key={b.id}
                className="flex items-center justify-between rounded-lg border border-border bg-card p-3"
              >
                <div className="flex items-center gap-2">
                  <Link2 className="h-4 w-4 text-green-500" />
                  <span className="font-medium">{b.from}</span>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  <span className="font-medium">{b.to}</span>
                  <span className="text-xs text-muted-foreground ml-2">
                    {b.direction === "both-ways" ? "↔ Both ways" : "→ One-way"}
                  </span>
                </div>
                <button
                  onClick={() => revokeBridge(b.id)}
                  className="text-xs text-destructive hover:underline flex items-center gap-1"
                >
                  <Trash2 className="h-3 w-3" /> Revoke
                </button>
              </div>
            ))}
            {activeGrants.map((g) => (
              <div
                key={g.id}
                className="flex items-center justify-between rounded-lg border border-border bg-card p-3"
              >
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4 text-blue-500" />
                  <span className="font-medium">{g.appId}</span>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">
                    {g.blanket
                      ? "Internet (all hosts)"
                      : `Internet (${g.hosts.length} host${g.hosts.length !== 1 ? "s" : ""})`}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {!g.blanket && (
                    <span className="text-xs text-muted-foreground">
                      {g.hosts.join(", ")}
                    </span>
                  )}
                  <button
                    onClick={() => revokeGrant(g.id)}
                    className="text-xs text-destructive hover:underline flex items-center gap-1"
                  >
                    <Trash2 className="h-3 w-3" /> Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Suggestions */}
      {activeSuggestions.length > 0 && (
        <section>
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Suggestions
          </h3>
          <div className="space-y-2">
            {activeSuggestions.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between rounded-lg border border-dashed border-border bg-card/50 p-3"
              >
                <div className="flex items-center gap-2">
                  {s.type === "bridge" ? (
                    <Link2 className="h-4 w-4 text-yellow-500" />
                  ) : (
                    <Globe className="h-4 w-4 text-yellow-500" />
                  )}
                  <span className="font-medium">{s.fromAppName}</span>
                  {s.type === "bridge" ? (
                    <>
                      <span className="text-sm text-muted-foreground">wants to connect to</span>
                      <span className="font-medium">{s.targetAppName}</span>
                      {s.targetInstalled ? (
                        <span className="text-xs bg-green-500/10 text-green-600 px-1.5 py-0.5 rounded">
                          Installed
                        </span>
                      ) : (
                        <span className="text-xs bg-yellow-500/10 text-yellow-600 px-1.5 py-0.5 rounded">
                          Not installed
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="text-sm text-muted-foreground">wants internet access</span>
                      <span className="text-xs text-muted-foreground">
                        ({s.hosts?.join(", ")})
                      </span>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => acceptSuggestion(s)}
                    className="text-xs bg-primary text-primary-foreground hover:bg-primary/90 px-3 py-1 rounded flex items-center gap-1"
                    disabled={s.type === "bridge" && !s.targetInstalled}
                  >
                    <Check className="h-3 w-3" />
                    {s.type === "bridge" ? "Connect" : "Allow"}
                  </button>
                  <button
                    onClick={() => dismissSuggestion(s.id)}
                    className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded flex items-center gap-1"
                  >
                    <X className="h-3 w-3" /> Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
