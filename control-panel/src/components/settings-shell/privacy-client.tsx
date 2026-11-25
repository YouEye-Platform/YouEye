"use client";

import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/settings-shell/page-header";
import { validTimelineSecret } from "../../../../shared/timeline-secret";
import { uiSettingsApi } from "@/components/settings-shell/api-base";
import { useLatestRef } from "@/lib/use-latest-ref";

/** Privacy is personal only: what your timeline keeps, and the lock on it. Server statistics are on General. */
export function PrivacyClient() {
  const translateInterface = useInterfaceTranslations("interface");
  const t = useInterfaceTranslations("settingsYou.privacy");

  return (
    <div>
      <PageHeader title={translateInterface("m54a57c3147c4")} description={t("description")} />
      <div className="settings-sections">
        <section className="settings-section" aria-labelledby="privacy-timeline">
          <h2 id="privacy-timeline" className="settings-section-title">{t("timeline")}</h2>
          <div className="settings-group">
            <TimelineCollection />
            <TimelineLock />
          </div>
        </section>
      </div>
    </div>
  );
}

type CollectionState = { configured: boolean; enabled: boolean; revision: string | null };
function TimelineCollection() {
  const translateInterface = useInterfaceTranslations("interface");
  const interfaceTranslationRef = useLatestRef(translateInterface);

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
  }, [interfaceTranslationRef]);
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
  return (
    <div>
      <label className="settings-item">
        <span className="settings-item-text">
          <span className="settings-item-label">{state ? (state.enabled ? translateInterface("m49923597aa88") : translateInterface("mb5be0abae288")) : translateInterface("m5db29dadc5c6")}</span>
          <span className="settings-item-hint">{translateInterface("m391f41a0d510")}</span>
        </span>
        <Switch checked={state?.enabled ?? false} disabled={!state || busy} onCheckedChange={(enabled) => void save(enabled)} aria-label={translateInterface("m97cd3e40a885")} />
      </label>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-3">
        <p className="min-w-0 flex-1 text-[13px] text-muted-foreground" role="status">{note || translateInterface("ma7e3704d3c51")}</p>
        {!state && <Button variant="outline" size="sm" onClick={() => void load()}>{translateInterface("m942087cc2d41")}</Button>}
      </div>
    </div>
  );
}

function TimelineLock() {
  const translateInterface = useInterfaceTranslations("interface");
  const t = useInterfaceTranslations("settingsYou.privacy");
  const interfaceTranslationRef = useLatestRef(translateInterface);

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
  }, [interfaceTranslationRef]);
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

  if (hasPin === null) {
    return (
      <div className="settings-item">
        <span className="settings-item-text">
          <span className="settings-item-label">{translateInterface("m2205f92fa640")}</span>
          <span className="settings-item-hint" role="status">{note || translateInterface("md22aaeeebd3e")}</span>
        </span>
        <Button variant="outline" size="sm" onClick={() => void load()}>{translateInterface("m942087cc2d41")}</Button>
      </div>
    );
  }

  const secretType = showSecret ? "text" : "password";
  const formOpen = (!hasPin && mode === "create") || (hasPin && mode === "change");

  return (
    <div>
      <div className="settings-item">
        <span className="settings-item-text">
          <span className="settings-item-label">{translateInterface("m2205f92fa640")}</span>
          <span className="settings-item-hint">{translateInterface("ma584ca624d6e")}</span>
          {hasPin && <span className="settings-item-hint">{sessionActive ? translateInterface("mf7ab9686687a") : translateInterface("ma424e33d9093")}</span>}
        </span>
        {hasPin ? (
          <span className="settings-item-actions">
            {sessionActive && <Button size="sm" variant="ghost" onClick={lockNow}>{translateInterface("m93ba3f249e56")}</Button>}
            <Button size="sm" variant="outline" aria-expanded={mode === "change"} onClick={() => { setMode(mode === "change" ? "idle" : "change"); setNote(""); }}>{translateInterface("m9c1a18a2bd39")}</Button>
          </span>
        ) : (
          <Button size="sm" variant="outline" aria-expanded={mode === "create"} onClick={() => { setMode(mode === "create" ? "idle" : "create"); setPin(""); setRepeatPin(""); setNote(""); }}>{t("setUpLock")}</Button>
        )}
      </div>

      {formOpen && (
        <div className="settings-panel grid grid-cols-[minmax(0,1fr)] gap-3 border-t">
          <p className="text-[13px] text-muted-foreground">{hasPin ? translateInterface("mbf545b6cf399") : translateInterface("m491d79ec0f23")}</p>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:max-w-sm">
            {hasPin && <Input type={secretType} aria-label={translateInterface("m7371b83f4970")} autoComplete="current-password" value={pin} onChange={(e) => setPin(e.target.value)} placeholder={translateInterface("m348fba2d6ae8")} />}
            <Input
              type={secretType}
              autoComplete="new-password"
              aria-label={translateInterface("mfb4a15e49c42")}
              value={hasPin ? newPin : pin}
              onChange={(e) => (hasPin ? setNewPin(e.target.value) : setPin(e.target.value))}
              placeholder={translateInterface("m1088a1c0fee8")}
            />
            <Input type={secretType} autoComplete="new-password" aria-label={translateInterface("mf19526bb4e3f")} value={repeatPin} onChange={(e) => setRepeatPin(e.target.value)} placeholder={translateInterface("m3185b896a821")} />
          </div>
          {!hasPin && <p className="text-[13px] text-muted-foreground">{translateInterface("mbf545b6cf399")}</p>}
          <label className="flex min-h-9 items-center gap-2 text-sm">
            <Switch checked={showSecret} onCheckedChange={setShowSecret} aria-label={translateInterface("medb8d11e4810")} />
            {translateInterface("medb8d11e4810")}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy} onClick={hasPin ? changePin : createPin}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              {hasPin ? translateInterface("m1509f561f241") : translateInterface("mfc646e18bfd3")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setMode("idle"); setPin(""); setNewPin(""); setRepeatPin(""); setNote(""); }}>{translateInterface("m19766ed6ccb2")}</Button>
          </div>
        </div>
      )}

      {hasPin && <p className="px-4 pb-3 text-[13px] text-muted-foreground">{translateInterface("m58318ec026cc")}</p>}
      {note && <p className="border-t px-4 py-2.5 text-[13px] text-muted-foreground" role="status">{note}</p>}
    </div>
  );
}
