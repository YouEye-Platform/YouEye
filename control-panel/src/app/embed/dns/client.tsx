"use client";

import {useLocale} from "next-intl";




import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useEffect, useState, useCallback, useRef } from "react";
import { authenticatedFetch } from "@/lib/api-client";

// ─── Types ───────────────────────────────────────────────────────────────────

interface DnsStats {
  status: "enabled" | "disabled";
  queries_today: number;
  blocked_today: number;
  percent_blocked: number;
  top_queries: Array<{ domain: string; count: number }>;
  top_blocked: Array<{ domain: string; count: number }>;
  gravity_size: number;
}

interface HistoryEntry {
  timestamp: number;
  total: number;
  blocked: number;
  cached: number;
  forwarded: number;
}

interface Query {
  id: number;
  time: number;
  type: string;
  domain: string;
  client: { ip: string; name?: string | null };
  status: string;
  reply: { type: string; time: number };
  upstream?: string;
}

interface DnsRecord { ip: string; domain: string }
interface CnameRecord { domain: string; target: string }

interface DomainLists {
  allow: { exact: string[]; regex: string[] };
  deny: { exact: string[]; regex: string[] };
}

interface Adlist {
  address: string;
  comment: string;
  enabled: boolean;
  type: string;
  number?: number;
  status?: number;
  id?: number;
}

interface DnsConfig {
  upstreams?: string[];
  cache?: { size?: number; optimizer?: number };
  dnssec?: boolean;
  rateLimit?: { count?: number; interval?: number };
  queryLogging?: boolean;
  blocking?: { active?: boolean };
}

type Tab = "overview" | "queries" | "domains" | "local-dns" | "blocklists" | "settings";

const TABS: Array<{ id: Tab; labelKey: string }> = [
  { id: "overview", labelKey: "md4b1ea5708dd" },
  { id: "queries", labelKey: "m5a0aa8ba12f0" },
  { id: "domains", labelKey: "md3385870303a" },
  { id: "local-dns", labelKey: "m10e2ffbf07f7" },
  { id: "blocklists", labelKey: "mdec55eff52c6" },
  { id: "settings", labelKey: "m74a883a037bc" },
];

// ─── Main Component ──────────────────────────────────────────────────────────

export function DnsEmbedClient() {
  const translateInterface = useInterfaceTranslations("interface");
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <div style={{ padding: 16 }}>
      {/* Tab bar */}
      <div style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--embed-border)", marginBottom: 16, flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            className="embed-btn"
            onClick={() => setTab(t.id)}
            style={{
              border: "none",
              borderBottom: tab === t.id ? "2px solid var(--embed-primary)" : "2px solid transparent",
              borderRadius: 0,
              fontWeight: tab === t.id ? 600 : 400,
              color: tab === t.id ? "var(--embed-primary)" : "var(--embed-text-muted)",
              padding: "8px 14px",
              fontSize: 13,
              background: "transparent",
            }}
          >
            {translateInterface(t.labelKey)}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab />}
      {tab === "queries" && <QueryLogTab />}
      {tab === "domains" && <DomainsTab />}
      {tab === "local-dns" && <LocalDnsTab />}
      {tab === "blocklists" && <BlocklistsTab />}
      {tab === "settings" && <SettingsTab />}
    </div>
  );
}

// ─── Overview Tab ────────────────────────────────────────────────────────────

