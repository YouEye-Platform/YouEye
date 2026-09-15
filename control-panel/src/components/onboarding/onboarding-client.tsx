"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, ImagePlus, Loader2, ShieldCheck, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProfileIconPicker } from "@/components/settings-shell/profile-icon-picker";

type Step = "welcome" | "icon" | "pin" | "done";

export function OnboardingClient({ username }: { username: string }) {
  const router = useRouter();
  const uploadRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("welcome");
  const [siteName, setSiteName] = useState("YouEye");
  const [selectedIcon, setSelectedIcon] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [repeatPin, setRepeatPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      fetch("/api/setup/config").then((res) => res.ok ? res.json() : null),
      fetch("/api/ui-settings/onboarding").then((res) => res.ok ? res.json() : null),
    ]).then(([config, onboarding]) => {
      if (onboarding?.completed) {
        router.replace("/");
        return;
      }
      if (typeof config?.site_name === "string" && config.site_name.trim()) setSiteName(config.site_name.trim());
    }).catch(() => {});
  }, [router]);

  async function savePreset(presetId: string) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/user/avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presetId }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not save the icon");
      setSelectedIcon(presetId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the icon");
    } finally {
      setBusy(false);
    }
  }

  async function uploadPhoto(file: File) {
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/user/avatar", { method: "POST", body });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not upload the photo");
      setSelectedIcon(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not upload the photo");
    } finally {
      setBusy(false);
    }
  }

  async function finish(skipPin = false) {
    setError("");
    if (!skipPin) {
      if (!/^\d{4}$/.test(pin)) return setError("Use a four-digit PIN.");
      if (pin !== repeatPin) return setError("The PINs do not match.");
    }
    setBusy(true);
    try {
      if (!skipPin) {
        const pinRes = await fetch("/api/ui-settings/pin/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin }),
        });
        if (!pinRes.ok) throw new Error((await pinRes.json().catch(() => ({}))).error || "Could not create the PIN");
      }
      const completeRes = await fetch("/api/ui-settings/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!completeRes.ok) throw new Error("Could not complete onboarding");
      setStep("done");
      window.setTimeout(() => router.replace("/"), 800);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not complete onboarding");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-12">
      <section className="w-full max-w-2xl rounded-2xl border bg-card p-6 shadow-sm sm:p-9">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-primary">{siteName}</p>
            <p className="text-xs text-muted-foreground">Welcome, {username}</p>
          </div>
          <div className="flex gap-1" aria-label="Onboarding progress">
            {(["welcome", "icon", "pin", "done"] as Step[]).map((item) => (
              <span key={item} className={`h-1.5 w-8 rounded-full ${item === step ? "bg-primary" : "bg-muted"}`} />
            ))}
          </div>
        </div>

        {step === "welcome" && (
          <div className="space-y-7 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10"><ShieldCheck className="h-8 w-8 text-primary" /></div>
            <div><h1 className="text-3xl font-semibold tracking-tight">Your space is ready</h1><p className="mt-2 text-muted-foreground">Choose how you appear, then protect private timeline data with an optional PIN.</p></div>
            <Button onClick={() => setStep("icon")}>Continue <ArrowRight className="h-4 w-4" /></Button>
          </div>
        )}

        {step === "icon" && (
          <div className="space-y-5">
            <div><h1 className="text-2xl font-semibold">Choose your profile icon</h1><p className="mt-1 text-sm text-muted-foreground">Pick a preset or upload your own photo. You can change it later in Settings.</p></div>
            <ProfileIconPicker selectedId={selectedIcon} onChoose={(presetId) => void savePreset(presetId)} busy={busy} />
            <input ref={uploadRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadPhoto(file); event.target.value = ""; }} />
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="flex flex-wrap justify-between gap-3 border-t pt-5">
              <Button variant="outline" onClick={() => uploadRef.current?.click()} disabled={busy}><ImagePlus className="h-4 w-4" />Upload photo</Button>
              <Button onClick={() => setStep("pin")} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Continue <ArrowRight className="h-4 w-4" /></Button>
            </div>
          </div>
        )}

        {step === "pin" && (
          <div className="space-y-5">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10"><UserRound className="h-6 w-6 text-primary" /></div>
            <div><h1 className="text-2xl font-semibold">Protect private data</h1><p className="mt-1 text-sm text-muted-foreground">A four-digit PIN unlocks encrypted timeline data on this device. This is separate from your sign-in password.</p></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm font-medium">PIN<Input inputMode="numeric" autoComplete="new-password" maxLength={4} type="password" value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))} /></label>
              <label className="space-y-1.5 text-sm font-medium">Repeat PIN<Input inputMode="numeric" autoComplete="new-password" maxLength={4} type="password" value={repeatPin} onChange={(event) => setRepeatPin(event.target.value.replace(/\D/g, ""))} /></label>
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="flex flex-wrap justify-between gap-3 border-t pt-5"><Button variant="ghost" onClick={() => void finish(true)} disabled={busy}>Skip for now</Button><Button onClick={() => void finish()} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}Create PIN</Button></div>
          </div>
        )}

        {step === "done" && <div className="space-y-5 py-10 text-center"><div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10"><Check className="h-8 w-8 text-primary" /></div><h1 className="text-2xl font-semibold">You’re all set</h1><p className="text-muted-foreground">Opening your dashboard…</p></div>}
      </section>
    </main>
  );
}
