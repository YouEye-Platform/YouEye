"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Shield, ShieldOff, Globe, Route as RouteIcon, Plus, Trash2, Loader2, RefreshCw,
  Check, X, AlertTriangle, ChevronRight, Cloud, Info, KeyRound,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type NetworkTab = "dns" | "routes" | "domain";

interface DnsStats { status: string; domainsBlocked: number; queriesToday: number; adsBlockedToday: number; adsPercentage: number; }
interface Adlist { address: string; comment: string; enabled: boolean; type: string; number?: number; }
interface ARecord { ip: string; domain: string; }
interface CnameRecord { domain: string; target: string; }
interface QueryRow { timestamp: number; type: string; domain: string; client: string; reply: string; }
interface ProxyRoute { id: string; hostname?: string; path: string; upstream: string; port: number; enabled: boolean; }
interface TlsStatus { mode: string; hasExternalCert: boolean; cert: null | { issuer: string; domains: string[]; expiresAt: string; issuedAt: string }; subjects: string[]; expiryWarning: boolean; }
interface DnsProviderState {
  connection: null | {
    provider: string;
    domain: string;
    zoneName: string;
    targetIp: string;
    hasToken: boolean;
    lastDnsSyncAt: string | null;
    lastDnsSyncError: string | null;
    lastCertRenewalAt: string | null;
    nextCertRenewalDueAt: string | null;
  };
}
interface NamesStatus {
  active: boolean;
  certificateMatches: boolean;
  serviceReachable: boolean;
  readiness: null | {
    installation: { canProceedNow: boolean; state: "ready" | "challenge" | "degraded" | "paused" | "blocked"; reasonCodes: string[] };
    dns: { state: string };
    initialCertificate: {
      available: boolean;
      primary: { provider: "google-public-ca" | "letsencrypt"; state: string };
      fallback: { provider: "google-public-ca" | "letsencrypt"; state: string };
    };
  };
  currentTerms: null | {
    version: string;
    summary: string;
    certificateTransparencyRequired: true;
  };
  state: null | {
    name: string;
    fqdn: string;
    status: "provisioning" | "healthy" | "renewing" | "attention" | "released";
    termsVersion: string | null;
    certificateTransparencyAcceptedAt: string | null;
    certificate: null | {
      fingerprint: string;
      provider: "letsencrypt" | "google-public-ca" | null;
      issuedAt: string;
      expiresAt: string;
    };
    lastBrokerContactAt: string | null;
    lastHeartbeatAt: string | null;
    nextCheckAt: string | null;
    lastError: null | { code: string; requestId: string | null; at: string };
  };
}

// FTL puts its status string in `reply`; treat gravity/deny/black/regex/block as blocked.
const isBlockedReply = (reply: string) => /gravity|deny|black|regex|block/i.test(reply || "");
const looksLikeIp = (v: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(v.trim()) || (v.includes(":") && /^[0-9a-fA-F:]+$/.test(v.trim()));
const hostOnly = (value: string) => {
  const trimmed = value.trim();
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return trimmed.toLowerCase().replace(/\.+$/, "");
  }
};

async function csrfHeaders(): Promise<Record<string, string>> {
  const token = await fetch("/settings/api/auth/csrf").then((r) => r.json()).then((b) => b.csrfToken as string);
  return { "Content-Type": "application/json", "X-CSRF-Token": token };
}

function tabClass(active: boolean) {
  return cn(
    "-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
    active ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground",
  );
}

function tabFromSearch(): NetworkTab {
  if (typeof window === "undefined") return "dns";
  const tab = new URLSearchParams(window.location.search).get("tab");
  if (tab === "routes" || tab === "domain") return tab;
  if (tab === "tls") return "domain";
  return "dns";
}

export function NetworkClient({ initialTab }: { initialTab?: NetworkTab } = {}) {
  // Initial tab derived synchronously (server passes it from searchParams) —
  // no default-then-sync flash (pitfall #21).
  const [active, setActive] = useState<NetworkTab>(() => initialTab ?? tabFromSearch());

  function selectTab(tab: NetworkTab) {
    setActive(tab);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (tab === "dns") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  const tabs: { id: NetworkTab; label: string; icon: typeof Shield }[] = [
    { id: "dns", label: "DNS", icon: Shield },
    { id: "routes", label: "Routes", icon: RouteIcon },
    { id: "domain", label: "Domain & HTTPS", icon: Globe },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Network</h1>
      <p className="mt-1 text-muted-foreground">DNS, routes, and how your server is reached</p>

      <div className="mb-6 mt-6 flex items-center gap-1 overflow-x-auto border-b">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => selectTab(id)} className={tabClass(active === id)}>
            <Icon className="h-4 w-4" />{label}
          </button>
        ))}
      </div>

      {active === "dns" && <DnsPanel />}
      {active === "routes" && <RoutesPanel />}
      {active === "domain" && <DomainPanel />}
    </div>
  );
}

/* ─────────────────────────── DNS ─────────────────────────── */

