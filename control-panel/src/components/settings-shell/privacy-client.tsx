"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Activity, Clock, Download, Loader2, type LucideIcon, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/settings-shell/page-header";
import { uiSettingsApi } from "@/components/settings-shell/api-base";

// CP admin write pattern — CSRF token from the CP-guaranteed proxy.
async function csrfHeaders(): Promise<HeadersInit> {
  const r = await fetch("/settings/api/auth/csrf");
  const b = await r.json().catch(() => ({}));
  return { "Content-Type": "application/json", "X-CSRF-Token": b.csrfToken ?? "" };
}

export function PrivacyClient({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div>
      <PageHeader title="Privacy" description="What this server keeps and shares about you" />
      <div className="space-y-6">
        <YourDataCard />
        {isAdmin && <ServerCard />}
      </div>
    </div>
  );
}

/* ───────────────────────── Your data (per-user) ───────────────────────── */

function YourDataCard() {
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [mode, setMode] = useState<"idle" | "create" | "change">("idle");
  const [pin, setPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(uiSettingsApi("pin/status"));
      if (r.ok) {
        const d = await r.json().catch(() => null);
        setHasPin(!!d?.has_pin);
        setSessionActive(!!d?.session_active);
      } else {
        console.error("[Privacy] pin status failed", r.status);
        setHasPin(false);
      }
    } catch (e) {
      console.error("[Privacy] pin status error", e);
      setHasPin(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function createPin() {
    if (pin.trim().length < 4) {
      setNote("Choose a PIN of at least 4 digits.");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const r = await fetch(uiSettingsApi("pin/create"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: pin.trim() }),
      });
      if (r.ok) {
        setNote("Timeline lock enabled.");
        setPin("");
        setMode("idle");
        load();
      } else {
        console.error("[Privacy] pin create failed", r.status);
        setNote("Could not enable the lock.");
      }
    } catch (e) {
      console.error("[Privacy] pin create error", e);
      setNote("Could not enable the lock.");
    } finally {
      setBusy(false);
    }
  }

  async function changePin() {
    if (newPin.trim().length < 4) {
      setNote("Choose a new PIN of at least 4 digits.");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const r = await fetch(uiSettingsApi("pin/change"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_pin: pin.trim(), new_pin: newPin.trim() }),
      });
      if (r.ok) {
        setNote("PIN changed.");
        setPin("");
        setNewPin("");
        setMode("idle");
        load();
      } else {
        console.error("[Privacy] pin change failed", r.status);
        setNote("Could not change the PIN — check your current PIN.");
      }
    } catch (e) {
      console.error("[Privacy] pin change error", e);
      setNote("Could not change the PIN.");
    } finally {
      setBusy(false);
    }
  }

  async function lockNow() {
    try {
      await fetch(uiSettingsApi("pin/session"), { method: "DELETE" });
      setNote("Timeline locked.");
      load();
    } catch (e) {
      console.error("[Privacy] lock now error", e);
    }
  }

  return (
    <Section title="Your data">
      {hasPin === null ? (
        <RowSkeleton />
      ) : (
        <>
          <Row
            icon={Clock}
            title="Timeline lock"
            sub="Require your PIN to view timeline history"
            right={
              <Switch
                checked={hasPin}
                disabled={hasPin}
                onCheckedChange={(v) => {
                  if (v && !hasPin) setMode(mode === "create" ? "idle" : "create");
                }}
                aria-label="Timeline lock"
              />
            }
          />

          {/* Enable (no PIN yet) — toggling the switch reveals this */}
          {!hasPin && mode === "create" && (
            <div className="border-t bg-muted/30 px-[18px] py-3">
              <p className="mb-2 text-[13px] text-muted-foreground">Choose a PIN to lock your timeline history.</p>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="password"
                  inputMode="numeric"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder="New PIN"
                  className="h-9 w-44"
                />
                <Button size="sm" className="h-9" disabled={busy} onClick={createPin}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Enable lock
                </Button>
                <Button size="sm" variant="ghost" className="h-9" onClick={() => { setMode("idle"); setPin(""); setNote(""); }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Manage (PIN set) */}
          {hasPin && (
            <div className="border-t px-[18px] py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" className="h-8" onClick={() => setMode(mode === "change" ? "idle" : "change")}>
                  Change PIN
                </Button>
                {sessionActive && (
                  <Button size="sm" variant="ghost" className="h-8 text-muted-foreground" onClick={lockNow}>
                    Lock now
                  </Button>
                )}
                <span className="text-[12px] text-muted-foreground">{sessionActive ? "Unlocked this session" : "Locked"}</span>
              </div>
              {mode === "change" && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="Current PIN" className="h-9 w-40" />
                  <Input type="password" inputMode="numeric" value={newPin} onChange={(e) => setNewPin(e.target.value)} placeholder="New PIN" className="h-9 w-40" />
                  <Button size="sm" className="h-9" disabled={busy} onClick={changePin}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Save
                  </Button>
                </div>
              )}
              <p className="mt-2 text-[12px] text-muted-foreground">Removing the lock isn’t available yet — you can change your PIN above.</p>
            </div>
          )}

          {note && <div className="border-t px-[18px] py-2 text-[13px] text-muted-foreground">{note}</div>}

          {/* Export my data — scoped out honestly (no backend yet; pitfall #28) */}
          <Row
            icon={Download}
            title="Export my data"
            sub="Profile, timeline, bookmarks, and app preferences"
            right={
              <span className="inline-flex items-center gap-2">
                <Badge variant="secondary" className="text-[11px]">Coming soon</Badge>
                <Button size="sm" variant="outline" className="h-8" disabled>
                  Export
                </Button>
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
        setNote("Couldn’t load usage settings.");
      }
    } catch (e) {
      console.error("[Privacy] telemetry settings error", e);
      setNote("Couldn’t load usage settings.");
    }
  }, []);
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
        setNote("Couldn’t update collection.");
      }
    } catch (e) {
      console.error("[Privacy] telemetry PATCH error", e);
      setNote("Couldn’t update collection.");
    } finally {
      setBusy(false);
    }
  }

  function download() {
    window.location.href = "/settings/api/telemetry/export";
  }

  async function reset() {
    if (!confirm("Delete all local usage statistics? This cannot be undone.")) return;
    setBusy(true);
    setNote("");
    try {
      const r = await fetch("/settings/api/telemetry/export", { method: "DELETE", headers: await csrfHeaders() });
      if (r.ok) setNote("Usage data deleted.");
      else {
        console.error("[Privacy] telemetry reset failed", r.status);
        setNote("Couldn’t delete usage data.");
      }
    } catch (e) {
      console.error("[Privacy] telemetry reset error", e);
      setNote("Couldn’t delete usage data.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Server" badge="Admin">
      <Row
        icon={Activity}
        title="Local usage statistics"
        sub="Collected and kept on this server only — never leave it unless you export and share them yourself"
        right={
          enabled === null ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Switch checked={enabled} disabled={busy} onCheckedChange={toggle} aria-label="Local usage statistics" />
          )
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-t px-[18px] py-3">
        <Button size="sm" variant="outline" className="h-8" onClick={download}>
          <Download className="h-3.5 w-3.5" /> Download report
        </Button>
        <Button size="sm" variant="ghost" className="h-8 text-muted-foreground" disabled={busy} onClick={reset}>
          <RotateCcw className="h-3.5 w-3.5" /> Reset data
        </Button>
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
