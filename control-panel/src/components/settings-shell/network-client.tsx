"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Shield, ShieldOff, Globe, Route as RouteIcon, Plus, Trash2, Loader2, RefreshCw,
  Check, X, AlertTriangle, ChevronRight,
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

// FTL puts its status string in `reply`; treat gravity/deny/black/regex/block as blocked.
const isBlockedReply = (reply: string) => /gravity|deny|black|regex|block/i.test(reply || "");
const looksLikeIp = (v: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(v.trim()) || (v.includes(":") && /^[0-9a-fA-F:]+$/.test(v.trim()));

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

export function NetworkClient() {
  const [active, setActive] = useState<NetworkTab>(() => {
    if (typeof window !== "undefined") {
      const t = new URLSearchParams(window.location.search).get("tab");
      if (t === "routes" || t === "domain") return t;
      if (t === "tls") return "domain"; // legacy ?tab=tls
    }
    return "dns";
  });

  const tabs: { id: NetworkTab; label: string; icon: typeof Shield }[] = [
    { id: "dns", label: "DNS", icon: Shield },
    { id: "routes", label: "Routes", icon: RouteIcon },
    { id: "domain", label: "Domain & HTTPS", icon: Globe },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Network</h1>
      <p className="mt-1 text-muted-foreground">DNS, routes, and how your server is reached</p>

      <div className="mb-6 mt-6 flex items-center gap-1 border-b">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setActive(id)} className={tabClass(active === id)}>
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
  const [edit, setEdit] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    const dRes = await fetch("/api/domain");
    if (dRes.ok) { const d = await dRes.json(); setDomain(d.domain ?? null); setCaddyRunning(d.caddyRunning ?? false); setEdit(d.domain ?? ""); }
    const tRes = await fetch("/api/tls/status");
    if (tRes.ok) setTls(await tRes.json());
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function saveDomain() {
    if (!edit.trim()) return;
    setSaving(true); setError(""); setSaved("");
    try {
      const res = await fetch("/api/domain", { method: "POST", headers: await csrfHeaders(), body: JSON.stringify({ domain: edit.trim() }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to set domain");
      setSaved("Domain updated"); setEditing(false); load();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to set domain"); }
    finally { setSaving(false); }
  }

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  const auto = tls?.mode === "internal" || !tls?.hasExternalCert;

  return (
    <div className="space-y-6">
      {error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive">{error}</div>}

      {/* Domain */}
      <div className="rounded-xl border bg-card p-[22px]">
        <h2 className="text-[15px] font-semibold">Domain</h2>
        <p className="mt-1 text-sm text-muted-foreground">The address people use to reach this server.</p>
        {!caddyRunning && <p className="mt-3 text-sm text-destructive">The web gateway isn’t running, so the domain can’t be changed right now.</p>}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              <Input value={edit} onChange={(e) => setEdit(e.target.value)} placeholder="example.com" className="h-9 w-72" />
              <Button size="sm" className="h-9" disabled={saving || !edit.trim()} onClick={saveDomain}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Save</Button>
              <Button size="sm" variant="ghost" className="h-9" onClick={() => { setEditing(false); setEdit(domain ?? ""); }}>Cancel</Button>
            </>
          ) : (
            <>
              <span className="font-mono text-sm">{domain || <span className="text-muted-foreground">Not set</span>}</span>
              {caddyRunning && <Button size="sm" variant="outline" className="h-8" onClick={() => setEditing(true)}>Change</Button>}
            </>
          )}
        </div>
        {saved && <p className="mt-2 text-sm text-green-600 dark:text-green-500">{saved}</p>}
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
        {auto ? (
          <p className="mt-3 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Automatic.</span> Certificates are issued and renewed on demand for any domain that points at this server — nothing to configure.
          </p>
        ) : (
          <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
            <Field label="Mode" value={tls?.mode} />
            <Field label="Issuer" value={tls?.cert?.issuer || "—"} />
            <Field label="Issued" value={fmtDate(tls?.cert?.issuedAt)} />
            <Field label="Expires" value={fmtDate(tls?.cert?.expiresAt)} />
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

function Empty({ children }: { children: ReactNode }) {
  return <div className="border-t px-[18px] py-8 text-center text-sm text-muted-foreground">{children}</div>;
}

function fmtDate(iso?: string) {
  if (!iso) return "—";
  try { return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(new Date(iso)); }
  catch { return iso; }
}
