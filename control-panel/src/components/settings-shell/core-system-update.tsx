"use client";





import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ReleaseChannelSetting } from "./release-channel";
import type { CoreUpdateAction, CoreUpdateCandidate, CoreUpdateRequest, CoreUpdateStatus } from "@/lib/spine/client";

type Pending = { action: CoreUpdateAction; request: CoreUpdateRequest };
const retainedAction = "youeye.core-update.pending";






export function CoreSystemUpdate({ initial }: { initial: CoreUpdateStatus }) {
  const translateInterface = useInterfaceTranslations("interface");
const phaseLabels: Record<string, string> = {
  prepared: translateInterface("me2562d8c9913"), applying: translateInterface("m9ec16b3ede4f"), "awaiting-restart": translateInterface("m6a6c90ba7ebe"),
  "needs-recovery": translateInterface("mc1ebc7817870"), recovering: translateInterface("mad2ddfb8e585"), cancelling: translateInterface("m63ce917c7015"), cancelled: translateInterface("m92e1f6f46f0d"),
  committed: translateInterface("mac2821082f9f"), "rolled-back": translateInterface("m1fb88a547a76"),
};

const stepLabels: Record<string, string> = {
  "verify-members": translateInterface("me1c766e34d0b"), "stage-host": translateInterface("mcd2a8c7bc9cc"),
  checkpoint: translateInterface("m11ce7e3352db"), "activate-host": translateInterface("m0cfbfb691a4c"), "host-health": translateInterface("m3c8240e64aff"),
  "apply-cp": translateInterface("m44fffeb50e16"), "apply-ui": translateInterface("m97bbf4f3d821"),
  "authenticated-health": translateInterface("m08532b63b8a0"), "commit-host": translateInterface("md0de48c5bf79"),
  "recovery-fence": translateInterface("m61fb44db5058"), "recovery-paired-restore": translateInterface("mf336e24d9f03"),
  "recovery-host": translateInterface("m523563cf5392"), "recovery-health": translateInterface("m2d7a68d53935"),
};

const recoveryMessages: Record<string, string> = {
  recovery_services_unavailable: translateInterface("m2a26c7e577b4"),
  recovery_power_unavailable: translateInterface("m5a553d70587a"),
  recovery_health_unavailable: translateInterface("m55d954e377fc"),
};

async function headers() {
  const response = await fetch("/settings/api/auth/csrf", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.csrfToken !== "string") throw new Error(translateInterface("m40bc9725985b"));
  return { "Content-Type": "application/json", "X-CSRF-Token": body.csrfToken };
}


  const [status, setStatus] = useState(initial);
  const [candidate, setCandidate] = useState<CoreUpdateCandidate | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState("");
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/settings/api/appliance/core-update/status", { cache: "no-store" });
      const value = await response.json();
      if (!response.ok || value.managed !== true) throw new Error(translateInterface("mbc9155ae5dc1"));
      setStatus(value); setConnection("");
    } catch { setConnection(translateInterface("me33c362b5356")); }
  }, [translateInterface]);
  useEffect(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(retainedAction) ?? "null") as Pending | null;
      if (value && ["stage", "activate", "resume", "recover", "cancel"].includes(value.action)
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.request?.request_id ?? "")
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.request?.command_id ?? "")
        && /^[a-f0-9]{64}$/.test(value.request?.manifest_sha256 ?? "")) setPending(value);
    } catch { /* Unreadable browser state grants no action. */ }
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function check() {
    setBusy("check"); setError(""); setNotice("");
    try {
      const response = await fetch("/settings/api/appliance/core-update/check", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) { setError(body.code === "rate_limited" ? translateInterface("m4d6bfb83f08f") : translateInterface("m5f82ba024447")); return; }
      setCandidate(body);
    } catch (cause) { setError(translateInterface("m5f82ba024447")); }
    finally { setBusy(null); }
  }
  async function submit(action: CoreUpdateAction, retained?: Pending) {
    const transaction = status.transaction;
    const request: CoreUpdateRequest = retained?.request ?? {
      request_id: action === "stage" ? `update-${crypto.randomUUID()}` : transaction?.request_id ?? "",
      manifest_sha256: action === "stage" ? candidate?.manifest_sha256 ?? "" : transaction?.manifest_sha256 ?? "",
      command_id: crypto.randomUUID(),
    };
    if (!request.request_id || !request.manifest_sha256) return;
    const delivery = { action, request };
    setBusy(action); setError(""); setNotice(""); setPending(delivery);
    try {
      sessionStorage.setItem(retainedAction, JSON.stringify(delivery));
      const response = await fetch(`/settings/api/appliance/core-update/${action}`, { method: "POST", headers: await headers(), body: JSON.stringify(request) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? translateInterface("m095dc2213e36"));
      sessionStorage.removeItem(retainedAction); setPending(null);
      setNotice(body.control?.state === "unknown" ? translateInterface("m22506e6629e8") : translateInterface("m826e8c195fad"));
      await refresh();
    } catch (cause) { setError(translateInterface("m952e104d6521")); }
    finally { setBusy(null); }
  }
  const transaction = status.transaction;
  const unfinished = transaction && !transaction.complete;
  const canCancel = unfinished && !transaction.activation_requested && transaction.steps.every(step => step.state === "pending" || ["verify-members", "stage-host"].includes(step.name));
  const currentStep = transaction?.steps.find(step => step.state !== "succeeded");
  const waitingForApps = currentStep?.stage === "admission" && currentStep.action_state === "running";
  const canRetryAdmission = currentStep?.action_state === "retryable" && currentStep.stage === "admission" && currentStep.effect_state === "not-started";
  const admissionBlocked = canRetryAdmission && currentStep?.code === "admission_rejected";
  const recovering = currentStep?.name.startsWith("recovery-");
  const recoveryMessage = recovering && currentStep?.code ? recoveryMessages[currentStep.code] : undefined;
  const state = transaction?.complete
    ? transaction.phase === "rolled-back" ? translateInterface("m84ef651255fb") : transaction.phase === "cancelled" ? translateInterface("m92e1f6f46f0d") : translateInterface("m2ca13025d60c")
    : transaction ? phaseLabels[transaction.phase] ?? translateInterface("m01ea9b2b1311") : translateInterface("m06f9580f5c7b");
  // The box never downgrades: a channel behind the installed version offers nothing.
  const available = candidate && !candidate.behind && candidate.manifest_sha256 !== status.installed?.manifest_sha256;
  return <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-sm font-medium">{translateInterface("m2a1ec4ff37ff")}</h3>
        <p className="mt-1 text-sm">{status.installed?.release.version ?? translateInterface("mc0a7f647c17d")}{status.installed?.release.build && status.installed.release.build !== status.installed.release.version ? <span className="ml-2 text-xs text-muted-foreground">{status.installed.release.build}</span> : null}</p>
        <p className="mt-1 text-sm text-muted-foreground" role="status">{waitingForApps ? translateInterface("m331f54039409") : canRetryAdmission ? translateInterface("me8d51f7276c8") : state}{unfinished && currentStep && !waitingForApps && !canRetryAdmission ? ` · ${stepLabels[currentStep.name] ?? translateInterface("m89f42c216c85")}` : ""}</p>
      </div>
      <Button variant="outline" disabled={!!busy || !!unfinished} onClick={() => void check()}>
        {busy === "check" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {" "}{translateInterface("mf26f3275e735")}</Button>
    </div>
    {connection && <Alert><AlertDescription>{connection}</AlertDescription></Alert>}
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {notice && <p className="text-sm text-muted-foreground" role="status">{notice}</p>}
    {pending && <div className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-muted-foreground">{translateInterface("mde1fe9f85733")}</p>
      <Button variant="outline" disabled={!!busy} onClick={() => void submit(pending.action, pending)}>{translateInterface("m16003a1a9190")}</Button>
    </div>}
    {available && !unfinished && <div className="space-y-3">
      <p className="text-sm">{translateInterface("mdacfb2679d3b", {version: candidate.release.version})} {candidate.restart_required ? translateInterface("mddd9af48f331") : translateInterface("m435af341384a")}</p>
      <Button disabled={!!busy || !!pending} onClick={() => void submit("stage")}>{candidate.restart_required ? translateInterface("mb1025ed60c51", { value0: String(candidate.release.version) }) : translateInterface("mfa4031f94844", { value0: String(candidate.release.version) })}</Button>
    </div>}
    {candidate && !available && !unfinished && <p className="text-sm text-muted-foreground">{candidate.behind && candidate.message ? candidate.message : translateInterface("m1ae973cac2cc")}</p>}
    {unfinished && <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{translateInterface("m9da15bdd0599", {version: transaction.target_version})}</p>
      {waitingForApps && <p className="text-sm text-muted-foreground">{translateInterface("m7460797e6c6d")}</p>}
      {canRetryAdmission && <p className="text-sm text-muted-foreground">{admissionBlocked ? translateInterface("m2708962963e3") : translateInterface("mfa12e6c66819")}</p>}
      {transaction.error && <p className="text-sm text-destructive">{transaction.error}</p>}
      {recoveryMessage && <p className="text-sm text-muted-foreground">{recoveryMessage}</p>}
      <div className="flex flex-wrap gap-2">
        {transaction.phase === "awaiting-restart" && <Button disabled={!!busy || !!pending} onClick={() => void submit("activate")}>{translateInterface("m159713231bf6")}{transaction.target_version}</Button>}
        {canCancel && <Button variant="outline" disabled={!!busy || !!pending} onClick={() => void submit("cancel")}>{translateInterface("me5013ddb039e")}</Button>}
        {transaction.phase !== "cancelling" && <Button variant="outline" disabled={!!busy || !!pending || waitingForApps} onClick={() => void submit("resume")}>{canRetryAdmission ? recovering ? translateInterface("mf37b055f32a8") : translateInterface("md29ed82b9eeb") : translateInterface("m5aff816e24b2")}</Button>}
        {transaction.phase === "needs-recovery" && !canCancel && <Button variant="outline" disabled={!!busy || !!pending} onClick={() => void submit("recover")}>{translateInterface("mcbc4381b5be7")}</Button>}
      </div>
      {transaction.phase === "awaiting-restart" && <p className="text-sm text-muted-foreground">{translateInterface("m4d6705344b6d")}</p>}
      {transaction.phase === "needs-recovery" && !canCancel && <p className="text-sm text-muted-foreground">{translateInterface("m03c18bc65c6d")}</p>}
    </div>}
    {!unfinished && <ReleaseChannelSetting />}
  </section>;
}
