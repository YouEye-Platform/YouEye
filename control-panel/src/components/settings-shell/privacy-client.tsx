"use client";



import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Activity, Clock, Download, Loader2, type LucideIcon, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/settings-shell/page-header";
import { validTimelineSecret } from "../../../../shared/timeline-secret";
import { uiSettingsApi } from "@/components/settings-shell/api-base";
import { useRef as useInterfaceTranslationRef } from "react";

// CP admin write pattern — CSRF token from the CP-guaranteed proxy.
async function csrfHeaders(): Promise<HeadersInit> {
  const r = await fetch("/settings/api/auth/csrf");
  const b = await r.json().catch(() => ({}));
  return { "Content-Type": "application/json", "X-CSRF-Token": b.csrfToken ?? "" };
}

export function PrivacyClient({ isAdmin }: { isAdmin: boolean }) {
  const translateInterface = useInterfaceTranslations("interface");

  return (
    <div>
      <PageHeader title={translateInterface("m54a57c3147c4")} description={translateInterface("mb94512bc4ce9")} />
      <div className="space-y-6">
        <TimelineCollectionCard />
        <YourDataCard />
        {isAdmin && <ServerCard />}
      </div>
    </div>
  );
}

/* ───────────────────────── Your data (per-user) ───────────────────────── */