function OverviewTab() {
  const locale = useLocale();

  const translateInterface = useInterfaceTranslations("interface");

  const [data, setData] = useState<DnsStats | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const [statsRes, histRes] = await Promise.all([
        authenticatedFetch("/api/ui-bridge/dns/stats"),
        authenticatedFetch("/api/ui-bridge/dns/history"),
      ]);
      if (statsRes.ok) setData(await statsRes.json());
      if (histRes.ok) {
        const h = await histRes.json();
        setHistory(h.history || []);
      }
    } catch (err) {
      setError(translateInterface("m3d2301d732a7"));
    } finally {
      setLoading(false);
    }
  }, [translateInterface]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Draw chart
  useEffect(() => {
    if (!canvasRef.current || history.length < 2) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const pad = { top: 10, right: 10, bottom: 24, left: 40 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    const maxTotal = Math.max(...history.map((e) => e.total), 1);
    const maxBlocked = Math.max(...history.map((e) => e.blocked), 1);
    const maxY = Math.max(maxTotal, maxBlocked) * 1.1;

    ctx.clearRect(0, 0, w, h);

    // Grid lines
    ctx.strokeStyle = "var(--embed-border)";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ch / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      ctx.fillStyle = "var(--embed-text-muted)";
      ctx.font = "10px system-ui";
      ctx.textAlign = "right";
      ctx.fillText(Math.round(maxY - (maxY / 4) * i).toString(), pad.left - 6, y + 3);
    }

    // Time labels
    const len = history.length;
    const step = Math.max(1, Math.floor(len / 6));
    ctx.fillStyle = "var(--embed-text-muted)";
    ctx.font = "10px system-ui";
    ctx.textAlign = "center";
    for (let i = 0; i < len; i += step) {
      const x = pad.left + (i / (len - 1)) * cw;
      const d = new Date(history[i].timestamp * 1000);
      ctx.fillText(`${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`, x, h - 4);
    }

    // Area: total queries
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top + ch);
    for (let i = 0; i < len; i++) {
      const x = pad.left + (i / (len - 1)) * cw;
      const y = pad.top + ch - (history[i].total / maxY) * ch;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(pad.left + cw, pad.top + ch);
    ctx.closePath();
    ctx.fillStyle = "rgba(59,130,246,0.12)";
    ctx.fill();

    // Line: total queries
    ctx.beginPath();
    for (let i = 0; i < len; i++) {
      const x = pad.left + (i / (len - 1)) * cw;
      const y = pad.top + ch - (history[i].total / maxY) * ch;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(59,130,246,0.8)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Area: blocked
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top + ch);
    for (let i = 0; i < len; i++) {
      const x = pad.left + (i / (len - 1)) * cw;
      const y = pad.top + ch - (history[i].blocked / maxY) * ch;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(pad.left + cw, pad.top + ch);
    ctx.closePath();
    ctx.fillStyle = "rgba(239,68,68,0.12)";
    ctx.fill();

    // Line: blocked
    ctx.beginPath();
    for (let i = 0; i < len; i++) {
      const x = pad.left + (i / (len - 1)) * cw;
      const y = pad.top + ch - (history[i].blocked / maxY) * ch;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(239,68,68,0.8)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Legend
    ctx.font = "11px system-ui";
    ctx.fillStyle = "rgba(59,130,246,0.9)";
    ctx.fillText("\u25CF Total", pad.left + 4, pad.top + 14);
    ctx.fillStyle = "rgba(239,68,68,0.9)";
    ctx.fillText("\u25CF Blocked", pad.left + 64, pad.top + 14);
  }, [history]);

  const handleToggle = async () => {
    if (!data) return;
    setToggling(true);
    const action = data.status === "enabled" ? "disable" : "enable";
    try {
      const res = await authenticatedFetch("/api/ui-bridge/dns/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        const result = await res.json();
        setData((prev) => (prev ? { ...prev, status: result.status } : prev));
      }
    } catch { /* user can retry */ } finally { setToggling(false); }
  };

  if (loading) return <LoadingSkeleton />;
  if (error) return <div className="embed-error">{error}</div>;
  if (!data) return null;

  const isEnabled = data.status === "enabled";

  return (
    <>
      {/* Status + Toggle */}
      <div className="embed-card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="embed-dot" style={{ background: isEnabled ? "var(--embed-success)" : "var(--embed-danger)", width: 10, height: 10 }} />
          <span style={{ fontWeight: 500 }}>
            {translateInterface("m19e2ab0484ef", {state: ""})}{" "}
            <span className="embed-badge" style={isEnabled
              ? { color: "var(--embed-success)", borderColor: "color-mix(in srgb, var(--embed-success) 30%, transparent)" }
              : { color: "var(--embed-danger)", borderColor: "color-mix(in srgb, var(--embed-danger) 30%, transparent)" }
            }>
              {isEnabled ? translateInterface("m92340695899b") : translateInterface("me159b06187d3")}
            </span>
          </span>
        </div>
        <button
          className="embed-btn"
          style={isEnabled
            ? { borderColor: "var(--embed-danger)", color: "var(--embed-danger)" }
            : { borderColor: "var(--embed-success)", color: "var(--embed-success)" }
          }
          onClick={handleToggle}
          disabled={toggling}
        >
          {toggling ? "..." : isEnabled ? translateInterface("m858e4ba7a29f") : translateInterface("md640c7421da0")}
        </button>
      </div>

      {/* Stats Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginTop: 12 }}>
        <StatCard label={translateInterface("m1f8fb35338d1")} value={data.queries_today.toLocaleString(locale)} />
        <StatCard label={translateInterface("m18f2a0947f9d")} value={data.blocked_today.toLocaleString(locale)} color="var(--embed-danger)" />
        <StatCard label={translateInterface("m8b2c2ec2720d")} value={`${data.percent_blocked.toLocaleString(locale, {minimumFractionDigits: 1, maximumFractionDigits: 1})}%`} />
        <StatCard label={translateInterface("mc0840e5dafd8")} value={data.gravity_size.toLocaleString(locale)} />
      </div>

      {/* Queries Over Time Chart */}
      {history.length > 1 && (
        <div className="embed-card" style={{ marginTop: 12 }}>
          <div className="embed-card-title">{translateInterface("m11e9e99906cd")}</div>
          <canvas ref={canvasRef} style={{ width: "100%", height: 180 }} />
        </div>
      )}

      {/* Top Queries & Top Blocked */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
        <DomainTable title={translateInterface("m1857d11942a7")} entries={data.top_queries} />
        <DomainTable title={translateInterface("m10d2d4a56195")} entries={data.top_blocked} />
      </div>
    </>
  );
}

// ─── Query Log Tab ───────────────────────────────────────────────────────────

function QueryLogTab() {
  const locale = useLocale();

  const translateInterface = useInterfaceTranslations("interface");

  const [queries, setQueries] = useState<Query[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const fetchQueries = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (filter) params.set("domain", filter);
      if (statusFilter) params.set("status", statusFilter);
      const res = await authenticatedFetch(`/api/ui-bridge/dns/queries?${params}`);
      if (res.ok) {
        const d = await res.json();
        setQueries(d.queries || []);
      }
    } catch { /* silently fail */ } finally { setLoading(false); }
  }, [filter, statusFilter]);

  useEffect(() => { fetchQueries(); }, [fetchQueries]);

  const statusColor = (s: string) => {
    const sl = s.toUpperCase();
    if (sl.includes("GRAVITY") || sl.includes("DENY") || sl.includes("BLOCK") || sl.includes("REGEX")) return "var(--embed-danger)";
    if (sl === "FORWARDED") return "var(--embed-primary)";
    if (sl === "CACHE" || sl.includes("CACHE")) return "var(--embed-success)";
    return "var(--embed-text-muted)";
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <input
          className="embed-input"
          placeholder={translateInterface("me8f6be0644fb")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && fetchQueries()}
          style={{ flex: 1, minWidth: 200, padding: "6px 10px", fontSize: 13, border: "1px solid var(--embed-border)", borderRadius: 6, background: "transparent", color: "inherit" }}
        />
        <button className="embed-btn" onClick={() => setShowFilters(!showFilters)} style={{ fontSize: 12 }}>
          {showFilters ? translateInterface("m9681120e8921") : translateInterface("m367971557fbd")}
        </button>
        <button className="embed-btn" onClick={fetchQueries} disabled={loading}>
          {loading ? "..." : translateInterface("m49c266baaaa7")}
        </button>
      </div>

      {showFilters && (
        <div className="embed-card" style={{ marginBottom: 12, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ fontSize: 12, color: "var(--embed-text-muted)" }}>{translateInterface("m755c8b2a9fb1")}</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ padding: "4px 8px", fontSize: 12, border: "1px solid var(--embed-border)", borderRadius: 4, background: "var(--embed-card-bg)", color: "inherit" }}
          >
            <option value="">{translateInterface("ma52ace420f21")}</option>
            <option value="FORWARDED">{translateInterface("m99498a5f4bea")}</option>
            <option value="CACHE">{translateInterface("ma251c18205f1")}</option>
            <option value="GRAVITY">{translateInterface("m2ec05b2f8ce4")}</option>
            <option value="REGEX">{translateInterface("md099ed424889")}</option>
            <option value="DENYLIST">{translateInterface("m9e38662f5e92")}</option>
          </select>
        </div>
      )}

      {loading ? <LoadingSkeleton /> : (
        <div style={{ overflowX: "auto" }}>
          <table className="embed-table" style={{ width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                <th>{translateInterface("m33b93476cf59")}</th>
                <th>{translateInterface("m79fa33618d8e")}</th>
                <th>{translateInterface("m0c77fe09ab33")}</th>
                <th>{translateInterface("mbaaddf70fb5d")}</th>
                <th>{translateInterface("m920e413c7d41")}</th>
                <th style={{ textAlign: "right" }}>{translateInterface("mc253f451bdd5")}</th>
              </tr>
            </thead>
            <tbody>
              {queries.length === 0 ? (
                <tr><td colSpan={6} style={{ textAlign: "center", padding: 20 }} className="embed-muted">{translateInterface("m7230beded3d3")}</td></tr>
              ) : queries.map((q) => (
                <tr key={q.id}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {new Date(q.time * 1000).toLocaleTimeString(locale)}
                  </td>
                  <td className="embed-mono" style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {q.domain}
                  </td>
                  <td className="embed-mono">{q.client?.ip || "?"}</td>
                  <td><span className="embed-badge" style={{ fontSize: 10 }}>{q.type}</span></td>
                  <td>
                    <span className="embed-badge" style={{ fontSize: 10, color: statusColor(q.status), borderColor: `color-mix(in srgb, ${statusColor(q.status)} 30%, transparent)` }}>
                      {q.status}
                    </span>
                  </td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {q.reply?.time != null ? `${(q.reply.time * 1000).toLocaleString(locale, {minimumFractionDigits: 1, maximumFractionDigits: 1})}ms` : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ─── Domains Tab (Allow / Block) ─────────────────────────────────────────────

function DomainsTab() {
  const translateInterface = useInterfaceTranslations("interface");

  const [lists, setLists] = useState<DomainLists | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeList, setActiveList] = useState<"allow" | "deny">("deny");
  const [newDomain, setNewDomain] = useState("");
  const [newKind, setNewKind] = useState<"exact" | "regex">("exact");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  const fetchDomains = useCallback(async () => {
    try {
      const res = await authenticatedFetch("/api/ui-bridge/dns/domains");
      if (res.ok) setLists(await res.json());
    } catch { /* silently fail */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchDomains(); }, [fetchDomains]);

  const handleAdd = async () => {
    if (!newDomain.trim()) return;
    setAdding(true);
    setError("");
    try {
      const res = await authenticatedFetch("/api/ui-bridge/dns/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: newDomain.trim(), list: activeList, kind: newKind }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || translateInterface("m031a8f0f659d"));
      }
      setNewDomain("");
      fetchDomains();
    } catch (e) {
      setError(translateInterface("m031a8f0f659d"));
    } finally { setAdding(false); }
  };

  const handleRemove = async (domain: string, kind: "exact" | "regex") => {
    try {
      await authenticatedFetch("/api/ui-bridge/dns/domains", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, list: activeList, kind }),
      });
      fetchDomains();
    } catch { /* silently fail */ }
  };

  if (loading) return <LoadingSkeleton />;

  const currentExact = lists ? lists[activeList].exact : [];
  const currentRegex = lists ? lists[activeList].regex : [];

  return (
    <>
      {/* Allow / Block toggle */}
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <button
          className="embed-btn"
          onClick={() => setActiveList("deny")}
          style={activeList === "deny" ? { background: "var(--embed-danger)", color: "#fff", borderColor: "var(--embed-danger)" } : {}}
        >
          {translateInterface("m13635b8d433f", {count: lists ? lists.deny.exact.length + lists.deny.regex.length : 0})}
        </button>
        <button
          className="embed-btn"
          onClick={() => setActiveList("allow")}
          style={activeList === "allow" ? { background: "var(--embed-success)", color: "#fff", borderColor: "var(--embed-success)" } : {}}
        >
          {translateInterface("mde89e2af06d1", {count: lists ? lists.allow.exact.length + lists.allow.regex.length : 0})}
        </button>
      </div>

      {/* Add domain */}
      <div className="embed-card" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          className="embed-input"
          placeholder={newKind === "regex" ? translateInterface("m9f896c35a09d") : translateInterface("m27afbb74abf0")}
          value={newDomain}
          onChange={(e) => setNewDomain(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          style={{ flex: 1, minWidth: 200, padding: "6px 10px", fontSize: 13, border: "1px solid var(--embed-border)", borderRadius: 4, background: "transparent", color: "inherit" }}
        />
        <select
          value={newKind}
          onChange={(e) => setNewKind(e.target.value as "exact" | "regex")}
          style={{ padding: "6px 8px", fontSize: 12, border: "1px solid var(--embed-border)", borderRadius: 4, background: "var(--embed-card-bg)", color: "inherit" }}
        >
          <option value="exact">{translateInterface("mb5aee780c3bf")}</option>
          <option value="regex">{translateInterface("m0f2712521d50")}</option>
        </select>
        <button className="embed-btn" onClick={handleAdd} disabled={adding}
          style={{ borderColor: activeList === "deny" ? "var(--embed-danger)" : "var(--embed-success)", color: activeList === "deny" ? "var(--embed-danger)" : "var(--embed-success)" }}
        >
          {adding ? "..." : activeList === "deny" ? translateInterface("mfa5e79dcf433") : translateInterface("m60482c521be8")}
        </button>
      </div>
      {error && <div style={{ color: "var(--embed-danger)", fontSize: 12, marginTop: 4 }}>{error}</div>}

      {/* Domain list */}
      {currentExact.length + currentRegex.length === 0 ? (
        <div className="embed-muted" style={{ textAlign: "center", padding: 24, fontSize: 13 }}>
          {translateInterface("m1ea442a134b2")}{" "}{activeList === "deny" ? translateInterface("m6973dddd3ef9") : translateInterface("meabc01f12ec3")} {translateInterface("m1b0ec1954eec")}</div>
      ) : (
        <div style={{ marginTop: 12 }}>
          {currentExact.map((d) => (
            <DomainRow key={`exact-${d}`} domain={d} kind="exact" onRemove={() => handleRemove(d, "exact")} />
          ))}
          {currentRegex.map((d) => (
            <DomainRow key={`regex-${d}`} domain={d} kind="regex" onRemove={() => handleRemove(d, "regex")} />
          ))}
        </div>
      )}
    </>
  );
}

function DomainRow({ domain, kind, onRemove }: { domain: string; kind: string; onRemove: () => void }) {
  const translateInterface = useInterfaceTranslations("interface");

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", borderBottom: "1px solid var(--embed-border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="embed-mono" style={{ fontSize: 13 }}>{domain}</span>
        {kind === "regex" && <span className="embed-badge" style={{ fontSize: 9, color: "var(--embed-warning)" }}>{translateInterface("m42d58222b328")}</span>}
      </div>
      <button className="embed-btn" style={{ padding: "2px 8px", color: "var(--embed-danger)", borderColor: "var(--embed-danger)", fontSize: 11 }} onClick={onRemove}>{"\u2715"}</button>
    </div>
  );
}

// ─── Local DNS Tab ───────────────────────────────────────────────────────────

function LocalDnsTab() {
  const translateInterface = useInterfaceTranslations("interface");

  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [cnames, setCnames] = useState<CnameRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"a" | "cname">("a");
  const [newIp, setNewIp] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [newTarget, setNewTarget] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  const fetchAll = useCallback(async () => {
    try {
      const [rRes, cRes] = await Promise.all([
        authenticatedFetch("/api/ui-bridge/dns/records"),
        authenticatedFetch("/api/ui-bridge/dns/cname"),
      ]);
      if (rRes.ok) setRecords(await rRes.json());
      if (cRes.ok) setCnames(await cRes.json());
    } catch { /* silently fail */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleAddRecord = async () => {
    if (!newIp.trim() || !newDomain.trim()) return;
    setAdding(true); setError("");
    try {
      const res = await authenticatedFetch("/api/ui-bridge/dns/records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: newIp.trim(), domain: newDomain.trim() }),
      });
      if (!res.ok) throw new Error(translateInterface("m031a8f0f659d"));
      setNewIp(""); setNewDomain("");
      fetchAll();
    } catch (e) { setError(translateInterface("m031a8f0f659d")); }
    finally { setAdding(false); }
  };

  const handleRemoveRecord = async (ip: string, domain: string) => {
    try {
      await authenticatedFetch("/api/ui-bridge/dns/records", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip, domain }),
      });
      fetchAll();
    } catch { /* silently fail */ }
  };

  const handleAddCname = async () => {
    if (!newDomain.trim() || !newTarget.trim()) return;
    setAdding(true); setError("");
    try {
      const res = await authenticatedFetch("/api/ui-bridge/dns/cname", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: newDomain.trim(), target: newTarget.trim() }),
      });
      if (!res.ok) throw new Error(translateInterface("m031a8f0f659d"));
      setNewDomain(""); setNewTarget("");
      fetchAll();
    } catch (e) { setError(translateInterface("m031a8f0f659d")); }
    finally { setAdding(false); }
  };

  const handleRemoveCname = async (domain: string, target: string) => {
    try {
      await authenticatedFetch("/api/ui-bridge/dns/cname", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, target }),
      });
      fetchAll();
    } catch { /* silently fail */ }
  };

  if (loading) return <LoadingSkeleton />;

  return (
    <>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <button className="embed-btn" onClick={() => setView("a")}
          style={view === "a" ? { background: "var(--embed-primary)", color: "#fff", borderColor: "var(--embed-primary)" } : {}}
        >
          {translateInterface("m1a94245c6207", {count: records.length})}
        </button>
        <button className="embed-btn" onClick={() => setView("cname")}
          style={view === "cname" ? { background: "var(--embed-primary)", color: "#fff", borderColor: "var(--embed-primary)" } : {}}
        >
          {translateInterface("m1faf1b309134", {count: cnames.length})}
        </button>
      </div>

      {error && <div style={{ color: "var(--embed-danger)", fontSize: 12, marginBottom: 8 }}>{error}</div>}

      {view === "a" ? (
        <>
          <div className="embed-card" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input placeholder={translateInterface("m79fa33618d8e")} value={newDomain} onChange={(e) => setNewDomain(e.target.value)}
              style={{ flex: 1, minWidth: 160, padding: "6px 10px", fontSize: 13, border: "1px solid var(--embed-border)", borderRadius: 4, background: "transparent", color: "inherit" }} />
            <span style={{ color: "var(--embed-text-muted)", fontSize: 13 }}>\u2192</span>
            <input placeholder={translateInterface("m3c3de0c91c5f")} value={newIp} onChange={(e) => setNewIp(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddRecord()}
              style={{ flex: 1, minWidth: 140, padding: "6px 10px", fontSize: 13, border: "1px solid var(--embed-border)", borderRadius: 4, background: "transparent", color: "inherit" }} />
            <button className="embed-btn" onClick={handleAddRecord} disabled={adding}
              style={{ borderColor: "var(--embed-success)", color: "var(--embed-success)" }}>
              {adding ? "..." : translateInterface("mc007258c23b0")}
            </button>
          </div>
          {records.length === 0 ? (
            <div className="embed-muted" style={{ textAlign: "center", padding: 24, fontSize: 13 }}>{translateInterface("m11fce020d729")}</div>
          ) : (
            <table className="embed-table" style={{ width: "100%", marginTop: 12, fontSize: 13 }}>
              <thead><tr><th>{translateInterface("m79fa33618d8e")}</th><th>{translateInterface("m3c3de0c91c5f")}</th><th style={{ width: 40 }}></th></tr></thead>
              <tbody>
                {records.map((r) => (
                  <tr key={`${r.domain}-${r.ip}`}>
                    <td className="embed-mono">{r.domain}</td>
                    <td className="embed-mono">{r.ip}</td>
                    <td>
                      <button className="embed-btn" style={{ padding: "2px 8px", color: "var(--embed-danger)", borderColor: "var(--embed-danger)", fontSize: 11 }}
                        onClick={() => handleRemoveRecord(r.ip, r.domain)}>{"\u2715"}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : (
        <>
          <div className="embed-card" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input placeholder={translateInterface("m79fa33618d8e")} value={newDomain} onChange={(e) => setNewDomain(e.target.value)}
              style={{ flex: 1, minWidth: 160, padding: "6px 10px", fontSize: 13, border: "1px solid var(--embed-border)", borderRadius: 4, background: "transparent", color: "inherit" }} />
            <span style={{ color: "var(--embed-text-muted)", fontSize: 13 }}>\u2192</span>
            <input placeholder={translateInterface("m978354db0c00")} value={newTarget} onChange={(e) => setNewTarget(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddCname()}
              style={{ flex: 1, minWidth: 160, padding: "6px 10px", fontSize: 13, border: "1px solid var(--embed-border)", borderRadius: 4, background: "transparent", color: "inherit" }} />
            <button className="embed-btn" onClick={handleAddCname} disabled={adding}
              style={{ borderColor: "var(--embed-success)", color: "var(--embed-success)" }}>
              {adding ? "..." : translateInterface("mc007258c23b0")}
            </button>
          </div>
          {cnames.length === 0 ? (
            <div className="embed-muted" style={{ textAlign: "center", padding: 24, fontSize: 13 }}>{translateInterface("m8cbdb05f47d5")}</div>
          ) : (
            <table className="embed-table" style={{ width: "100%", marginTop: 12, fontSize: 13 }}>
              <thead><tr><th>{translateInterface("m79fa33618d8e")}</th><th>{translateInterface("m978354db0c00")}</th><th style={{ width: 40 }}></th></tr></thead>
              <tbody>
                {cnames.map((c) => (
                  <tr key={`${c.domain}-${c.target}`}>
                    <td className="embed-mono">{c.domain}</td>
                    <td className="embed-mono">{c.target}</td>
                    <td>
                      <button className="embed-btn" style={{ padding: "2px 8px", color: "var(--embed-danger)", borderColor: "var(--embed-danger)", fontSize: 11 }}
                        onClick={() => handleRemoveCname(c.domain, c.target)}>{"\u2715"}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}

// ─── Blocklists Tab ──────────────────────────────────────────────────────────

function BlocklistsTab() {
  const locale = useLocale();

  const translateInterface = useInterfaceTranslations("interface");

  const [lists, setLists] = useState<Adlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [newUrl, setNewUrl] = useState("");
  const [newComment, setNewComment] = useState("");
  const [adding, setAdding] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const fetchLists = useCallback(async () => {
    try {
      const res = await authenticatedFetch("/api/ui-bridge/dns/lists");
      if (res.ok) {
        const d = await res.json();
        setLists(d.lists || []);
      }
    } catch { /* silently fail */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchLists(); }, [fetchLists]);

  const handleAdd = async () => {
    if (!newUrl.trim()) return;
    setAdding(true); setError("");
    try {
      const res = await authenticatedFetch("/api/ui-bridge/dns/lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: newUrl.trim(), comment: newComment.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || translateInterface("m031a8f0f659d"));
      }
      setNewUrl(""); setNewComment("");
      fetchLists();
    } catch (e) { setError(translateInterface("m031a8f0f659d")); }
    finally { setAdding(false); }
  };

  const handleRemove = async (address: string) => {
    try {
      await authenticatedFetch("/api/ui-bridge/dns/lists", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      fetchLists();
    } catch { /* silently fail */ }
  };

  const handleGravity = async () => {
    setUpdating(true); setSuccess(""); setError("");
    try {
      const res = await authenticatedFetch("/api/ui-bridge/dns/gravity", { method: "POST" });
      if (res.ok) {
        setSuccess(translateInterface("mfbe100ccfbee"));
        fetchLists();
      } else throw new Error(translateInterface("m031a8f0f659d"));
    } catch (e) { setError(translateInterface("me58282fd73fb")); }
    finally { setUpdating(false); }
  };

  if (loading) return <LoadingSkeleton />;

  return (
    <>
      {/* Add list */}
      <div className="embed-card">
        <div className="embed-card-title" style={{ marginBottom: 8 }}>{translateInterface("m6a498939ec8f")}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input placeholder={translateInterface("m5fabec892499")} value={newUrl} onChange={(e) => setNewUrl(e.target.value)}
            style={{ flex: 2, minWidth: 250, padding: "6px 10px", fontSize: 13, border: "1px solid var(--embed-border)", borderRadius: 4, background: "transparent", color: "inherit" }} />
          <input placeholder={translateInterface("mc271966972e6")} value={newComment} onChange={(e) => setNewComment(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            style={{ flex: 1, minWidth: 140, padding: "6px 10px", fontSize: 13, border: "1px solid var(--embed-border)", borderRadius: 4, background: "transparent", color: "inherit" }} />
          <button className="embed-btn" onClick={handleAdd} disabled={adding}
            style={{ borderColor: "var(--embed-success)", color: "var(--embed-success)" }}>
            {adding ? "..." : translateInterface("mc007258c23b0")}
          </button>
        </div>
      </div>

      {error && <div style={{ color: "var(--embed-danger)", fontSize: 12, marginTop: 4 }}>{error}</div>}
      {success && <div style={{ color: "var(--embed-success)", fontSize: 12, marginTop: 4 }}>{success}</div>}

      {/* Update gravity */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>
          {translateInterface("subscribedLists", {count: lists.length})}</div>
        <button className="embed-btn" onClick={handleGravity} disabled={updating}
          style={{ borderColor: "var(--embed-primary)", color: "var(--embed-primary)" }}>
          {updating ? translateInterface("m0a4e0b71b7f3") : translateInterface("m5544a1bef107")}
        </button>
      </div>

      {/* List table */}
      {lists.length === 0 ? (
        <div className="embed-muted" style={{ textAlign: "center", padding: 24, fontSize: 13 }}>{translateInterface("m120eb1c8f28f")}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="embed-table" style={{ width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                <th>{translateInterface("me7a241debad5")}</th>
                <th>{translateInterface("m44f5e3fbec57")}</th>
                <th style={{ textAlign: "right" }}>{translateInterface("mced67718ea0f")}</th>
                <th style={{ width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {lists.map((l) => (
                <tr key={l.address} style={{ opacity: l.enabled ? 1 : 0.5 }}>
                  <td className="embed-mono" style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {l.address}
                  </td>
                  <td style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {l.comment || <span className="embed-muted">-</span>}
                  </td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {l.number != null ? l.number.toLocaleString(locale) : "-"}
                  </td>
                  <td>
                    <button className="embed-btn" style={{ padding: "2px 8px", color: "var(--embed-danger)", borderColor: "var(--embed-danger)", fontSize: 11 }}
                      onClick={() => handleRemove(l.address)}>{"\u2715"}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ─── Settings Tab ────────────────────────────────────────────────────────────

function SettingsTab() {
  const locale = useLocale();

  const translateInterface = useInterfaceTranslations("interface");

  const [config, setConfig] = useState<DnsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [upstreams, setUpstreams] = useState<string[]>([]);
  const [upstreamDraft, setUpstreamDraft] = useState<string[]>([]);
  const [upstreamEditing, setUpstreamEditing] = useState(false);

  const fetchConfig = useCallback(async () => {
    try {
      const [configRes, upstreamRes] = await Promise.all([
        authenticatedFetch("/api/ui-bridge/dns/config"),
        authenticatedFetch("/api/ui-bridge/dns/upstream"),
      ]);
      if (configRes.ok) {
        const d = await configRes.json();
        setConfig(d.config?.dns || d.dns || d);
      }
      if (upstreamRes.ok) {
        const d = await upstreamRes.json();
        setUpstreams(d.upstreams || []);
        setUpstreamDraft(d.upstreams || []);
      }
    } catch { /* silently fail */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const handleUpstreamSave = async () => {
    const filtered = upstreamDraft.map((s) => s.trim()).filter(Boolean);
    if (filtered.length === 0) { setError(translateInterface("m9c1f18e8e581")); return; }
    setSaving(true); setError(""); setSuccess("");
    try {
      const res = await authenticatedFetch("/api/ui-bridge/dns/upstream", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upstreams: filtered }),
      });
      if (res.ok) {
        const d = await res.json();
        setUpstreams(d.upstreams || filtered);
        setUpstreamDraft(d.upstreams || filtered);
        setUpstreamEditing(false);
        setSuccess(translateInterface("m7a17f6374942"));
      } else throw new Error(translateInterface("m031a8f0f659d"));
    } catch (e) { setError(translateInterface("m031a8f0f659d")); }
    finally { setSaving(false); }
  };

  const handleConfigSave = async (patch: Record<string, unknown>) => {
    setSaving(true); setError(""); setSuccess("");
    try {
      const res = await authenticatedFetch("/api/ui-bridge/dns/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: patch }),
      });
      if (res.ok) {
        setSuccess(translateInterface("m74a7f53bad39"));
        fetchConfig();
      } else throw new Error(translateInterface("m031a8f0f659d"));
    } catch (e) { setError(translateInterface("m031a8f0f659d")); }
    finally { setSaving(false); }
  };

  if (loading) return <LoadingSkeleton />;

  return (
    <>
      {error && <div style={{ color: "var(--embed-danger)", fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {success && <div style={{ color: "var(--embed-success)", fontSize: 12, marginBottom: 8 }}>{success}</div>}

      {/* Upstream DNS Servers */}
      <div className="embed-card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div>
            <div className="embed-card-title" style={{ margin: 0 }}>{translateInterface("mf00366461f56")}</div>
            <div className="embed-muted" style={{ fontSize: 12 }}>{translateInterface("mcef2b348a4e9")}</div>
          </div>
          {!upstreamEditing ? (
            <button className="embed-btn" onClick={() => { setUpstreamEditing(true); setUpstreamDraft([...upstreams]); }}>{translateInterface("m464c4ffd019e")}</button>
          ) : (
            <div style={{ display: "flex", gap: 6 }}>
              <button className="embed-btn" onClick={() => { setUpstreamEditing(false); setError(""); }}>{translateInterface("m19766ed6ccb2")}</button>
              <button className="embed-btn" style={{ borderColor: "var(--embed-success)", color: "var(--embed-success)" }}
                onClick={handleUpstreamSave} disabled={saving}>{saving ? "..." : translateInterface("m1509f561f241")}</button>
            </div>
          )}
        </div>
        {upstreamEditing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {upstreamDraft.map((s, i) => (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input value={s} onChange={(e) => { const d = [...upstreamDraft]; d[i] = e.target.value; setUpstreamDraft(d); }}
                  placeholder={translateInterface("m83bff7d20509")}
                  style={{ flex: 1, padding: "4px 8px", fontSize: 13, border: "1px solid var(--embed-border)", borderRadius: 4, background: "transparent", color: "inherit" }} />
                {upstreamDraft.length > 1 && (
                  <button className="embed-btn" style={{ padding: "2px 8px", color: "var(--embed-danger)", borderColor: "var(--embed-danger)" }}
                    onClick={() => setUpstreamDraft(upstreamDraft.filter((_, j) => j !== i))}>{"\u2715"}</button>
                )}
              </div>
            ))}
            <button className="embed-btn" style={{ alignSelf: "flex-start", fontSize: 12 }}
              onClick={() => setUpstreamDraft([...upstreamDraft, ""])}>{translateInterface("m9cdfc7a999c9")}</button>
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {upstreams.length > 0 ? upstreams.map((s) => (
              <span key={s} className="embed-badge embed-mono" style={{ fontSize: 12 }}>{s}</span>
            )) : <span className="embed-muted" style={{ fontSize: 13 }}>{translateInterface("mba66ba839fc1")}</span>}
          </div>
        )}
      </div>

      {/* DNSSEC */}
      <div className="embed-card" style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontWeight: 500, fontSize: 13 }}>DNSSEC</div>
          <div className="embed-muted" style={{ fontSize: 12 }}>{translateInterface("m70fb94dc5558")}</div>
        </div>
        <ToggleSwitch checked={config?.dnssec || false} onChange={(v) => handleConfigSave({ dnssec: v })} disabled={saving} />
      </div>

      {/* Query Logging */}
      <div className="embed-card" style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontWeight: 500, fontSize: 13 }}>{translateInterface("md170e5d65e48")}</div>
          <div className="embed-muted" style={{ fontSize: 12 }}>{translateInterface("m57e915fa2d79")}</div>
        </div>
        <ToggleSwitch checked={config?.queryLogging !== false} onChange={(v) => handleConfigSave({ queryLogging: v })} disabled={saving} />
      </div>

      {/* Cache Size */}
      <div className="embed-card" style={{ marginTop: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 500, fontSize: 13 }}>{translateInterface("m4f3fc8891c88")}</div>
            <div className="embed-muted" style={{ fontSize: 12 }}>{translateInterface("m5337ffe98ca4")}</div>
          </div>
          <span className="embed-badge embed-mono">{config?.cache?.size?.toLocaleString(locale) || "10,000"}</span>
        </div>
      </div>

      {/* Rate Limiting */}
      <div className="embed-card" style={{ marginTop: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 500, fontSize: 13 }}>{translateInterface("m74dea5e67162")}</div>
            <div className="embed-muted" style={{ fontSize: 12 }}>{translateInterface("mca210b33e8a5")}</div>
          </div>
          <span className="embed-badge embed-mono">
            {config?.rateLimit?.count || 1000} / {config?.rateLimit?.interval || 60}s
          </span>
        </div>
      </div>
    </>
  );
}

// ─── Shared Components ───────────────────────────────────────────────────────

function ToggleSwitch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      style={{
        width: 40, height: 22, borderRadius: 11, border: "none", cursor: disabled ? "not-allowed" : "pointer",
        background: checked ? "var(--embed-success)" : "var(--embed-border)",
        position: "relative", transition: "background 0.2s", flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{
        position: "absolute", top: 2, left: checked ? 20 : 2,
        width: 18, height: 18, borderRadius: 9, background: "#fff",
        transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
      }} />
    </button>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="embed-card">
      <div className="embed-label" style={{ marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

function DomainTable({ title, entries }: { title: string; entries: Array<{ domain: string; count: number }> }) {
  const locale = useLocale();

  const translateInterface = useInterfaceTranslations("interface");

  return (
    <div className="embed-card">
      <div className="embed-card-title">{title}</div>
      {entries.length === 0 ? (
        <div className="embed-muted" style={{ fontSize: 13 }}>{translateInterface("m3b41ba9c7cb8")}</div>
      ) : (
        <table className="embed-table">
          <thead><tr><th>{translateInterface("m79fa33618d8e")}</th><th style={{ textAlign: "right" }}>{translateInterface("m37bac4952bec")}</th></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.domain}>
                <td className="embed-mono">{e.domain}</td>
                <td style={{ textAlign: "right" }}>{e.count.toLocaleString(locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div>
      <div className="embed-skeleton" style={{ height: 20, width: 200, marginBottom: 16 }} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="embed-card">
            <div className="embed-skeleton" style={{ height: 12, width: 80, marginBottom: 12 }} />
            <div className="embed-skeleton" style={{ height: 24, width: 60 }} />
          </div>
        ))}
      </div>
    </div>
  );
}
