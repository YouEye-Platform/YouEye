"use client";

import { useCallback, useEffect, useState } from "react";
import { Globe, Loader2, Lock, RefreshCw, ShieldCheck, ShieldOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type NetworkTab = "dns" | "tls";

interface DnsStats {
  status: string;
  domainsBlocked: number;
  queriesToday: number;
  adsBlockedToday: number;
  adsPercentage: number;
}

interface TlsStatus {
  mode: string;
  hasExternalCert: boolean;
  cert: null | { issuer: string; domains: string[]; expiresAt: string; issuedAt: string };
  subjects: string[];
  expiryWarning: boolean;
}

function tabClass(active: boolean) {
  return `-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
    active
      ? "border-primary text-foreground"
      : "border-transparent text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground"
  }`;
}

export function NetworkClient() {
  const [active, setActive] = useState<NetworkTab>("dns");

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const tab = search.get("tab");
    if (tab === "tls") setActive("tls");
  }, []);

  return (
    <div>
      <div className="mb-6 flex items-center gap-1 border-b">
        <button onClick={() => setActive("dns")} className={tabClass(active === "dns")}><Globe className="h-4 w-4" />DNS</button>
        <button onClick={() => setActive("tls")} className={tabClass(active === "tls")}><Lock className="h-4 w-4" />TLS</button>
      </div>
      {active === "dns" ? <DnsPanel /> : <TlsPanel />}
    </div>
  );
}

function DnsPanel() {
  const [stats, setStats] = useState<DnsStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await fetch("/api/apps/pihole/stats");
    if (res.ok) setStats(await res.json());
    else setError((await res.json().catch(() => ({}))).error || "Failed to load DNS statistics");
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (error) return <div className="rounded-lg border p-6 text-sm text-destructive">{error}</div>;

  const enabled = stats?.status === "enabled" || stats?.status === "running";
  const cards = [
    ["Queries", stats?.queriesToday?.toLocaleString() || "0"],
    ["Blocked", stats?.adsBlockedToday?.toLocaleString() || "0"],
    ["Blocked %", `${Number(stats?.adsPercentage || 0).toFixed(1)}%`],
    ["Gravity", stats?.domainsBlocked?.toLocaleString() || "0"],
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">DNS</h2>
          <p className="mt-1 text-sm text-muted-foreground">Pi-hole DNS filtering statistics.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-4 w-4" />Refresh</Button>
      </div>
      <div className="rounded-lg border p-4">
        <div className="flex items-center gap-3">
          {enabled ? <ShieldCheck className="h-5 w-5 text-green-500" /> : <ShieldOff className="h-5 w-5 text-destructive" />}
          <p className="font-medium">Pi-hole is <Badge variant="outline">{stats?.status || "unknown"}</Badge></p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(([label, value]) => (
          <div key={label} className="rounded-lg border p-4">
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-bold">{value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function TlsPanel() {
  const [status, setStatus] = useState<TlsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await fetch("/api/tls/status");
    if (res.ok) setStatus(await res.json());
    else setError((await res.json().catch(() => ({}))).error || "Failed to load TLS status");
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (error) return <div className="rounded-lg border p-6 text-sm text-destructive">{error}</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">TLS</h2>
          <p className="mt-1 text-sm text-muted-foreground">Certificate status and HTTPS configuration.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-4 w-4" />Refresh</Button>
      </div>
      <div className="rounded-lg border divide-y">
        <div className="grid gap-4 p-4 text-sm sm:grid-cols-2">
          <div><span className="text-muted-foreground">Mode</span><p className="font-medium">{status?.mode || "unknown"}</p></div>
          <div><span className="text-muted-foreground">External Certificate</span><p className="font-medium">{status?.hasExternalCert ? "Configured" : "Not configured"}</p></div>
          <div><span className="text-muted-foreground">Issuer</span><p className="font-medium">{status?.cert?.issuer || "Internal/on-demand"}</p></div>
          <div><span className="text-muted-foreground">Expires</span><p className="font-medium">{status?.cert?.expiresAt || "—"}</p></div>
        </div>
        <div className="p-4">
          <p className="mb-2 text-sm font-medium">Subjects</p>
          <div className="flex flex-wrap gap-2">
            {(status?.subjects || []).length > 0 ? status?.subjects.map((subject) => <Badge key={subject} variant="secondary">{subject}</Badge>) : <span className="text-sm text-muted-foreground">No explicit subjects configured.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