function DnsPanel() {
  const [stats, setStats] = useState<DnsStats | null>(null);
  const [lists, setLists] = useState<Adlist[]>([]);
  const [aRecords, setARecords] = useState<ARecord[]>([]);
  const [cnames, setCnames] = useState<CnameRecord[]>([]);
  const [queries, setQueries] = useState<QueryRow[]>([]);
  const [queryLimit, setQueryLimit] = useState(12);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const loadQueries = useCallback(async (limit: number) => {
    const res = await fetch(`/api/apps/pihole/queries?limit=${limit}`);
    if (res.ok) setQueries((await res.json()).queries || []);
  }, []);

  const load = useCallback(async () => {
    setError("");
    const statsRes = await fetch("/api/apps/pihole/stats");
    if (!statsRes.ok) {
      setError((await statsRes.json().catch(() => ({}))).error || "Failed to load DNS statistics");
      setLoading(false);
      return;
    }
    setStats(await statsRes.json());
    const [listsR, aR, cR] = await Promise.all([
      fetch("/api/apps/pihole/lists"),
      fetch("/api/apps/pihole/dns-records"),
      fetch("/api/apps/pihole/cname-records"),
    ]);
    if (listsR.ok) setLists((await listsR.json()).lists || []);
    if (aR.ok) setARecords((await aR.json()).records || []);
    if (cR.ok) setCnames((await cR.json()).records || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadQueries(queryLimit); }, [queryLimit, loadQueries]);

  async function toggleBlocking() {
    if (!stats) return;
    const enabling = !(stats.status === "enabled");
    setBusy("blocking");
    try {
      const res = await fetch("/api/apps/pihole/control", {
        method: "POST", headers: await csrfHeaders(),
        body: JSON.stringify({ action: enabling ? "enable" : "disable" }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
      setStats({ ...stats, status: enabling ? "enabled" : "disabled" });
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to change blocking"); }
    finally { setBusy(null); }
  }

  async function toggleList(list: Adlist) {
    setBusy(list.address);
    try {
      const res = await fetch("/api/apps/pihole/lists", {
        method: "PATCH", headers: await csrfHeaders(),
        body: JSON.stringify({ address: list.address, enabled: !list.enabled, comment: list.comment, type: list.type }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
      setLists((prev) => prev.map((l) => (l.address === list.address ? { ...l, enabled: !l.enabled } : l)));
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to update blocklist"); }
    finally { setBusy(null); }
  }

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (error && !stats) return <div className="rounded-xl border bg-card p-6 text-sm text-destructive">{error}</div>;

  const blocking = stats?.status === "enabled";

  return (
    <div className="space-y-6">
      {error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive">{error}</div>}

      {/* Stat row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard k="Queries today" v={(stats?.queriesToday ?? 0).toLocaleString()} d="DNS lookups" />
        <StatCard k="Blocked" v={`${Number(stats?.adsPercentage ?? 0).toFixed(0)}%`} d={`${(stats?.adsBlockedToday ?? 0).toLocaleString()} ads & trackers`} />
        <StatCard k="Blocklists" v={(stats?.domainsBlocked ?? 0).toLocaleString()} d={`${lists.length} list${lists.length === 1 ? "" : "s"}`} />
        <div className="rounded-xl border bg-card p-4">
          <div className="text-xs text-muted-foreground">Blocking</div>
          <div className="mt-1 flex items-center gap-3">
            <span className="text-xl font-bold">{blocking ? "On" : "Off"}</span>
            <Switch checked={!!blocking} disabled={busy === "blocking"} onCheckedChange={toggleBlocking} aria-label="Toggle DNS blocking" />
          </div>
          <div className="mt-1 text-xs text-muted-foreground">protects the whole network</div>
        </div>
      </div>

      {/* Local names */}
      <LocalNamesCard
        aRecords={aRecords} cnames={cnames}
        onChanged={load}
        setError={setError}
      />

      {/* Blocklists */}
      <ListCard title="Blocklists" headerRight={<span className="text-xs text-muted-foreground">updated nightly</span>}>
        {lists.length === 0 ? (
          <Empty>No blocklists configured.</Empty>
        ) : lists.map((list) => (
          <div key={list.address} className="flex items-center gap-3 border-t px-[18px] py-3 first:border-t-0">
            <div className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-muted text-muted-foreground">
              {list.enabled ? <Shield className="h-4 w-4" /> : <ShieldOff className="h-4 w-4" />}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{list.comment || list.address}</div>
              <div className="truncate text-xs text-muted-foreground">
                {(list.number ?? 0).toLocaleString()} domains{list.enabled ? "" : " · off"}
              </div>
            </div>
            <div className="ml-auto">
              <Switch checked={list.enabled} disabled={busy === list.address} onCheckedChange={() => toggleList(list)} aria-label={`Toggle ${list.comment || list.address}`} />
            </div>
          </div>
        ))}
      </ListCard>

      {/* Recent queries */}
      <ListCard title="Recent queries" headerRight={
        <button className="text-sm text-primary hover:underline" onClick={() => { const n = queryLimit >= 100 ? 12 : 100; setQueryLimit(n); loadQueries(n); }}>
          {queryLimit >= 100 ? "Show less" : "View all"}
        </button>
      }>
        {queries.length === 0 ? <Empty>No recent queries.</Empty> : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <th className="px-[18px] py-2.5 font-semibold">Domain</th>
                <th className="px-[18px] py-2.5 font-semibold">Device</th>
                <th className="px-[18px] py-2.5 font-semibold">Result</th>
              </tr>
            </thead>
            <tbody>
              {queries.map((q, i) => {
                const blocked = isBlockedReply(q.reply);
                return (
                  <tr key={`${q.domain}-${q.timestamp}-${i}`} className="border-t">
                    <td className="px-[18px] py-2.5 font-mono text-[12.5px]">{q.domain}</td>
                    <td className="px-[18px] py-2.5 text-muted-foreground">{q.client}</td>
                    <td className="px-[18px] py-2.5">
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        <span className={cn("h-2 w-2 rounded-full", blocked ? "bg-destructive" : "bg-green-500")} />
                        {blocked ? "Blocked" : "Allowed"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </ListCard>
    </div>
  );
}

function LocalNamesCard({ aRecords, cnames, onChanged, setError }: { aRecords: ARecord[]; cnames: CnameRecord[]; onChanged: () => void; setError: (s: string) => void; }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [points, setPoints] = useState("");
  const [busy, setBusy] = useState(false);

  const rows = [
    ...aRecords.map((r) => ({ kind: "A" as const, name: r.domain, points: r.ip })),
    ...cnames.map((r) => ({ kind: "CNAME" as const, name: r.domain, points: r.target })),
  ];

  async function add() {
    if (!name.trim() || !points.trim()) return;
    setBusy(true);
    try {
      const headers = await csrfHeaders();
      const ip = looksLikeIp(points);
      const res = await fetch(ip ? "/api/apps/pihole/dns-records" : "/api/apps/pihole/cname-records", {
        method: "POST", headers,
        body: JSON.stringify(ip ? { domain: name.trim(), ip: points.trim() } : { domain: name.trim(), target: points.trim() }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to add name");
      setName(""); setPoints(""); setAdding(false); onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to add name"); }
    finally { setBusy(false); }
  }

  async function remove(row: { kind: "A" | "CNAME"; name: string; points: string }) {
    setBusy(true);
    try {
      const headers = await csrfHeaders();
      const res = await fetch(row.kind === "A" ? "/api/apps/pihole/dns-records" : "/api/apps/pihole/cname-records", {
        method: "DELETE", headers,
        body: JSON.stringify(row.kind === "A" ? { domain: row.name, ip: row.points } : { domain: row.name, target: row.points }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to remove name");
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to remove name"); }
    finally { setBusy(false); }
  }

  return (
    <ListCard title="Local names" headerRight={
      <Button variant="outline" size="sm" className="h-[30px]" onClick={() => setAdding((v) => !v)}>
        <Plus className="h-3.5 w-3.5" />Add name
      </Button>
    }>
      {adding && (
        <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-[18px] py-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="name (e.g. nas.home)" className="h-9 w-48" />
          <span className="text-muted-foreground">→</span>
          <Input value={points} onChange={(e) => setPoints(e.target.value)} placeholder="192.168.x.x or target.domain" className="h-9 w-56" />
          <Button size="sm" className="h-9" disabled={busy || !name.trim() || !points.trim()} onClick={add}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Add
          </Button>
          <Button size="sm" variant="ghost" className="h-9" onClick={() => { setAdding(false); setName(""); setPoints(""); }}><X className="h-4 w-4" /></Button>
        </div>
      )}
      {rows.length === 0 && !adding ? <Empty>No local names yet.</Empty> : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <th className="px-[18px] py-2.5 font-semibold">Name</th>
              <th className="px-[18px] py-2.5 font-semibold">Points to</th>
              <th className="px-[18px] py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.kind}-${row.name}-${row.points}`} className="border-t">
                <td className="px-[18px] py-2.5 font-mono text-[12.5px]">{row.name} {row.kind === "CNAME" && <Badge variant="secondary" className="ml-1 text-[10px]">alias</Badge>}</td>
                <td className="px-[18px] py-2.5 font-mono text-[12.5px] text-muted-foreground">{row.points}</td>
                <td className="px-[18px] py-2.5 text-right">
                  <button className="text-muted-foreground hover:text-destructive" disabled={busy} onClick={() => remove(row)} aria-label="Remove"><Trash2 className="h-4 w-4" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ListCard>
  );
}

/* ─────────────────────────── Routes ─────────────────────────── */

function RoutesPanel() {
  const [routes, setRoutes] = useState<ProxyRoute[]>([]);
  const [config, setConfig] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    const res = await fetch("/settings/api/caddy/routes");
    if (res.ok) setRoutes((await res.json()).routes || []);
    else setError((await res.json().catch(() => ({}))).error || "The web gateway is unavailable.");
    const cfg = await fetch("/settings/api/caddy/config");
    if (cfg.ok) setConfig((await cfg.json()).config ?? null);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">How requests reach your apps. Routes are managed automatically as you install apps and set your domain.</p>
      {error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive">{error}</div>}

      <ListCard title="Proxy routes" headerRight={<Button variant="outline" size="sm" className="h-[30px]" onClick={load}><RefreshCw className="h-3.5 w-3.5" />Refresh</Button>}>
        {routes.length === 0 ? <Empty>No proxy routes.</Empty> : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <th className="px-[18px] py-2.5 font-semibold">Incoming</th>
                <th className="px-[18px] py-2.5 font-semibold">Forwards to</th>
                <th className="px-[18px] py-2.5 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="px-[18px] py-2.5 font-mono text-[12.5px]">{r.hostname ? r.hostname : ""}{r.path}</td>
                  <td className="px-[18px] py-2.5 font-mono text-[12.5px] text-muted-foreground">{r.upstream}:{r.port}</td>
                  <td className="px-[18px] py-2.5">
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <span className={cn("h-2 w-2 rounded-full", r.enabled ? "bg-green-500" : "bg-muted-foreground")} />
                      {r.enabled ? "Active" : "Disabled"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ListCard>

      {config != null && (
        <details className="rounded-xl border bg-card">
          <summary className="flex cursor-pointer items-center gap-2 px-[18px] py-3 text-sm font-medium text-muted-foreground">
            <ChevronRight className="h-4 w-4" />Advanced — raw gateway config
          </summary>
          <pre className="max-h-96 overflow-auto border-t bg-muted/40 p-4 text-[11.5px] leading-relaxed">{JSON.stringify(config, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

/* ─────────────────────── Domain & HTTPS ─────────────────────── */

function DomainPanel() {
  const [domain, setDomain] = useState<string | null>(null);
  const [caddyRunning, setCaddyRunning] = useState(true);
  const [tls, setTls] = useState<TlsStatus | null>(null);
  const [provider, setProvider] = useState<DnsProviderState | null>(null);
  const [names, setNames] = useState<NamesStatus | null>(null);
  const [edit, setEdit] = useState("");
  const [providerDomain, setProviderDomain] = useState("");
  const [providerToken, setProviderToken] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [providerBusy, setProviderBusy] = useState<string | null>(null);
  const [namesBusy, setNamesBusy] = useState<string | null>(null);
  const [releaseConfirmation, setReleaseConfirmation] = useState("");
  const [namesNoticeAccepted, setNamesNoticeAccepted] = useState(false);
  const [replacingToken, setReplacingToken] = useState(false);
  const [saved, setSaved] = useState("");
  // Server URL change flow
  const [tlsChoice, setTlsChoice] = useState<"selfsigned" | "provider">("selfsigned");
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<Array<{ step: string; status: string; message?: string }>>([]);
  const [changeRunning, setChangeRunning] = useState(false);
  const [changeDone, setChangeDone] = useState<null | { newUrl: string }>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    const dRes = await fetch("/api/domain");
    if (dRes.ok) {
      const d = await dRes.json();
      setDomain(d.domain ?? null);
      setCaddyRunning(d.caddyRunning ?? false);
      setEdit(d.domain ?? "");
      setProviderDomain((prev) => prev || d.domain || "");
    }
    const tRes = await fetch("/api/tls/status");
    if (tRes.ok) setTls(await tRes.json());
    const pRes = await fetch("/api/dns-providers");
    if (pRes.ok) setProvider(await pRes.json());
    const nRes = await fetch("/api/tls/youeye-names/status", { cache: "no-store" });
    if (nRes.ok) setNames(await nRes.json());
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  /**
   * Full server-URL change: streams the reconfigure engine's SSE progress.
   * (The old shallow POST /api/domain path left apps, SSO and env files on the
   * previous domain — every URL change now goes through /api/setup/reconfigure.)
   */
  async function runSse(url: string, body: unknown) {
    setProgress([]); setChangeDone(null); setChangeRunning(true); setError(""); setSaved("");
    try {
      const res = await fetch(url, { method: "POST", headers: await csrfHeaders(), body: JSON.stringify(body) });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "Request failed");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let sawComplete: { newUrl: string } | null = null;
      for (;;) {
        // The Control Panel restarts itself ~2s after the final event; a dropped
        // connection after `complete` is success, not an error.
        let done = false; let value: Uint8Array | undefined;
        try { ({ done, value } = await reader.read()); } catch { done = true; }
        if (value) buf += decoder.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() || "";
        for (const chunk of chunks) {
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;
          let evt: { step?: string; status?: string; message?: string; complete?: boolean; newUrl?: string; error?: string };
          try { evt = JSON.parse(payload); } catch { continue; }
          if (evt.error) throw new Error(evt.error);
          if (evt.complete && evt.newUrl) { sawComplete = { newUrl: evt.newUrl }; continue; }
          if (evt.step && evt.step !== "complete") {
            setProgress((prev) => {
              const next = [...prev];
              const idx = next.findIndex((p) => p.step === evt.step);
              const entry = { step: evt.step!, status: evt.status || "running", message: evt.message };
              if (idx >= 0) next[idx] = entry; else next.push(entry);
              return next;
            });
          }
        }
        if (done) break;
      }
      if (!sawComplete) throw new Error("The change did not complete — check the server and try again.");
      setChangeDone(sawComplete);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Server URL change failed");
    } finally {
      setChangeRunning(false);
    }
  }

  async function startUrlChange() {
    setConfirming(false); setEditing(false);
    await runSse("/api/setup/reconfigure", { domain: hostOnly(edit), tls: tlsChoice });
  }

  /** Import a saved YouEye Names / BYO domain bundle and switch to it live. */
  async function importBundleFile(file: File) {
    setError(""); setSaved("");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setError("That file is not a valid bundle (expected JSON).");
      return;
    }
    let url: string;
    if (parsed?.type === "youeye-byo-domain") {
      url = "/api/tls/domain/apply";
    } else if (parsed?.name && parsed?.identity && parsed?.tls) {
      url = "/api/tls/youeye-names/apply";
    } else {
      setError("Unrecognized bundle — expected a YouEye Names bundle or a youeye-byo-domain export.");
      return;
    }
    await runSse(url, parsed);
  }

  function resetChangeFlow() {
    setProgress([]); setChangeDone(null); setEdit(domain ?? ""); load();
  }

  async function connectProvider() {
    if (!providerDomain.trim() || !providerToken.trim()) return;
    setProviderBusy("connect"); setError(""); setSaved("");
    try {
      const requestedDomain = hostOnly(providerDomain);
      const currentDomain = domain ? hostOnly(domain) : "";
      if (currentDomain && requestedDomain !== currentDomain) {
        throw new Error("Change the platform domain first, then connect its DNS provider.");
      }
      const headers = await csrfHeaders();
      const res = await fetch("/api/dns-providers/connect", {
        method: "POST", headers,
        body: JSON.stringify({ provider: "cloudflare", domain: requestedDomain, token: providerToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.sync?.error || "Failed to connect DNS provider");
      const certRes = await fetch("/api/tls/acme/provider", { method: "POST", headers });
      const certData = await certRes.json().catch(() => ({}));
      if (!certRes.ok) throw new Error(certData.error || "DNS connected, but certificate issuance failed");
      setProviderToken("");
      setReplacingToken(false);
      setSaved("DNS provider connected and certificate issued");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to connect DNS provider"); }
    finally { setProviderBusy(null); }
  }

  async function syncProvider() {
    setProviderBusy("sync"); setError(""); setSaved("");
    try {
      const res = await fetch("/api/dns-providers/sync", { method: "POST", headers: await csrfHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "DNS sync failed");
      setSaved("DNS records synced");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "DNS sync failed"); }
    finally { setProviderBusy(null); }
  }

  async function renewProvider() {
    setProviderBusy("renew"); setError(""); setSaved("");
    try {
      const res = await fetch("/api/dns-providers/maintenance", {
        method: "POST", headers: await csrfHeaders(), body: JSON.stringify({ force: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Certificate renewal failed");
      setSaved(data.renewed ? "Certificate renewed" : data.reason || "Certificate checked");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Certificate renewal failed"); }
    finally { setProviderBusy(null); }
  }

  async function disconnectProvider() {
    setProviderBusy("disconnect"); setError(""); setSaved("");
    try {
      const res = await fetch("/api/dns-providers/connection", { method: "DELETE", headers: await csrfHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to disconnect DNS provider");
      setReplacingToken(false);
      setSaved("DNS provider disconnected");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to disconnect DNS provider"); }
    finally { setProviderBusy(null); }
  }

  async function downloadDomainBundle(includeToken = false) {
    if (includeToken && !window.confirm("Exporting with the DNS token creates a bundle that can edit DNS for this zone. Keep it private.")) {
      return;
    }
    setProviderBusy(includeToken ? "export-token" : "export"); setError(""); setSaved("");
    try {
      const res = await fetch(`/api/tls/domain/export${includeToken ? "?includeToken=true" : ""}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Domain export failed");
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") || "";
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] || "youeye-domain.bundle.json";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setSaved(includeToken ? "Domain bundle exported with DNS token" : "Domain bundle exported");
    } catch (e) { setError(e instanceof Error ? e.message : "Domain export failed"); }
    finally { setProviderBusy(null); }
  }

  async function namesAction(action: "check-now" | "accept-current-terms") {
    setNamesBusy(action); setError(""); setSaved("");
    try {
      const response = await fetch("/api/tls/youeye-names/status", {
        method: "POST",
        headers: await csrfHeaders(),
        body: JSON.stringify({ action }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "YouEye Names check failed");
      setSaved(action === "accept-current-terms" ? "Current certificate notice accepted" : "YouEye Names checked");
      if (action === "accept-current-terms") setNamesNoticeAccepted(false);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "YouEye Names check failed"); }
    finally { setNamesBusy(null); }
  }

  async function downloadNamesFile(path: "export" | "service-data") {
    setNamesBusy(path); setError(""); setSaved("");
    try {
      const response = await fetch(`/api/tls/youeye-names/${path}`, { cache: "no-store" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "YouEye Names export failed");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") || "";
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] || `youeye-names-${path}.json`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
      setSaved(path === "export" ? "Recovery bundle exported" : "Service data exported");
    } catch (e) { setError(e instanceof Error ? e.message : "YouEye Names export failed"); }
    finally { setNamesBusy(null); }
  }

  async function releaseNamesAddress() {
    setNamesBusy("release"); setError(""); setSaved("");
    try {
      const response = await fetch("/api/tls/youeye-names/release", {
        method: "POST",
        headers: await csrfHeaders(),
        body: JSON.stringify({ confirmation: releaseConfirmation }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not release the name");
      setReleaseConfirmation("");
      setSaved("YouEye Name released and certificate revocation queued");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not release the name"); }
    finally { setNamesBusy(null); }
  }

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  const internalCert = tls?.mode === "internal" || !tls?.hasExternalCert;
  const connection = provider?.connection || null;

  return (
    <div className="space-y-6">
      {error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive">{error}</div>}

      {/* Server URL */}
      <div className="rounded-xl border bg-card p-[22px]">
        <h2 className="text-[15px] font-semibold">Server URL</h2>
        <p className="mt-1 text-sm text-muted-foreground">The address people use to reach this server. Changing it moves YouEye ID, the dashboard, and every installed app to the new name.</p>
        {!caddyRunning && <p className="mt-3 text-sm text-destructive">The web gateway is not running, so the server URL cannot be changed right now.</p>}

        {(changeRunning || changeDone || progress.length > 0) ? (
          <div className="mt-4 space-y-3">
            <div className="rounded-lg border bg-muted/30 p-3">
              <ul className="space-y-1.5">
                {progress.map((p) => (
                  <li key={p.step} className="flex items-start gap-2 text-sm">
                    {p.status === "running" ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                      : p.status === "error" ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                      : <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-500" />}
                    <span className={cn(p.status === "error" && "text-destructive")}>
                      <span className="font-medium">{stepLabel(p.step)}</span>
                      {p.message ? <span className="text-muted-foreground"> — {p.message}</span> : null}
                    </span>
                  </li>
                ))}
                {progress.length === 0 && changeRunning && (
                  <li className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Starting…</li>
                )}
              </ul>
            </div>
            {changeDone && (
              <div className="rounded-lg border border-green-600/30 bg-green-500/5 p-3 text-sm">
                <p className="font-medium text-green-700 dark:text-green-500">Server URL changed.</p>
                <p className="mt-1 text-muted-foreground">The server is restarting on its new address. Everyone must sign in again{tlsChoice === "selfsigned" ? ", and browsers must trust the new certificate" : ""}.</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button size="sm" className="h-8" onClick={() => { window.location.href = changeDone.newUrl; }}>Continue to {changeDone.newUrl.replace(/^https:\/\//, "")}</Button>
                  <Button size="sm" variant="ghost" className="h-8" onClick={resetChangeFlow}>Stay here</Button>
                </div>
              </div>
            )}
            {!changeRunning && !changeDone && (
              <Button size="sm" variant="outline" className="h-8" onClick={resetChangeFlow}>Back</Button>
            )}
          </div>
        ) : editing ? (
          <div className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <LabelText>New server URL</LabelText>
              <Input value={edit} onChange={(e) => setEdit(e.target.value)} placeholder="my-server.example.com" className="h-9 w-72 font-mono" />
            </div>
            <div className="space-y-2">
              <LabelText>Certificate for the new name</LabelText>
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input type="radio" className="mt-1" checked={tlsChoice === "selfsigned"} onChange={() => setTlsChoice("selfsigned")} />
                <span><span className="font-medium">Self-signed</span> <span className="text-muted-foreground">— works for any name; browsers warn until the new certificate is trusted.</span></span>
              </label>
              <label className={cn("flex items-start gap-2 text-sm", connection ? "cursor-pointer" : "cursor-not-allowed opacity-50")}>
                <input type="radio" className="mt-1" disabled={!connection} checked={tlsChoice === "provider"} onChange={() => setTlsChoice("provider")} />
                <span><span className="font-medium">Let&apos;s Encrypt via {connection ? `Cloudflare (${connection.zoneName})` : "a DNS provider"}</span> <span className="text-muted-foreground">— trusted certificate; the new name must live in the connected zone.</span></span>
              </label>
              <p className="text-xs text-muted-foreground">For a saved YouEye Name or exported domain, use “Import saved name” instead. Let&apos;s Encrypt for a new public domain: connect its DNS provider below after (or before) the change.</p>
            </div>
            {confirming ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                <p className="font-medium">Change the server URL to <span className="font-mono">{hostOnly(edit)}</span>?</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                  <li>Everyone is signed out and must sign in again at the new address.</li>
                  <li>Installed apps restart briefly while they move to the new name.</li>
                  <li>Other devices need your DNS to point <span className="font-mono">{hostOnly(edit)}</span> and <span className="font-mono">*.{hostOnly(edit)}</span> at this server.</li>
                  {tlsChoice === "selfsigned" && <li>Browsers will warn until the new self-signed certificate is trusted.</li>}
                </ul>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" className="h-8" onClick={startUrlChange}>Yes, change the server URL</Button>
                  <Button size="sm" variant="ghost" className="h-8" onClick={() => setConfirming(false)}>Back</Button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" className="h-9" disabled={!edit.trim() || hostOnly(edit) === (domain || "")} onClick={() => setConfirming(true)}>Continue</Button>
                <Button size="sm" variant="ghost" className="h-9" onClick={() => { setEditing(false); setConfirming(false); setEdit(domain ?? ""); }}>Cancel</Button>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{domain || <span className="text-muted-foreground">Not set</span>}</span>
            {caddyRunning && <Button size="sm" variant="outline" className="h-8" onClick={() => { setEditing(true); setConfirming(false); }}>Change</Button>}
            {caddyRunning && (
              <label className="inline-flex">
                <input
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) importBundleFile(f);
                  }}
                />
                <span className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border bg-background px-3 text-sm font-medium shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground">
                  <Download className="h-3.5 w-3.5" />Import saved name
                </span>
              </label>
            )}
          </div>
        )}
        {saved && <p className="mt-2 text-sm text-green-600 dark:text-green-500">{saved}</p>}
      </div>

      {/* YouEye Names lifecycle */}
      {names?.state && (
        <div className="rounded-xl border bg-card p-[22px]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[15px] font-semibold">YouEye Names</h2>
              <p className="mt-1 text-sm text-muted-foreground">Lease, DNS and certificate lifecycle for your managed address.</p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-sm font-medium capitalize">
              <span className={cn("h-2 w-2 rounded-full", names.state.status === "healthy" ? "bg-green-500" : names.state.status === "renewing" ? "bg-blue-500" : names.state.status === "released" ? "bg-muted-foreground" : "bg-amber-500")} />
              {names.state.status}
            </span>
          </div>
          <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
            <Field label="Managed address" value={names.state.fqdn} />
            <Field label="Certificate expires" value={names.state.certificate ? fmtDate(names.state.certificate.expiresAt) : "Provisioning"} />
            <Field label="Last service contact" value={fmtDateTime(names.state.lastBrokerContactAt)} />
            <Field label="Next automatic check" value={fmtDateTime(names.state.nextCheckAt)} />
          </div>
          <div className="mt-4 rounded-lg border bg-muted/20 p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className={cn("h-2 w-2 rounded-full", !names.serviceReachable || !names.readiness?.installation.canProceedNow ? "bg-red-500" : names.readiness.installation.state === "degraded" ? "bg-amber-500" : "bg-green-500")} />
              <span className="font-medium">
                {!names.serviceReachable ? "Service offline" : names.readiness?.installation.state === "degraded" ? "Service available with reduced redundancy" : names.readiness?.installation.canProceedNow ? "Service available" : "New addresses paused"}
              </span>
            </div>
            {names.readiness && (
              <p className="mt-1 text-xs text-muted-foreground">
                DNS {names.readiness.dns.state}; {names.readiness.initialCertificate.primary.provider === "google-public-ca" ? "Google Public CA" : "Let's Encrypt"} {names.readiness.initialCertificate.primary.state}; fallback {names.readiness.initialCertificate.fallback.state}. Availability is not an issuance promise.
              </p>
            )}
            {names.readiness?.installation.reasonCodes?.length ? (
              <details className="mt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer">Technical details</summary>
                <p className="mt-1 font-mono">{names.readiness.installation.reasonCodes.join(", ")}</p>
              </details>
            ) : null}
          </div>
          {!names.certificateMatches && names.state.status !== "released" && (
            <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
              The active certificate does not match this managed address. Your existing certificate was left unchanged.
            </div>
          )}
          {names.state.lastError && (
            <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
              {names.state.lastError.code === "certificate_terms_version_required"
                ? "The certificate notice changed and needs your review before renewal."
                : "The latest lifecycle check needs attention."}
              {names.state.lastError.requestId ? ` Reference: ${names.state.lastError.requestId}` : ""}
            </div>
          )}
          {names.currentTerms && (
            <div className="mt-3 rounded-lg border bg-muted/30 p-3">
              <p className="text-sm font-medium">Certificate and privacy notice</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{names.currentTerms.summary}</p>
              <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm">
                <input type="checkbox" checked={namesNoticeAccepted} onChange={(event) => setNamesNoticeAccepted(event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-input accent-primary" />
                <span>I understand that this address and its certificates appear in public Certificate Transparency logs.</span>
              </label>
              <p className="mt-2 text-xs text-muted-foreground">Certificate terms {names.currentTerms.version}</p>
            </div>
          )}
          {names.state.status !== "released" && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="h-8" disabled={!!namesBusy} onClick={() => namesAction("check-now")}>
                {namesBusy === "check-now" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}Check now
              </Button>
              {(!names.state.termsVersion || names.state.lastError?.code === "certificate_terms_version_required") && (
                <Button size="sm" variant="outline" className="h-8" disabled={!!namesBusy || !namesNoticeAccepted || !names.currentTerms} onClick={() => namesAction("accept-current-terms")}>
                  <Shield className="h-3.5 w-3.5" />Review and accept current notice
                </Button>
              )}
              <Button size="sm" variant="outline" className="h-8" disabled={!!namesBusy} onClick={() => downloadNamesFile("export")}>
                <Download className="h-3.5 w-3.5" />Recovery bundle
              </Button>
              <Button size="sm" variant="ghost" className="h-8" disabled={!!namesBusy} onClick={() => downloadNamesFile("service-data")}>
                <Download className="h-3.5 w-3.5" />Service data
              </Button>
            </div>
          )}
          {names.state.status !== "released" && (
            <details className="mt-4 border-t pt-3">
              <summary className="cursor-pointer text-sm font-medium text-destructive">Release this name</summary>
              <p className="mt-2 text-xs text-muted-foreground">First change the server URL above. Releasing removes DNS and queues certificate revocation; it does not change this server’s URL for you.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Input value={releaseConfirmation} onChange={(event) => setReleaseConfirmation(event.target.value)} placeholder={`Type ${names.state.fqdn}`} className="h-8 max-w-xs font-mono text-xs" />
                <Button size="sm" variant="destructive" className="h-8" disabled={!!namesBusy || releaseConfirmation !== names.state.fqdn} onClick={releaseNamesAddress}>
                  {namesBusy === "release" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Release name
                </Button>
              </div>
            </details>
          )}
        </div>
      )}

      {/* DNS provider */}
      <div className="rounded-xl border bg-card p-[22px]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold">DNS provider</h2>
            <p className="mt-1 text-sm text-muted-foreground">Keep your domain and app subdomains pointed at this server.</p>
          </div>
          <Cloud className="h-5 w-5 text-muted-foreground" />
        </div>
        {connection ? (
          <div className="mt-4 space-y-4">
            <div className="grid gap-4 text-sm sm:grid-cols-2">
              <Field label="Provider" value={connection.provider === "cloudflare" ? "Cloudflare" : connection.provider} />
              <Field label="Zone" value={connection.zoneName} />
              <Field label="Target IP" value={connection.targetIp || "—"} />
              <Field label="Last sync" value={fmtDateTime(connection.lastDnsSyncAt)} />
            </div>
            {connection.lastDnsSyncError && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {connection.lastDnsSyncError}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="h-8" disabled={!!providerBusy} onClick={syncProvider}>
                {providerBusy === "sync" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}Sync DNS now
              </Button>
              <Button size="sm" variant="outline" className="h-8" disabled={!!providerBusy} onClick={() => { setProviderDomain(connection.domain); setProviderToken(""); setReplacingToken(true); }}>
                <KeyRound className="h-3.5 w-3.5" />Replace token
              </Button>
              <Button size="sm" variant="ghost" className="h-8 text-destructive hover:text-destructive" disabled={!!providerBusy} onClick={disconnectProvider}>
                {providerBusy === "disconnect" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}Disconnect
              </Button>
            </div>
            {!internalCert && (
              <div className="border-t pt-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-sm font-medium">Domain export</p>
                    <p className="mt-1 text-xs text-muted-foreground">Save the certificate, private key, provider zone, and optional DNS token for reinstall reuse.</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" className="h-8" disabled={!!providerBusy} onClick={() => downloadDomainBundle(false)}>
                      {providerBusy === "export" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}Export bundle
                    </Button>
                    <Button size="sm" variant="outline" className="h-8" disabled={!!providerBusy || !connection.hasToken} onClick={() => downloadDomainBundle(true)}>
                      {providerBusy === "export-token" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}With token
                    </Button>
                  </div>
                </div>
              </div>
            )}
            {replacingToken && (
              <div className="rounded-lg border bg-muted/30 p-3">
                <div className="space-y-1.5">
                  <LabelText>New Cloudflare token</LabelText>
                  <Input type="password" value={providerToken} onChange={(e) => setProviderToken(e.target.value)} placeholder="Paste token" className="h-9" />
                </div>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" className="h-8" disabled={!providerToken.trim() || !!providerBusy} onClick={connectProvider}>
                    {providerBusy === "connect" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}Save token
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8" onClick={() => { setReplacingToken(false); setProviderToken(""); }}>Cancel</Button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
              <div className="space-y-1.5">
                <LabelText>Domain</LabelText>
                <Input value={providerDomain} onChange={(e) => setProviderDomain(e.target.value)} placeholder="home.example.com" className="h-9 font-mono" />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <LabelText>Cloudflare token</LabelText>
                  <span className="group relative inline-flex">
                    <Info className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="pointer-events-none absolute right-0 z-10 mt-5 hidden w-72 rounded-xl border bg-popover p-3 text-xs text-popover-foreground shadow-lg group-hover:block">
                      Create a Cloudflare API token from the Edit zone DNS template. Scope it to this domain&apos;s zone and grant Zone - Zone - Read plus Zone - DNS - Edit.
                    </span>
                  </span>
                </div>
                <Input type="password" value={providerToken} onChange={(e) => setProviderToken(e.target.value)} placeholder="Paste token" className="h-9" />
              </div>
            </div>
            <Button size="sm" className="h-9" disabled={!providerDomain.trim() || !providerToken.trim() || !!providerBusy} onClick={connectProvider}>
              {providerBusy === "connect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />}
              Connect and secure domain
            </Button>
          </div>
        )}
      </div>

      {/* HTTPS / certificate */}
      <div className="rounded-xl border bg-card p-[22px]">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">HTTPS certificate</h2>
          <Button variant="outline" size="sm" className="h-8" onClick={load}><RefreshCw className="h-3.5 w-3.5" />Refresh</Button>
        </div>
        {tls?.expiryWarning && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-600 dark:text-amber-500">
            <AlertTriangle className="h-4 w-4" />This certificate expires soon.
          </div>
        )}
        {internalCert ? (
          <p className="mt-3 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Private/local certificate.</span> Browsers may warn unless you connect YouEye Names, a DNS provider, or upload a trusted certificate.
          </p>
        ) : (
          <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
            <Field label="Mode" value={tls?.mode} />
            <Field label="Issuer" value={tls?.cert?.issuer || "—"} />
            <Field label="Issued" value={fmtDate(tls?.cert?.issuedAt)} />
            <Field label="Expires" value={fmtDate(tls?.cert?.expiresAt)} />
            <Field label="Next renewal" value={fmtDateTime(connection?.nextCertRenewalDueAt)} />
          </div>
        )}
        {connection && !internalCert && (
          <div className="mt-4">
            <Button size="sm" variant="outline" className="h-8" disabled={!!providerBusy} onClick={renewProvider}>
              {providerBusy === "renew" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}Renew now
            </Button>
          </div>
        )}
        <div className="mt-4">
          <p className="mb-2 text-sm font-medium">Secured names</p>
          <div className="flex flex-wrap gap-2">
            {(tls?.subjects?.length ?? 0) > 0 ? tls!.subjects.map((s) => <Badge key={s} variant="secondary" className="font-mono text-[11px]">{s}</Badge>)
              : <span className="text-sm text-muted-foreground">{domain ? `${domain} (on demand)` : "No explicit names configured."}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── shared bits ─────────────────────────── */

/** Friendly labels for reconfigure SSE step keys (app_* → "App: <id>"). */
function stepLabel(step: string): string {
  const labels: Record<string, string> = {
    config: "Reading configuration",
    preflight: "DNS preflight",
    apps: "Finding installed apps",
    yaml: "Site configuration",
    caddy: "Web gateway routes",
    ai: "YouEye AI identity",
    dns: "Local DNS",
    dns_provider: "DNS provider",
    tls: "HTTPS certificate",
    sso_cp: "Control Panel sign-in",
    sso_ui: "Dashboard sign-in",
    ui_db: "Dashboard branding",
    identity: "YouEye ID",
    identity_import: "Name identity",
    cp_env: "Control Panel restart",
  };
  if (labels[step]) return labels[step];
  if (step.startsWith("app_")) return `App: ${step.slice(4)}`;
  return step;
}

function StatCard({ k, v, d }: { k: string; v: string; d: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs text-muted-foreground">{k}</div>
      <div className="mt-1 text-2xl font-bold tracking-tight">{v}</div>
      <div className="mt-1 text-xs text-muted-foreground">{d}</div>
    </div>
  );
}

function ListCard({ title, headerRight, children }: { title: string; headerRight?: ReactNode; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center justify-between px-[18px] py-3">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {headerRight}
      </div>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value?: string }) {
  return (<div><span className="text-muted-foreground">{label}</span><p className="font-medium">{value || "—"}</p></div>);
}

function LabelText({ children }: { children: ReactNode }) {
  return <span className="text-xs font-medium text-muted-foreground">{children}</span>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="border-t px-[18px] py-8 text-center text-sm text-muted-foreground">{children}</div>;
}

function fmtDate(iso?: string) {
  if (!iso) return "—";
  try { return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(new Date(iso)); }
  catch { return iso; }
}

function fmtDateTime(iso?: string | null) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
