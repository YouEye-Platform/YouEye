"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, LockKeyhole, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { SpineDevelopmentAccessStatus } from "@/lib/spine/client";

function StatusValue({ label, active }: { label: string; active: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
      <span className={`size-2 rounded-full ${active ? "bg-amber-500" : "bg-green-500"}`} />
      {active ? label : "Off"}
    </span>
  );
}

function StateLine({ label, active, detail }: { label: string; active: boolean; detail: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      <StatusValue label="Active" active={active} />
    </div>
  );
}

export function DevelopmentAccessCard() {
  const [status, setStatus] = useState<SpineDevelopmentAccessStatus | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [disabling, setDisabling] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const response = await fetch("/settings/api/appliance/development-access", { cache: "no-store" });
    if (response.ok) setStatus(await response.json());
    else setError((await response.json().catch(() => ({}))).error || "Development access status is unavailable.");
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function disable() {
    setDisabling(true);
    setError("");
    const csrfToken = await fetch("/settings/api/auth/csrf").then((response) => response.json()).then((body) => body.csrfToken as string);
    const response = await fetch("/settings/api/appliance/development-access", {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    });
    if (response.ok) {
      setStatus(await response.json());
      setConfirming(false);
    } else {
      setError((await response.json().catch(() => ({}))).error || "Development access could not be disabled.");
    }
    setDisabling(false);
  }

  const localConsoleUnreconciled = Boolean(status && (
    (status.local_root_console_requested && !status.local_root_console_effective)
    || (!status.local_root_console_requested && status.local_root_console_active)
  ));
  const hasDevelopmentAccess = Boolean(status && (
    status.local_root_console_requested
    || status.local_root_console_persisted
    || status.local_root_console_active
    || status.local_root_console_effective
    || status.root_password_ssh_requested
    || status.root_password_ssh_effective
  ));

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start justify-between gap-4 border-b p-4">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold"><KeyRound className="size-4" />Development access</h2>
          <p className="mt-1 text-sm text-muted-foreground">Local root access for maintenance and development.</p>
        </div>
        {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>
      <div className="divide-y px-4">
        <div className="py-2">
          <div>
            <p className="text-sm font-medium">Local root console (TTY2)</p>
            <p className="text-xs text-muted-foreground">Sign in locally on the device&apos;s second console.</p>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div className="flex items-center justify-between gap-4 rounded-md bg-muted/40 px-3 py-2">
              <span className="text-xs text-muted-foreground">Requested</span>
              <StatusValue label="Requested" active={Boolean(status?.local_root_console_requested)} />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md bg-muted/40 px-3 py-2">
              <span className="text-xs text-muted-foreground">Active now</span>
              <StatusValue label="Active" active={Boolean(status?.local_root_console_active)} />
            </div>
          </div>
          {status?.local_root_console_persisted && <p className="mt-2 text-xs text-muted-foreground">The local-console policy is persisted.</p>}
          {localConsoleUnreconciled && (
            <p className="mt-2 flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {status?.local_root_console_requested
                ? "Requested local console access is not effective yet; its runtime state has not reconciled."
                : "Local console access remains active while its policy is off; its runtime state has not reconciled."}
            </p>
          )}
        </div>
        <StateLine
          label="Root password SSH"
          active={Boolean(status?.root_password_ssh_effective)}
          detail={status?.root_password_ssh_requested && !status.root_password_ssh_effective
            ? "Requested, but no safe local network scope is available."
            : status?.network_scope ? `Limited to ${status.network_scope}.` : "Password sign-in is disabled."}
        />
      </div>
      <div className="space-y-3 border-t p-4">
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <LockKeyhole className="mt-0.5 size-3.5 shrink-0" />
          Enable access or change the password locally on the device. Administrators can disable it here without exposing password data.
        </p>
        {status?.detail && <p className="text-xs text-muted-foreground">{status.detail}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {hasDevelopmentAccess && !confirming && <Button size="sm" onClick={() => setConfirming(true)}>Disable development access</Button>}
        {confirming && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3">
            <p className="text-sm">This locks the root password and disables both password access paths.</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirming(false)} disabled={disabling}>Cancel</Button>
              <Button size="sm" onClick={disable} disabled={disabling}>
                {disabling && <Loader2 className="size-4 animate-spin" />}Disable access
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