type CollectionState = { configured: boolean; enabled: boolean; revision: string | null };
function TimelineCollectionCard() {
  const translateInterface = useInterfaceTranslations("interface");
  const interfaceTranslationRef = useInterfaceTranslationRef(translateInterface);
  interfaceTranslationRef.current = translateInterface;

  const [state, setState] = useState<CollectionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const load = useCallback(async () => {
    try {
      const res = await fetch(uiSettingsApi("timeline/collection"), { cache: "no-store" });
      if (!res.ok) throw new Error(interfaceTranslationRef.current("m48cb26f49fff"));
      const current = await res.json();
      if (typeof current.enabled !== "boolean") throw new Error(interfaceTranslationRef.current("m48cb26f49fff"));
      setState(current);
    } catch { setState(null); setNote(interfaceTranslationRef.current("m7c7f8d51262b")); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function save(enabled: boolean) {
    if (!state || busy) return;
    setBusy(true); setNote("");
    try {
      const res = await fetch(uiSettingsApi("timeline/collection"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, expected_revision: state.revision, request_id: crypto.randomUUID() }),
      });
      const current = await res.json();
      if (!res.ok) throw new Error(current.error === "key_required" ? translateInterface("m853b34981d23") : translateInterface("m068c97931ccb"));
      setState(current);
      setNote(current.enabled ? translateInterface("m1ac3698de380") : translateInterface("m30a2d3036ebd"));
    } catch (error) {
      setNote(error instanceof Error ? error.message : translateInterface("mbdc2dfa3e0e5"));
      await load();
    } finally { setBusy(false); }
  }
  return <Section title={translateInterface("m3f3abb718109")}>
    <Row icon={Clock} title={state ? (state.enabled ? translateInterface("m49923597aa88") : translateInterface("mb5be0abae288")) : translateInterface("m5db29dadc5c6")}
      sub={translateInterface("m391f41a0d510")}
      right={<Switch checked={state?.enabled ?? false} disabled={!state || busy} onCheckedChange={(enabled) => void save(enabled)} aria-label={translateInterface("m97cd3e40a885")} />} />
    {!state && <Button variant="ghost" onClick={() => void load()}>{translateInterface("m942087cc2d41")}</Button>}
    <p className="px-[18px] py-3 text-sm text-muted-foreground" role="status">{note || translateInterface("ma7e3704d3c51")}</p>
  </Section>;
}

function YourDataCard() {
  const translateInterface = useInterfaceTranslations("interface");
  const interfaceTranslationRef = useInterfaceTranslationRef(translateInterface);
  interfaceTranslationRef.current = translateInterface;

  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [mode, setMode] = useState<"idle" | "create" | "change">("idle");
  const [pin, setPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [repeatPin, setRepeatPin] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(uiSettingsApi("pin/status"));
      if (r.ok) {
        const d = await r.json().catch(() => null);
        if (typeof d?.has_pin !== "boolean" || typeof d?.session_active !== "boolean") throw new Error(interfaceTranslationRef.current("macdfe951bca4"));
        setHasPin(d.has_pin);
        setSessionActive(d.session_active);
      } else {
        console.error("[Privacy] pin status failed", r.status);
        setHasPin(null);
        setNote(interfaceTranslationRef.current("md2a6768e3ec5"));
      }
    } catch (e) {
      console.error("[Privacy] pin status error", e);
      setHasPin(null);
        setNote(interfaceTranslationRef.current("md2a6768e3ec5"));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function createPin() {
    if (!validTimelineSecret(pin) || pin !== repeatPin) {
      setNote(translateInterface("mab16899f7d70"));
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const r = await fetch(uiSettingsApi("pin/create"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: pin }),
      });
      if (r.ok) {
        setNote(translateInterface("m7941ae1feb81"));
        setPin("");
        setMode("idle");
        load();
      } else {
        console.error("[Privacy] pin create failed", r.status);
        setNote(translateInterface("m8b378bcc4dd5"));
      }
    } catch (e) {
      console.error("[Privacy] pin create error", e);
      setNote(translateInterface("m8b378bcc4dd5"));
    } finally {
      setBusy(false);
    }
  }

  async function changePin() {
    if (!validTimelineSecret(newPin) || newPin !== repeatPin) {
      setNote(translateInterface("mab16899f7d70"));
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const r = await fetch(uiSettingsApi("pin/change"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_pin: pin, new_pin: newPin }),
      });
      if (r.ok) {
        setNote(translateInterface("madc7f31dc383"));
        setPin("");
        setNewPin("");
        setMode("idle");
        load();
      } else {
        console.error("[Privacy] pin change failed", r.status);
        setNote(translateInterface("mbf7c1c70b535"));
      }
    } catch (e) {
      console.error("[Privacy] pin change error", e);
      setNote(translateInterface("ma4e216da0e2a"));
    } finally {
      setBusy(false);
    }
  }

  async function lockNow() {
    try {
      await fetch(uiSettingsApi("pin/session"), { method: "DELETE" });
      setNote(translateInterface("m97f4b4600df7"));
      load();
    } catch (e) {
      console.error("[Privacy] lock now error", e);
    }
  }

  return (
    <Section title={translateInterface("mee5ef73aae18")}>
      {hasPin === null ? (
        <div className="p-4"><p role="status">{note || translateInterface("md22aaeeebd3e")}</p><Button variant="ghost" onClick={() => void load()}>{translateInterface("m942087cc2d41")}</Button></div>
      ) : (
        <>
          <Row
            icon={Clock}
            title={translateInterface("m2205f92fa640")}
            sub={translateInterface("ma584ca624d6e")}
            right={
              <Switch
                checked={hasPin}
                disabled={hasPin}
                onCheckedChange={(v) => {
                  if (v && !hasPin) setMode(mode === "create" ? "idle" : "create");
                }}
                aria-label={translateInterface("m2205f92fa640")}
              />
            }
          />

          {/* Enable (no PIN yet) — toggling the switch reveals this */}
          {!hasPin && mode === "create" && (
            <div className="border-t bg-muted/30 px-[18px] py-3">
              <p className="mb-2 text-[13px] text-muted-foreground">{translateInterface("m491d79ec0f23")}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type={showSecret ? "text" : "password"}
                  autoComplete="new-password"
                  aria-label={translateInterface("mfb4a15e49c42")}
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder={translateInterface("m1088a1c0fee8")}
                  className="h-9 w-44"
                />
                <Input type={showSecret ? "text" : "password"} autoComplete="new-password" aria-label={translateInterface("mf19526bb4e3f")} value={repeatPin} onChange={(e) => setRepeatPin(e.target.value)} placeholder={translateInterface("m3185b896a821")} className="h-9 w-44" />
                <Button size="sm" className="h-9" disabled={busy} onClick={createPin}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{translateInterface("mfc646e18bfd3")}</Button>
                <Button size="sm" variant="ghost" className="h-9" onClick={() => { setMode("idle"); setPin(""); setNote(""); }}>
                  {translateInterface("m19766ed6ccb2")}</Button>
              </div>
            </div>
          )}

          {/* Manage (PIN set) */}
          {hasPin && (
            <div className="border-t px-[18px] py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" className="h-8" onClick={() => setMode(mode === "change" ? "idle" : "change")}>
                  {translateInterface("m9c1a18a2bd39")}</Button>
                {sessionActive && (
                  <Button size="sm" variant="ghost" className="h-8 text-muted-foreground" onClick={lockNow}>
                    {translateInterface("m93ba3f249e56")}</Button>
                )}
                <span className="text-[12px] text-muted-foreground">{sessionActive ? translateInterface("mf7ab9686687a") : translateInterface("ma424e33d9093")}</span>
              </div>
              {mode === "change" && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Input type={showSecret ? "text" : "password"} aria-label={translateInterface("m7371b83f4970")} autoComplete="current-password" value={pin} onChange={(e) => setPin(e.target.value)} placeholder={translateInterface("m348fba2d6ae8")} className="h-9 w-40" />
                  <Input type={showSecret ? "text" : "password"} aria-label={translateInterface("mfb4a15e49c42")} autoComplete="new-password" value={newPin} onChange={(e) => setNewPin(e.target.value)} placeholder={translateInterface("m1088a1c0fee8")} className="h-9 w-40" />
                  <Input type={showSecret ? "text" : "password"} autoComplete="new-password" aria-label={translateInterface("mf19526bb4e3f")} value={repeatPin} onChange={(e) => setRepeatPin(e.target.value)} placeholder={translateInterface("m3185b896a821")} className="h-9 w-40" />
                  <Button size="sm" className="h-9" disabled={busy} onClick={changePin}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{translateInterface("m1509f561f241")}</Button>
                </div>
              )}
              <p className="mt-2 text-[12px] text-muted-foreground">{translateInterface("m58318ec026cc")}</p>
            </div>
          )}

          {mode !== "idle" && <div className="border-t px-[18px] py-3 text-sm"><p>{translateInterface("mbf545b6cf399")}</p><label className="mt-2 flex items-center gap-2"><Switch checked={showSecret} onCheckedChange={setShowSecret} aria-label={translateInterface("medb8d11e4810")} />{translateInterface("medb8d11e4810")}</label></div>}
          {note && <div className="border-t px-[18px] py-2 text-[13px] text-muted-foreground">{note}</div>}

          {/* Export my data — scoped out honestly (no backend yet; pitfall #28) */}
          <Row
            icon={Download}
            title={translateInterface("mfddb7f9c69fe")}
            sub="Profile, timeline, bookmarks, and app preferences"
            right={
              <span className="inline-flex items-center gap-2">
                <Badge variant="secondary" className="text-[11px]">{translateInterface("m4f7d64017689")}</Badge>
                <Button size="sm" variant="outline" className="h-8" disabled>
                  {translateInterface("m3664895579f0")}</Button>
              </span>
            }
          />
        </>
      )}
    </Section>
  );
}

