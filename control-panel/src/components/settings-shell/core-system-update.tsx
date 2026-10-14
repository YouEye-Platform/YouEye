"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { UpdateChannels } from "./update-channels";
import type { CoreUpdateAction, CoreUpdateCandidate, CoreUpdateRequest, CoreUpdateStatus } from "@/lib/spine/client";

type Pending = { action: CoreUpdateAction; request: CoreUpdateRequest };
const retainedAction = "youeye.core-update.pending";
const phaseLabels: Record<string, string> = {
  prepared: "Preparing update", applying: "Installing and checking", "awaiting-restart": "Ready to restart",
  "needs-recovery": "Needs attention", recovering: "Restoring previous release", cancelling: "Cancelling preparation", cancelled: "Preparation cancelled",
  committed: "Finishing update", "rolled-back": "Finishing recovery",
};
const stepLabels: Record<string, string> = {
  "verify-members": "Verifying the complete release", "stage-host": "Preparing the new system",
  checkpoint: "Saving the recovery point", "activate-host": "Restarting the system", "host-health": "Checking the system",
  "apply-cp": "Updating the server interface", "apply-ui": "Updating the YouEye interface",
  "authenticated-health": "Checking services and access", "commit-host": "Accepting the system",
  "recovery-fence": "Securing recovery", "recovery-paired-restore": "Restoring the recovery point",
  "recovery-host": "Starting the previous system", "recovery-health": "Checking the restored release",
};

async function headers() {
  const response = await fetch("/settings/api/auth/csrf", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.csrfToken !== "string") throw new Error("Could not start a protected update action.");
  return { "Content-Type": "application/json", "X-CSRF-Token": body.csrfToken };
}

export function CoreSystemUpdate({ initial }: { initial: CoreUpdateStatus }) {
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
      if (!response.ok || value.managed !== true) throw new Error("System status unavailable");
      setStatus(value); setConnection("");
    } catch { setConnection("Reconnecting to the system. Retained work continues; its result is not yet confirmed."); }
  }, []);
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
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Release discovery is unavailable.");
      setCandidate(body);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Release discovery is unavailable."); }
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
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "The action needs reconciliation.");
      sessionStorage.removeItem(retainedAction); setPending(null);
      setNotice(body.control?.state === "unknown" ? "Delivery is unconfirmed. Resume checks will reconcile the retained update." : "Request saved. Progress will update as the system verifies each step.");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The response was lost. Retry the same request to reconcile it."); }
    finally { setBusy(null); }
  }
  const transaction = status.transaction;
  const unfinished = transaction && !transaction.complete;
  const canCancel = unfinished && !transaction.activation_requested && transaction.steps.every(step => step.state === "pending" || ["verify-members", "stage-host"].includes(step.name));
  const currentStep = transaction?.steps.find(step => step.state !== "succeeded");
  const state = transaction?.complete
    ? transaction.phase === "rolled-back" ? "Previous release restored" : transaction.phase === "cancelled" ? "Preparation cancelled" : "Update complete"
    : transaction ? phaseLabels[transaction.phase] ?? "Checking retained update" : "Installed release";
  const available = candidate && candidate.manifest_sha256 !== status.installed?.manifest_sha256;
  return <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-sm font-medium">YouEye System</h3>
        <p className="mt-1 text-sm">{status.installed?.release.version ?? "Version unavailable"}</p>
        <p className="mt-1 text-sm text-muted-foreground" role="status">{state}{unfinished && currentStep ? ` · ${stepLabels[currentStep.name] ?? "Verifying update"}` : ""}</p>
      </div>
      <Button variant="outline" disabled={!!busy || !!unfinished} onClick={() => void check()}>
        {busy === "check" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Check for updates
      </Button>
    </div>
    {connection && <Alert><AlertDescription>{connection}</AlertDescription></Alert>}
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {notice && <p className="text-sm text-muted-foreground" role="status">{notice}</p>}
    {pending && <div className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-muted-foreground">A previous action has no confirmed response.</p>
      <Button variant="outline" disabled={!!busy} onClick={() => void submit(pending.action, pending)}>Retry same request</Button>
    </div>}
    {available && !unfinished && <div className="space-y-3">
      <p className="text-sm">YouEye {candidate.release.version} is available. {candidate.restart_required ? "Prepare it now, then choose when to restart." : "Installation will briefly pause YouEye services."}</p>
      <Button disabled={!!busy || !!pending} onClick={() => void submit("stage")}>{candidate.restart_required ? `Prepare ${candidate.release.version}` : `Install ${candidate.release.version}`}</Button>
    </div>}
    {candidate && !available && !unfinished && <p className="text-sm text-muted-foreground">The installed release matches the current selection.</p>}
    {unfinished && <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Target: YouEye {transaction.target_version}. You can close this page while the system works.</p>
      {transaction.error && <p className="text-sm text-destructive">{transaction.error}</p>}
      <div className="flex flex-wrap gap-2">
        {transaction.phase === "awaiting-restart" && <Button disabled={!!busy || !!pending} onClick={() => void submit("activate")}>Restart and install {transaction.target_version}</Button>}
        {canCancel && <Button variant="outline" disabled={!!busy || !!pending} onClick={() => void submit("cancel")}>Cancel preparation</Button>}
        {transaction.phase !== "cancelling" && <Button variant="outline" disabled={!!busy || !!pending} onClick={() => void submit("resume")}>Resume checks</Button>}
        {transaction.phase === "needs-recovery" && !canCancel && <Button variant="outline" disabled={!!busy || !!pending} onClick={() => void submit("recover")}>Restore previous release</Button>}
      </div>
      {transaction.phase === "awaiting-restart" && <p className="text-sm text-muted-foreground">Restarting pauses services and saves a recovery point first.</p>}
      {transaction.phase === "needs-recovery" && !canCancel && <p className="text-sm text-muted-foreground">Recovery restores the saved core data and services after verifying current access policy.</p>}
    </div>}
    {!unfinished && <details><summary className="cursor-pointer text-sm text-muted-foreground">Update channel</summary><div className="mt-3"><UpdateChannels componentId="system" appliance /></div></details>}
  </section>;
}
