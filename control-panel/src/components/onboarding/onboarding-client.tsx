"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ImagePlus, Loader2 } from "lucide-react";
import { Brand } from "@youeye/branding/brand";
import { validTimelineSecret } from "../../../../shared/timeline-secret";
import { useTranslations as useInterfaceTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProfileIconPicker } from "@/components/settings-shell/profile-icon-picker";
import { useRef as useInterfaceTranslationRef } from "react";

type Step = "welcome" | "icon" | "timeline" | "review" | "done";
type Snapshot = { completed: boolean; has_pin: boolean; timeline: { configured: boolean; enabled: boolean; revision: string | null } };
export function OnboardingClient({ username }: { username: string }) {
  const translateInterface = useInterfaceTranslations("interface");
  const interfaceTranslationRef = useInterfaceTranslationRef(translateInterface);
  interfaceTranslationRef.current = translateInterface;

  const uploadRef = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const requestId = useRef<string | null>(null);
  const [backward, setBackward] = useState(false);
  const [step, setStep] = useState<Step>("welcome");
  const [branding, setBranding] = useState<{ site_name: string; site_name_style?: { mytitle?: unknown } } | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selectedIcon, setSelectedIcon] = useState<string | null>(null);
  const [choice, setChoice] = useState<boolean | null>(null);
  const [pin, setPin] = useState("");
  const [repeatPin, setRepeatPin] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [navigationPending, setNavigationPending] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      const [brandRes, stateRes] = await Promise.all([fetch("/api/ui/branding", { cache: "no-store" }), fetch("/api/ui-settings/onboarding", { cache: "no-store" })]);
      if (!brandRes.ok || !stateRes.ok) throw new Error(interfaceTranslationRef.current("m0358371cfc56"));
      const state: Snapshot = await stateRes.json();
      // Home belongs to the dashboard's separate Next runtime.
      if (state.completed) { window.location.replace("/"); return; }
      if (!state.timeline || typeof state.has_pin !== "boolean") throw new Error(interfaceTranslationRef.current("m266904f3613d"));
      setBranding(await brandRes.json()); setSnapshot(state);
      if (state.timeline.configured) setChoice(state.timeline.enabled);
    } catch (cause) { setError(cause instanceof Error ? cause.message : interfaceTranslationRef.current("m6ac2382ef63e")); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const snapshotReady = snapshot !== null;
  useEffect(() => { heading.current?.focus(); }, [step, snapshotReady]);
  useEffect(() => {
    // Repeated pointer presses on a disabled entering control can move native
    // focus to the body. Restore the heading without stealing an input's focus.
    if (!navigationPending && document.activeElement === document.body) heading.current?.focus();
  }, [navigationPending]);
  useEffect(() => {
    if (!navigationPending) return;
    // Keep the same short interaction guard with reduced motion: a repeated
    // click must not activate a different control appearing under the pointer.
    const timer = window.setTimeout(() => setNavigationPending(false), 420);
    return () => window.clearTimeout(timer);
  }, [navigationPending]);
  function go(next: Step) { if (!busy && !navigationPending) { const order: Step[] = ["welcome", "icon", "timeline", "review", "done"]; setNavigationPending(true); setBackward(order.indexOf(next) < order.indexOf(step)); setError(""); setStep(next); } }
  async function savePreset(presetId: string) {
    if (busy || navigationPending) return;
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/user/avatar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ presetId }) });
      if (!res.ok) throw new Error(translateInterface("mbb83bb94fd81"));
      setSelectedIcon(presetId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : translateInterface("mbb83bb94fd81")); }
    finally { setBusy(false); }
  }
  async function uploadPhoto(file: File) {
    if (busy || navigationPending) return;
    setBusy(true); setError("");
    try {
      const body = new FormData(); body.append("file", file);
      const res = await fetch("/api/user/avatar", { method: "POST", body });
      if (!res.ok) throw new Error(translateInterface("mafc0b07d75e9"));
      setSelectedIcon(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : translateInterface("m33a052b33c3d")); }
    finally { setBusy(false); }
  }
  function review(enabled: boolean) {
    if (busy || navigationPending) return;
    if (enabled && !snapshot?.has_pin) {
      if (!validTimelineSecret(pin)) return setError(translateInterface("mbf545b6cf399"));
      if (pin !== repeatPin) return setError(translateInterface("m78412c57dad6"));
    }
    setChoice(enabled); requestId.current = null;
    go("review");
  }
  async function finish() {
    if (!snapshot || choice === null || busy || navigationPending) return;
    setBusy(true); setError("");
    requestId.current ||= crypto.randomUUID();
    try {
      if (choice && !snapshot.has_pin) {
        if (!validTimelineSecret(pin) || pin !== repeatPin) throw new Error(translateInterface("mb99458a52a21"));
        const res = await fetch("/api/ui-settings/pin/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
        if (!res.ok) throw new Error(translateInterface("mbcbe2e72249b"));
        setSnapshot((current) => current ? { ...current, has_pin: true } : current);
      }
      const res = await fetch("/api/ui-settings/onboarding/complete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: choice, expected_revision: snapshot.timeline.revision, request_id: requestId.current }),
      });
      if (!res.ok) throw new Error(translateInterface("m3cea4bf43d9e"));
      const saved = await res.json();
      if (saved.completed !== true || saved.enabled !== choice) throw new Error(translateInterface("m1725f4f6363a"));
      setPin(""); setRepeatPin(""); setStep("done");
    } catch (cause) {
      // Reconcile a lost response without replaying key creation or completion.
      try {
        const res = await fetch("/api/ui-settings/onboarding", { cache: "no-store" });
        if (res.ok) {
          const current: Snapshot = await res.json();
          if (current.completed) { setPin(""); setRepeatPin(""); setStep("done"); return; }
          if (current.timeline.revision !== snapshot.timeline.revision) { setChoice(null); requestId.current = null; setStep("timeline"); }
          setSnapshot(current);
        }
      } catch { /* Keep the last confirmed state; the owner can retry. */ }
      setError(cause instanceof Error ? cause.message : translateInterface("m0d8490767a49"));
    } finally { setBusy(false); }
  }
  const siteName = branding?.site_name || "YouEye";
  return <main className="onboarding-shell personal-onboarding flex min-h-screen items-center justify-center bg-background px-5 py-12">
    <section key={step} className={`onboarding-step onboarding-card w-full max-w-2xl space-y-6 p-5 sm:p-10 ${backward ? "onboarding-back" : ""}`} aria-busy={busy || navigationPending}
      onClickCapture={(event) => { if (navigationPending) { event.preventDefault(); event.stopPropagation(); } }}>
      {!snapshot || !branding ? <><p role="status">{error || translateInterface("m4ea4e289784f")}</p>{error && <Button onClick={() => void load()}>{translateInterface("m942087cc2d41")}</Button>}</> : <>
        {step === "welcome" && <div className="space-y-7 text-center">
          <div className="flex items-center justify-center gap-3"><Brand design={branding.site_name_style?.mytitle} view="icon" /><Brand design={branding.site_name_style?.mytitle} name={siteName} /></div>
          <div><h1 ref={heading} tabIndex={-1} className="text-3xl font-semibold tracking-tight">{translateInterface("md509809659b4", { username })}</h1><p className="mt-3 text-muted-foreground">{translateInterface("m17d30d61d1fe")}</p></div>
          <Button onClick={() => go("icon")} disabled={navigationPending}>{translateInterface("m31fbef162594")}<ArrowRight className="h-4 w-4" /></Button>
        </div>}
        {step === "icon" && <div className="space-y-5">
          <div><h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold">{translateInterface("m0fa1be2c2372")}</h1><p className="mt-2 text-sm text-muted-foreground">{translateInterface("m2b30dc5a7e6a")}</p></div>
          <ProfileIconPicker selectedId={selectedIcon} onChoose={(id) => void savePreset(id)} busy={busy || navigationPending} />
          <input ref={uploadRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadPhoto(file); event.target.value = ""; }} />
          <Button variant="outline" onClick={() => uploadRef.current?.click()} disabled={busy || navigationPending}><ImagePlus className="h-4 w-4" />{translateInterface("m32258ba63e80")}</Button>
          <div className="flex justify-between gap-3 pt-4"><Button variant="ghost" onClick={() => go("welcome")} disabled={busy || navigationPending}><ArrowLeft className="h-4 w-4" />{translateInterface("m76900f1bfd16")}</Button><Button onClick={() => go("timeline")} disabled={busy || navigationPending}>{translateInterface("m31fbef162594")}<ArrowRight className="h-4 w-4" /></Button></div>
        </div>}
        {step === "timeline" && <div className="space-y-5">
          <div><span className="onboarding-kicker">{translateInterface("m9fcb8c2dc544")}</span><h1 ref={heading} tabIndex={-1} className="onboarding-title">{translateInterface("m71d08801313d")}</h1><p className="mt-3 text-sm text-muted-foreground">{translateInterface("m759072fc5d13")}</p></div>
          {!snapshot.has_pin && <div className="space-y-3">
            <p className="text-sm">{translateInterface("m2313b408ef23")}{translateInterface("mbf545b6cf399")}</p>
            <label className="block space-y-1 text-sm">{translateInterface("m8a8145177dc7")}<Input type={showSecret ? "text" : "password"} autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value)} /></label>
            <label className="block space-y-1 text-sm">{translateInterface("mdc82c94d38e3")}<Input type={showSecret ? "text" : "password"} autoComplete="new-password" value={repeatPin} onChange={(e) => setRepeatPin(e.target.value)} /></label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showSecret} onChange={(e) => setShowSecret(e.target.checked)} />{translateInterface("m5c7aaa27795a")}</label>
          </div>}
          {snapshot.has_pin && <p className="text-sm text-muted-foreground">{translateInterface("mdb1931586dc6")}</p>}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-4"><Button variant="ghost" onClick={() => go("icon")} disabled={navigationPending}><ArrowLeft className="h-4 w-4" />{translateInterface("m76900f1bfd16")}</Button><div className="flex flex-wrap gap-3"><Button variant="outline" onClick={() => review(false)} disabled={navigationPending}>{translateInterface("m9b83b7e4c548")}</Button><Button onClick={() => review(true)} disabled={navigationPending}>{translateInterface("m1ff57a29d7c9")}<ArrowRight className="h-4 w-4" /></Button></div></div>
        </div>}
        {step === "review" && <div className="space-y-5">
          <div className="flex items-center justify-center gap-3"><Brand design={branding.site_name_style?.mytitle} view="icon" /><Brand design={branding.site_name_style?.mytitle} name={siteName} /></div>
          <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold">{translateInterface("m297d779c3f82")}</h1>
          <p>{translateInterface("m8f3ae4df112b", { state: choice ? translateInterface("m130011756125") : translateInterface("mca7981b46ecf") })}</p>
          <p className="text-sm text-muted-foreground">{choice ? translateInterface("m6b7d7fc0ce25") : translateInterface("m440edb6adeb2")}</p>
          <div className="flex justify-between gap-3"><Button variant="ghost" onClick={() => go("timeline")} disabled={busy || navigationPending}><ArrowLeft className="h-4 w-4" />{translateInterface("m76900f1bfd16")}</Button><Button onClick={() => void finish()} disabled={busy || navigationPending}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{busy ? translateInterface("m23e39291d613") : translateInterface("mbc01ae77f37c")}</Button></div>
        </div>}
        {step === "done" && <div className="space-y-5 text-center"><div className="flex items-center justify-center gap-3"><Brand design={branding.site_name_style?.mytitle} view="icon" /><Brand design={branding.site_name_style?.mytitle} name={siteName} /></div><h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold">{translateInterface("m987bf1a0149b")}</h1><p>{translateInterface("m0807e986007d")}</p><Button onClick={() => window.location.replace("/")}>{translateInterface("m1cc6459d42c3", { siteName })} <ArrowRight className="h-4 w-4" /></Button></div>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </>}
    </section>
  </main>;
}