/* ─────────────────── Server (admin) — local usage stats ────────────────── */

function ServerCard() {
  const translateInterface = useInterfaceTranslations("interface");

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/settings/api/telemetry/settings");
      if (r.ok) {
        const d = await r.json().catch(() => null);
        setEnabled(!!d?.enabled);
      } else {
        console.error("[Privacy] telemetry settings failed", r.status);
        setNote(translateInterface("meeb789252476"));
      }
    } catch (e) {
      console.error("[Privacy] telemetry settings error", e);
      setNote(translateInterface("meeb789252476"));
    }
  }, [translateInterface]);
  useEffect(() => {
    load();
  }, [load]);

  async function toggle(v: boolean) {
    setBusy(true);
    setNote("");
    try {
      const r = await fetch("/settings/api/telemetry/settings", {
        method: "PATCH",
        headers: await csrfHeaders(),
        body: JSON.stringify({ enabled: v }),
      });
      if (r.ok) setEnabled(v);
      else {
        console.error("[Privacy] telemetry PATCH failed", r.status);
        setNote(translateInterface("m8ea70d8144ca"));
      }
    } catch (e) {
      console.error("[Privacy] telemetry PATCH error", e);
      setNote(translateInterface("m8ea70d8144ca"));
    } finally {
      setBusy(false);
    }
  }

  function download() {
    window.location.href = "/settings/api/telemetry/export";
  }

  async function reset() {
    if (!confirm(translateInterface("mf5d2da5295f5"))) return;
    setBusy(true);
    setNote("");
    try {
      const r = await fetch("/settings/api/telemetry/export", { method: "DELETE", headers: await csrfHeaders() });
      if (r.ok) setNote(translateInterface("m53977ab6afbd"));
      else {
        console.error("[Privacy] telemetry reset failed", r.status);
        setNote(translateInterface("mf2beb37f601a"));
      }
    } catch (e) {
      console.error("[Privacy] telemetry reset error", e);
      setNote(translateInterface("mf2beb37f601a"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title={translateInterface("maef7de28d529")} badge="Admin">
      <Row
        icon={Activity}
        title={translateInterface("m929b7eeb9c21")}
        sub="Collected and kept on this server only — never leave it unless you export and share them yourself"
        right={
          enabled === null ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Switch checked={enabled} disabled={busy} onCheckedChange={toggle} aria-label={translateInterface("m929b7eeb9c21")} />
          )
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-t px-[18px] py-3">
        <Button size="sm" variant="outline" className="h-8" onClick={download}>
          <Download className="h-3.5 w-3.5" /> {translateInterface("m6c68ad180780")}</Button>
        <Button size="sm" variant="ghost" className="h-8 text-muted-foreground" disabled={busy} onClick={reset}>
          <RotateCcw className="h-3.5 w-3.5" /> {translateInterface("m839cd122a425")}</Button>
        {note && <span className="text-[12px] text-muted-foreground">{note}</span>}
      </div>
    </Section>
  );
}

/* ─────────────────────────── shared bits ─────────────────────────── */

function Section({ title, badge, children }: { title: string; badge?: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center justify-between px-[18px] py-3">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {badge && <Badge variant="secondary" className="text-[11px]">{badge}</Badge>}
      </div>
      {children}
    </section>
  );
}

function Row({
  icon: Icon,
  title,
  sub,
  right,
}: {
  icon: LucideIcon;
  title: string;
  sub?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-t px-[18px] py-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-[18px]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {sub && <div className="text-[13px] text-muted-foreground">{sub}</div>}
      </div>
      {right}
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="flex items-center justify-center border-t py-10">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}
