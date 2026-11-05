"use client";

import { PageHeader } from "./page-header";

import { useLocale } from "next-intl";
import { useTranslations as useInterfaceTranslations } from "next-intl";
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
  const translateInterface = useInterfaceTranslations("interface");

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
    { id: "routes", label: translateInterface("m2c5b669bcdeb"), icon: RouteIcon },
    { id: "domain", label: translateInterface("mf54c56a2bb3a"), icon: Globe },
  ];

  return (
    <div>
      <PageHeader title={translateInterface("m1744b96470b5")} description={translateInterface("m064ef230fb7a")} />

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
  const locale = useLocale();

  const translateInterface = useInterfaceTranslations("interface");

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
      setError((await statsRes.json().catch(() => ({}))).error || translateInterface("me08e6a96705b"));
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
  }, [translateInterface]);

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
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || translateInterface("m031a8f0f659d"));
      setStats({ ...stats, status: enabling ? "enabled" : "disabled" });
    } catch (e) { setError(translateInterface("m76a924ac4068")); }
    finally { setBusy(null); }
  }

  async function toggleList(list: Adlist) {
    setBusy(list.address);
    try {
      const res = await fetch("/api/apps/pihole/lists", {
        method: "PATCH", headers: await csrfHeaders(),
        body: JSON.stringify({ address: list.address, enabled: !list.enabled, comment: list.comment, type: list.type }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || translateInterface("m031a8f0f659d"));
      setLists((prev) => prev.map((l) => (l.address === list.address ? { ...l, enabled: !l.enabled } : l)));
    } catch (e) { setError(translateInterface("m7f6d50a1796d")); }
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
        <StatCard k={translateInterface("mbafd50b65999")} v={(stats?.queriesToday ?? 0).toLocaleString(locale)} d={translateInterface("mdfbd3085a1d4")} />
        <StatCard k={translateInterface("m18f2a0947f9d")} v={`${Number(stats?.adsPercentage ?? 0).toLocaleString(locale, {maximumFractionDigits: 0})}%`} d={translateInterface("mfaee534bf5d9", {count: stats?.adsBlockedToday ?? 0})} />
        <StatCard k={translateInterface("mdec55eff52c6")} v={(stats?.domainsBlocked ?? 0).toLocaleString(locale)} d={translateInterface("m25946dbb077a", {count: lists.length})} />
        <div className="rounded-xl border bg-card p-4">
          <div className="text-xs text-muted-foreground">{translateInterface("mf778a33133e5")}</div>
          <div className="mt-1 flex items-center gap-3">
            <span className="text-xl font-bold">{blocking ? translateInterface("m130011756125") : translateInterface("mca7981b46ecf")}</span>
            <Switch checked={!!blocking} disabled={busy === "blocking"} onCheckedChange={toggleBlocking} aria-label={translateInterface("mb7c8e60164f1")} />
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{translateInterface("m621200920682")}</div>
        </div>
      </div>

      {/* Local names */}
      <LocalNamesCard
        aRecords={aRecords} cnames={cnames}
        onChanged={load}
        setError={setError}
      />

      {/* Blocklists */}
      <ListCard title={translateInterface("mdec55eff52c6")} headerRight={<span className="text-xs text-muted-foreground">{translateInterface("m74c92d1f4ffd")}</span>}>
        {lists.length === 0 ? (
          <Empty>{translateInterface("mcb13f911b67e")}</Empty>
        ) : lists.map((list) => (
          <div key={list.address} className="flex items-center gap-3 border-t px-[18px] py-3 first:border-t-0">
            <div className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-muted text-muted-foreground">
              {list.enabled ? <Shield className="h-4 w-4" /> : <ShieldOff className="h-4 w-4" />}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{list.comment || list.address}</div>
              <div className="truncate text-xs text-muted-foreground">
                {(list.number ?? 0).toLocaleString(locale)} {translateInterface("m1b0ec1954eec")}{list.enabled ? "" : translateInterface("m62a5b50f644f")}
              </div>
            </div>
            <div className="ml-auto">
              <Switch checked={list.enabled} disabled={busy === list.address} onCheckedChange={() => toggleList(list)} aria-label={translateInterface("ma388de157cab", { value0: String(list.comment || list.address) })} />
            </div>
          </div>
        ))}
      </ListCard>

      {/* Recent queries */}
      <ListCard title={translateInterface("m164ca8d051af")} headerRight={
        <button className="text-sm text-primary hover:underline" onClick={() => { const n = queryLimit >= 100 ? 12 : 100; setQueryLimit(n); loadQueries(n); }}>
          {queryLimit >= 100 ? translateInterface("m94ea9b1d33a0") : translateInterface("m30a64216eaea")}
        </button>
      }>
        {queries.length === 0 ? <Empty>{translateInterface("m74924c38d7e4")}</Empty> : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <th className="px-[18px] py-2.5 font-semibold">{translateInterface("m79fa33618d8e")}</th>
                <th className="px-[18px] py-2.5 font-semibold">{translateInterface("m6ba0bdeccb42")}</th>
                <th className="px-[18px] py-2.5 font-semibold">{translateInterface("m6e7d50e84f47")}</th>
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
                        {blocked ? translateInterface("m18f2a0947f9d") : translateInterface("m1bb201d18835")}
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
  const translateInterface = useInterfaceTranslations("interface");

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
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || translateInterface("m03dc729b8bac"));
      setName(""); setPoints(""); setAdding(false); onChanged();
    } catch (e) { setError(translateInterface("m03dc729b8bac")); }
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
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || translateInterface("mf4e0d91d1afe"));
      onChanged();
    } catch (e) { setError(translateInterface("mf4e0d91d1afe")); }
    finally { setBusy(false); }
  }

  return (
    <ListCard title={translateInterface("m30d2231aa939")} headerRight={
      <Button variant="outline" size="sm" className="h-[30px]" onClick={() => setAdding((v) => !v)}>
        <Plus className="h-3.5 w-3.5" />{translateInterface("m98fbfd0278d9")}</Button>
    }>
      {adding && (
        <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-[18px] py-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={translateInterface("m2bc675e44996")} className="h-9 w-48" />
          <span className="text-muted-foreground">→</span>
          <Input value={points} onChange={(e) => setPoints(e.target.value)} placeholder={translateInterface("mf4b4164b1c1b")} className="h-9 w-56" />
          <Button size="sm" className="h-9" disabled={busy || !name.trim() || !points.trim()} onClick={add}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{translateInterface("m9fd728c66c9a")}</Button>
          <Button size="sm" variant="ghost" className="h-9" onClick={() => { setAdding(false); setName(""); setPoints(""); }}><X className="h-4 w-4" /></Button>
        </div>
      )}
      {rows.length === 0 && !adding ? <Empty>{translateInterface("maa576e18e487")}</Empty> : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <th className="px-[18px] py-2.5 font-semibold">{translateInterface("mdcd1d5223f73")}</th>
              <th className="px-[18px] py-2.5 font-semibold">{translateInterface("m6dca1c151c38")}</th>
              <th className="px-[18px] py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.kind}-${row.name}-${row.points}`} className="border-t">
                <td className="px-[18px] py-2.5 font-mono text-[12.5px]">{row.name} {row.kind === "CNAME" && <Badge variant="secondary" className="ml-1 text-[10px]">{translateInterface("m1a0a6a36ca0a")}</Badge>}</td>
                <td className="px-[18px] py-2.5 font-mono text-[12.5px] text-muted-foreground">{row.points}</td>
                <td className="px-[18px] py-2.5 text-right">
                  <button className="text-muted-foreground hover:text-destructive" disabled={busy} onClick={() => remove(row)} aria-label={translateInterface("mc3812fc4acb8")}><Trash2 className="h-4 w-4" /></button>
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
  const translateInterface = useInterfaceTranslations("interface");

  const [routes, setRoutes] = useState<ProxyRoute[]>([]);
  const [config, setConfig] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    const res = await fetch("/settings/api/caddy/routes");
    if (res.ok) setRoutes((await res.json()).routes || []);
    else setError((await res.json().catch(() => ({}))).error || translateInterface("m3a4f4b4a0103"));
    const cfg = await fetch("/settings/api/caddy/config");
    if (cfg.ok) setConfig((await cfg.json()).config ?? null);
    setLoading(false);
  }, [translateInterface]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{translateInterface("md345018f60c7")}</p>
      {error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive">{error}</div>}

      <ListCard title={translateInterface("m0a1321f8d829")} headerRight={<Button variant="outline" size="sm" className="h-[30px]" onClick={load}><RefreshCw className="h-3.5 w-3.5" />{translateInterface("m0e9161011702")}</Button>}>
        {routes.length === 0 ? <Empty>{translateInterface("mdc16ccc1d689")}</Empty> : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <th className="px-[18px] py-2.5 font-semibold">{translateInterface("me301820ac839")}</th>
                <th className="px-[18px] py-2.5 font-semibold">{translateInterface("m34780568209b")}</th>
                <th className="px-[18px] py-2.5 font-semibold">{translateInterface("m920e413c7d41")}</th>
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
                      {r.enabled ? translateInterface("m92340695899b") : translateInterface("m75081b593d15")}
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
            <ChevronRight className="h-4 w-4" />{translateInterface("m7c25236d700d")}</summary>
          <pre className="max-h-96 overflow-auto border-t bg-muted/40 p-4 text-[11.5px] leading-relaxed">{JSON.stringify(config, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

/* ─────────────────────── Domain & HTTPS ─────────────────────── */

function DomainPanel() {
  const translateInterface = useInterfaceTranslations("interface");
function stepLabel(step: string): string {
  const labels: Record<string, string> = {
    config: translateInterface("m3acf25773311"),
    preflight: translateInterface("mb22a4c6caece"),
    apps: translateInterface("m1e8ab1971227"),
    yaml: translateInterface("me910c6ca6a63"),
    caddy: translateInterface("md30c5983e3ce"),
    ai: translateInterface("m14fc15c70dd6"),
    dns: translateInterface("m10e2ffbf07f7"),
    dns_provider: translateInterface("mc36f66f44922"),
    tls: translateInterface("m46743144dbd6"),
    sso_cp: "Control Panel sign-in",
    sso_ui: "Dashboard sign-in",
    ui_db: translateInterface("m1ccded1d1f50"),
    identity: "YouEye ID",
    identity_import: translateInterface("m3a1f32ecad45"),
    cp_env: translateInterface("m1687f61e9b04"),
  };
  if (labels[step]) return labels[step];
  if (step.startsWith("app_")) return translateInterface("m6b7f4e994075", {app: step.slice(4)});
  return step;
}


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
        throw new Error((data as { error?: string }).error || translateInterface("mcfce761befa8"));
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
      if (!sawComplete) throw new Error(translateInterface("md545fe2b210b"));
      setChangeDone(sawComplete);
    } catch (e) {
      setError(translateInterface("mbe8b39c9424a"));
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
      setError(translateInterface("made0703356c1"));
      return;
    }
    let url: string;
    if (parsed?.type === "youeye-byo-domain") {
      url = "/api/tls/domain/apply";
    } else if (parsed?.name && parsed?.identity && parsed?.tls) {
      url = "/api/tls/youeye-names/apply";
    } else {
      setError(translateInterface("mce597c6b7515"));
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
        throw new Error(translateInterface("m83748e06044a"));
      }
      const headers = await csrfHeaders();
      const res = await fetch("/api/dns-providers/connect", {
        method: "POST", headers,
        body: JSON.stringify({ provider: "cloudflare", domain: requestedDomain, token: providerToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.sync?.error || translateInterface("me93571d55373"));
      const certRes = await fetch("/api/tls/acme/provider", { method: "POST", headers });
      const certData = await certRes.json().catch(() => ({}));
      if (!certRes.ok) throw new Error(certData.error || translateInterface("m666d66856a6a"));
      setProviderToken("");
      setReplacingToken(false);
      setSaved(translateInterface("m60ca94e7a6d8"));
      await load();
    } catch (e) { setError(translateInterface("me93571d55373")); }
    finally { setProviderBusy(null); }
  }

  async function syncProvider() {
    setProviderBusy("sync"); setError(""); setSaved("");
    try {
      const res = await fetch("/api/dns-providers/sync", { method: "POST", headers: await csrfHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || translateInterface("mfbca25633ba7"));
      setSaved(translateInterface("mdf139ead1d95"));
      await load();
    } catch (e) { setError(translateInterface("mfbca25633ba7")); }
    finally { setProviderBusy(null); }
  }

  async function renewProvider() {
    setProviderBusy("renew"); setError(""); setSaved("");
    try {
      const res = await fetch("/api/dns-providers/maintenance", {
        method: "POST", headers: await csrfHeaders(), body: JSON.stringify({ force: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || translateInterface("mcc4b0d214485"));
      setSaved(data.renewed ? translateInterface("m76cc7840c194") : data.reason || translateInterface("mc1276dfd1746"));
      await load();
    } catch (e) { setError(translateInterface("mcc4b0d214485")); }
    finally { setProviderBusy(null); }
  }

  async function disconnectProvider() {
    setProviderBusy("disconnect"); setError(""); setSaved("");
    try {
      const res = await fetch("/api/dns-providers/connection", { method: "DELETE", headers: await csrfHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || translateInterface("m6467ba48b3f0"));
      setReplacingToken(false);
      setSaved(translateInterface("m5ca19839baeb"));
      await load();
    } catch (e) { setError(translateInterface("m6467ba48b3f0")); }
    finally { setProviderBusy(null); }
  }

  async function downloadDomainBundle(includeToken = false) {
    if (includeToken && !window.confirm(translateInterface("m5bca949782e0"))) {
      return;
    }
    setProviderBusy(includeToken ? "export-token" : "export"); setError(""); setSaved("");
    try {
      const res = await fetch(`/api/tls/domain/export${includeToken ? "?includeToken=true" : ""}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || translateInterface("m8cecf69e926d"));
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
      setSaved(includeToken ? translateInterface("mf2efcf1170fb") : translateInterface("m8c8b62ca8971"));
    } catch (e) { setError(translateInterface("m8cecf69e926d")); }
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
      if (!response.ok) throw new Error(data.error || translateInterface("m765d6fc9f925"));
      setSaved(action === "accept-current-terms" ? translateInterface("m5d36b97d8404") : translateInterface("mffe734c20ccb"));
      if (action === "accept-current-terms") setNamesNoticeAccepted(false);
      await load();
    } catch (e) { setError(translateInterface("m765d6fc9f925")); }
    finally { setNamesBusy(null); }
  }

  async function downloadNamesFile(path: "export" | "service-data") {
    setNamesBusy(path); setError(""); setSaved("");
    try {
      const response = await fetch(`/api/tls/youeye-names/${path}`, { cache: "no-store" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || translateInterface("m0c5c4f5c64f8"));
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") || "";
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] || `youeye-names-${path}.json`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
      setSaved(path === "export" ? translateInterface("mef3756fee6bf") : translateInterface("mc676b040a0a5"));
    } catch (e) { setError(translateInterface("m0c5c4f5c64f8")); }
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
      if (!response.ok) throw new Error(data.error || translateInterface("mcf7691629b67"));
      setReleaseConfirmation("");
      setSaved(translateInterface("m1f3236060325"));
      await load();
    } catch (e) { setError(translateInterface("mcf7691629b67")); }
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
        <h2 className="text-[15px] font-semibold">{translateInterface("m22f5ebc3ad3f")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{translateInterface("mffd4ce83bfb4")}</p>
        {!caddyRunning && <p className="mt-3 text-sm text-destructive">{translateInterface("m62d3ab221aa0")}</p>}

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
                  <li className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{translateInterface("mbbe5fc3b9ef3")}</li>
                )}
              </ul>
            </div>
            {changeDone && (
              <div className="rounded-lg border border-green-600/30 bg-green-500/5 p-3 text-sm">
                <p className="font-medium text-green-700 dark:text-green-500">{translateInterface("m4536d2daa994")}</p>
                <p className="mt-1 text-muted-foreground">{tlsChoice === "selfsigned" ? translateInterface("m2c9fdb03193f") : translateInterface("m346a93aa6f57")}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button size="sm" className="h-8" onClick={() => { window.location.href = changeDone.newUrl; }}>{translateInterface("m99b73eab1688", {address: changeDone.newUrl.replace(/^https:\/\//, "")})}</Button>
                  <Button size="sm" variant="ghost" className="h-8" onClick={resetChangeFlow}>{translateInterface("mef8d633e03c4")}</Button>
                </div>
              </div>
            )}
            {!changeRunning && !changeDone && (
              <Button size="sm" variant="outline" className="h-8" onClick={resetChangeFlow}>{translateInterface("m76900f1bfd16")}</Button>
            )}
          </div>
        ) : editing ? (
          <div className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <LabelText>{translateInterface("me84a0a9b3def")}</LabelText>
              <Input value={edit} onChange={(e) => setEdit(e.target.value)} placeholder="my-server.example.com" className="h-9 w-72 font-mono" />
            </div>
            <div className="space-y-2">
              <LabelText>{translateInterface("mfa7d2d5339ae")}</LabelText>
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input type="radio" className="mt-1" checked={tlsChoice === "selfsigned"} onChange={() => setTlsChoice("selfsigned")} />
                <span><span className="font-medium">{translateInterface("meb5c27968740")}</span> <span className="text-muted-foreground">{translateInterface("m126137dad040")}</span></span>
              </label>
              <label className={cn("flex items-start gap-2 text-sm", connection ? "cursor-pointer" : "cursor-not-allowed opacity-50")}>
                <input type="radio" className="mt-1" disabled={!connection} checked={tlsChoice === "provider"} onChange={() => setTlsChoice("provider")} />
                <span><span className="font-medium">{translateInterface("mb15dcb54ce90", {provider: connection ? `Cloudflare (${connection.zoneName})` : translateInterface("m5266d11b75e6")})}</span> <span className="text-muted-foreground">{translateInterface("m8ee385eb318f")}</span></span>
              </label>
              <p className="text-xs text-muted-foreground">{translateInterface("ma83ca15c998e")}</p>
            </div>
            {confirming ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                <p className="font-medium">{translateInterface("md65b176609d0", {host: hostOnly(edit)})}</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                  <li>{translateInterface("md29ecaec5ae1")}</li>
                  <li>{translateInterface("m35313207ea4a")}</li>
                  <li>{translateInterface("m040b1e5eb939", {host: hostOnly(edit)})}</li>
                  {tlsChoice === "selfsigned" && <li>{translateInterface("mb9a9cf04d148")}</li>}
                </ul>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" className="h-8" onClick={startUrlChange}>{translateInterface("m8de17fb35366")}</Button>
                  <Button size="sm" variant="ghost" className="h-8" onClick={() => setConfirming(false)}>{translateInterface("m76900f1bfd16")}</Button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" className="h-9" disabled={!edit.trim() || hostOnly(edit) === (domain || "")} onClick={() => setConfirming(true)}>{translateInterface("m31fbef162594")}</Button>
                <Button size="sm" variant="ghost" className="h-9" onClick={() => { setEditing(false); setConfirming(false); setEdit(domain ?? ""); }}>{translateInterface("m19766ed6ccb2")}</Button>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{domain || <span className="text-muted-foreground">{translateInterface("m4895f73177ab")}</span>}</span>
            {caddyRunning && <Button size="sm" variant="outline" className="h-8" onClick={() => { setEditing(true); setConfirming(false); }}>{translateInterface("mc0bf75bd78bf")}</Button>}
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
                  <Download className="h-3.5 w-3.5" />{translateInterface("m70c53e39ff16")}</span>
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
              <p className="mt-1 text-sm text-muted-foreground">{translateInterface("m62c7b29e5345")}</p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-sm font-medium capitalize">
              <span className={cn("h-2 w-2 rounded-full", names.state.status === "healthy" ? "bg-green-500" : names.state.status === "renewing" ? "bg-blue-500" : names.state.status === "released" ? "bg-muted-foreground" : "bg-amber-500")} />
              {names.state.status}
            </span>
          </div>
          <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
            <Field label={translateInterface("me072e717efb8")} value={names.state.fqdn} />
            <Field label={translateInterface("m1e73119d93c5")} value={names.state.certificate ? fmtDate(names.state.certificate.expiresAt) : "Provisioning"} />
            <Field label={translateInterface("m13df778140fb")} value={fmtDateTime(names.state.lastBrokerContactAt)} />
            <Field label={translateInterface("md8e50ce1593d")} value={fmtDateTime(names.state.nextCheckAt)} />
          </div>
          <div className="mt-4 rounded-lg border bg-muted/20 p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className={cn("h-2 w-2 rounded-full", !names.serviceReachable || !names.readiness?.installation.canProceedNow ? "bg-red-500" : names.readiness.installation.state === "degraded" ? "bg-amber-500" : "bg-green-500")} />
              <span className="font-medium">
                {!names.serviceReachable ? translateInterface("mdee1af211578") : names.readiness?.installation.state === "degraded" ? translateInterface("m5cb6457d9f3d") : names.readiness?.installation.canProceedNow ? translateInterface("m707cc0142dae") : translateInterface("m7d5f7ef23605")}
              </span>
            </div>
            {names.readiness && (
              <p className="mt-1 text-xs text-muted-foreground">
                DNS {names.readiness.dns.state}; {translateInterface("mbd2ae1d640e9", {provider: names.readiness.initialCertificate.primary.provider === "google-public-ca" ? "Google Public CA" : "Let's Encrypt", state: names.readiness.initialCertificate.primary.state, fallback: names.readiness.initialCertificate.fallback.state})}
              </p>
            )}
            {names.readiness?.installation.reasonCodes?.length ? (
              <details className="mt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer">{translateInterface("m890ab358a55d")}</summary>
                <p className="mt-1 font-mono">{names.readiness.installation.reasonCodes.join(", ")}</p>
              </details>
            ) : null}
          </div>
          {!names.certificateMatches && names.state.status !== "released" && (
            <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
              {translateInterface("m60f901f6a0db")}</div>
          )}
          {names.state.lastError && (
            <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
              {names.state.lastError.code === "certificate_terms_version_required"
                ? translateInterface("m5a95b2a9bc4e")
                : translateInterface("m3b546dc70b11")}
              {names.state.lastError.requestId ? translateInterface("m6c205d570cce", {reference: names.state.lastError.requestId}) : ""}
            </div>
          )}
          {names.currentTerms && (
            <div className="mt-3 rounded-lg border bg-muted/30 p-3">
              <p className="text-sm font-medium">{translateInterface("m5cdb07c69226")}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{names.currentTerms.summary}</p>
              <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm">
                <input type="checkbox" checked={namesNoticeAccepted} onChange={(event) => setNamesNoticeAccepted(event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-input accent-primary" />
                <span>{translateInterface("m5a9d2532161c")}</span>
              </label>
              <p className="mt-2 text-xs text-muted-foreground">{translateInterface("mc6ed61c15986")}{names.currentTerms.version}</p>
            </div>
          )}
          {names.state.status !== "released" && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="h-8" disabled={!!namesBusy} onClick={() => namesAction("check-now")}>
                {namesBusy === "check-now" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}{translateInterface("m2937cffb37ab")}</Button>
              {(!names.state.termsVersion || names.state.lastError?.code === "certificate_terms_version_required") && (
                <Button size="sm" variant="outline" className="h-8" disabled={!!namesBusy || !namesNoticeAccepted || !names.currentTerms} onClick={() => namesAction("accept-current-terms")}>
                  <Shield className="h-3.5 w-3.5" />{translateInterface("m8839f06e85b7")}</Button>
              )}
              <Button size="sm" variant="outline" className="h-8" disabled={!!namesBusy} onClick={() => downloadNamesFile("export")}>
                <Download className="h-3.5 w-3.5" />{translateInterface("m3af396c523a5")}</Button>
              <Button size="sm" variant="ghost" className="h-8" disabled={!!namesBusy} onClick={() => downloadNamesFile("service-data")}>
                <Download className="h-3.5 w-3.5" />{translateInterface("m128e4d5fada6")}</Button>
            </div>
          )}
          {names.state.status !== "released" && (
            <details className="mt-4 border-t pt-3">
              <summary className="cursor-pointer text-sm font-medium text-destructive">{translateInterface("me1b42a6ea639")}</summary>
              <p className="mt-2 text-xs text-muted-foreground">{translateInterface("m149948b72bd2")}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Input value={releaseConfirmation} onChange={(event) => setReleaseConfirmation(event.target.value)} placeholder={translateInterface("m22cb95ffdcc8", { value0: String(names.state.fqdn) })} className="h-8 max-w-xs font-mono text-xs" />
                <Button size="sm" variant="destructive" className="h-8" disabled={!!namesBusy || releaseConfirmation !== names.state.fqdn} onClick={releaseNamesAddress}>
                  {namesBusy === "release" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{translateInterface("m85f01282f316")}</Button>
              </div>
            </details>
          )}
        </div>
      )}

      {/* DNS provider */}
      <div className="rounded-xl border bg-card p-[22px]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold">{translateInterface("mc36f66f44922")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{translateInterface("meae33134a906")}</p>
          </div>
          <Cloud className="h-5 w-5 text-muted-foreground" />
        </div>
        {connection ? (
          <div className="mt-4 space-y-4">
            <div className="grid gap-4 text-sm sm:grid-cols-2">
              <Field label={translateInterface("m472590ae974d")} value={connection.provider === "cloudflare" ? "Cloudflare" : connection.provider} />
              <Field label={translateInterface("ma8a06e4a5695")} value={connection.zoneName} />
              <Field label={translateInterface("md35e1d8c6c2b")} value={connection.targetIp || "—"} />
              <Field label={translateInterface("m71967fca4d2e")} value={fmtDateTime(connection.lastDnsSyncAt)} />
            </div>
            {connection.lastDnsSyncError && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {connection.lastDnsSyncError}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="h-8" disabled={!!providerBusy} onClick={syncProvider}>
                {providerBusy === "sync" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}{translateInterface("m84f85e88cfac")}</Button>
              <Button size="sm" variant="outline" className="h-8" disabled={!!providerBusy} onClick={() => { setProviderDomain(connection.domain); setProviderToken(""); setReplacingToken(true); }}>
                <KeyRound className="h-3.5 w-3.5" />{translateInterface("m82f2449b3fb3")}</Button>
              <Button size="sm" variant="ghost" className="h-8 text-destructive hover:text-destructive" disabled={!!providerBusy} onClick={disconnectProvider}>
                {providerBusy === "disconnect" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}{translateInterface("macfc5be785a9")}</Button>
            </div>
            {!internalCert && (
              <div className="border-t pt-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-sm font-medium">{translateInterface("m270fd702de9c")}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{translateInterface("m7b40002d627c")}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" className="h-8" disabled={!!providerBusy} onClick={() => downloadDomainBundle(false)}>
                      {providerBusy === "export" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}{translateInterface("mfab020adbc1e")}</Button>
                    <Button size="sm" variant="outline" className="h-8" disabled={!!providerBusy || !connection.hasToken} onClick={() => downloadDomainBundle(true)}>
                      {providerBusy === "export-token" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}{translateInterface("m75e3cbf3fb94")}</Button>
                  </div>
                </div>
              </div>
            )}
            {replacingToken && (
              <div className="rounded-lg border bg-muted/30 p-3">
                <div className="space-y-1.5">
                  <LabelText>{translateInterface("m9d77525b9c6b")}</LabelText>
                  <Input type="password" value={providerToken} onChange={(e) => setProviderToken(e.target.value)} placeholder={translateInterface("m67fa416afa64")} className="h-9" />
                </div>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" className="h-8" disabled={!providerToken.trim() || !!providerBusy} onClick={connectProvider}>
                    {providerBusy === "connect" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}{translateInterface("m2991503a0ae4")}</Button>
                  <Button size="sm" variant="ghost" className="h-8" onClick={() => { setReplacingToken(false); setProviderToken(""); }}>{translateInterface("m19766ed6ccb2")}</Button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
              <div className="space-y-1.5">
                <LabelText>{translateInterface("m79fa33618d8e")}</LabelText>
                <Input value={providerDomain} onChange={(e) => setProviderDomain(e.target.value)} placeholder="home.example.com" className="h-9 font-mono" />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <LabelText>{translateInterface("m79644cb9aff4")}</LabelText>
                  <span className="group relative inline-flex">
                    <Info className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="pointer-events-none absolute right-0 z-10 mt-5 hidden w-72 rounded-xl border bg-popover p-3 text-xs text-popover-foreground shadow-lg group-hover:block">
                      {translateInterface("m7b3d43e16861")}</span>
                  </span>
                </div>
                <Input type="password" value={providerToken} onChange={(e) => setProviderToken(e.target.value)} placeholder={translateInterface("m67fa416afa64")} className="h-9" />
              </div>
            </div>
            <Button size="sm" className="h-9" disabled={!providerDomain.trim() || !providerToken.trim() || !!providerBusy} onClick={connectProvider}>
              {providerBusy === "connect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />}
              {translateInterface("mdb69a1caf8b4")}</Button>
          </div>
        )}
      </div>

      {/* HTTPS / certificate */}
      <div className="rounded-xl border bg-card p-[22px]">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">{translateInterface("m46743144dbd6")}</h2>
          <Button variant="outline" size="sm" className="h-8" onClick={load}><RefreshCw className="h-3.5 w-3.5" />{translateInterface("m0e9161011702")}</Button>
        </div>
        {tls?.expiryWarning && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-600 dark:text-amber-500">
            <AlertTriangle className="h-4 w-4" />{translateInterface("mf13ecb7b4f12")}</div>
        )}
        {internalCert ? (
          <p className="mt-3 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{translateInterface("md5859dc61619")}</span> {translateInterface("m30c4faa696f0")}</p>
        ) : (
          <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
            <Field label={translateInterface("m5e23ec6a300d")} value={tls?.mode} />
            <Field label={translateInterface("m39e02c46a083")} value={tls?.cert?.issuer || "—"} />
            <Field label={translateInterface("m0221e4875188")} value={fmtDate(tls?.cert?.issuedAt)} />
            <Field label={translateInterface("mf6725f3af08a")} value={fmtDate(tls?.cert?.expiresAt)} />
            <Field label={translateInterface("mc9b6b4f84e1b")} value={fmtDateTime(connection?.nextCertRenewalDueAt)} />
          </div>
        )}
        {connection && !internalCert && (
          <div className="mt-4">
            <Button size="sm" variant="outline" className="h-8" disabled={!!providerBusy} onClick={renewProvider}>
              {providerBusy === "renew" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}{translateInterface("m905758c33c19")}</Button>
          </div>
        )}
        <div className="mt-4">
          <p className="mb-2 text-sm font-medium">{translateInterface("mf5ead1dc7b5e")}</p>
          <div className="flex flex-wrap gap-2">
            {(tls?.subjects?.length ?? 0) > 0 ? tls!.subjects.map((s) => <Badge key={s} variant="secondary" className="font-mono text-[11px]">{s}</Badge>)
              : <span className="text-sm text-muted-foreground">{domain ? translateInterface("me540c1d7d757", { value0: String(domain) }) : translateInterface("m09102598e995")}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── shared bits ─────────────────────────── */

/** Friendly labels for reconfigure SSE step keys (app_* → "App: <id>"). */


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
