"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ApplianceSystemUpdateSelection, ApplianceSystemUpdateStatus } from "@/lib/spine/client";

type Channel = ApplianceSystemUpdateSelection["channel"];
type Provider = ApplianceSystemUpdateSelection["provider"];

const ACTIVE_STATES = new Set(["downloading", "writing", "pending-reboot", "trial"]);
const PROVIDERS: Array<{ value: Provider; label: string }> = [
  { value: "github", label: "Official GitHub" },
  { value: "forgejo", label: "Forgejo" },
  { value: "custom", label: "Custom HTTPS" },
];

function safeReleaseBranch(value: string) {
  return value.length > 0 && value.length <= 96 && value.split('/').every((part) =>
    part !== '.' && part !== '..' && !part.startsWith('.') && !part.endsWith('.') &&
    !part.endsWith('.lock') && /^[a-z0-9._-]+$/.test(part));
}

function safeApplianceReleaseTag(value: string) {
  if (value.length === 0 || value.length > 180 || !value.startsWith("appliance-") || /[\\%\0]/.test(value)) return false;
  if (/^appliance-v\d+(?:\.\d+)+$/.test(value) || /^appliance-dev-v\d+(?:\.\d+)+$/.test(value)) return true;
  const marker = value.lastIndexOf("-v");
  return marker > "appliance-".length && /^\d+(?:\.\d+)+$/.test(value.slice(marker + 2)) &&
    safeReleaseBranch(value.slice("appliance-".length, marker));
}

function stateLabel(state: ApplianceSystemUpdateStatus["state"]) {
  return ({
    healthy: "Up to date",
    available: "Update available",
    downloading: "Downloading",
    writing: "Preparing inactive system",
    staged: "Ready to restart",
    "pending-reboot": "Restart pending",
    trial: "Checking updated system",
    failed: "Needs attention",
    "rolled-back": "Restored previous system",
  } as const)[state];
}

function statusDot(state: ApplianceSystemUpdateStatus["state"]) {
  if (state === "failed") return "bg-destructive";
  if (state === "rolled-back") return "bg-amber-500";
  if (state === "available" || state === "staged") return "bg-primary";
  if (ACTIVE_STATES.has(state)) return "bg-amber-500";
  return "bg-emerald-500";
}

function checkedLabel(value?: string) {
  if (!value) return "Not checked yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Checked recently" : `Checked ${date.toLocaleString()}`;
}

async function protectedHeaders() {
  const response = await fetch("/settings/api/auth/csrf", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.csrfToken !== "string") throw new Error("Could not start a protected update action.");
  return { "Content-Type": "application/json", "X-CSRF-Token": body.csrfToken as string };
}

export function ApplianceSystemUpdate() {
  const [status, setStatus] = useState<ApplianceSystemUpdateStatus | null>(null);
  const [provider, setProvider] = useState<Provider>("github");
  const [releasesAPI, setReleasesAPI] = useState("");
  const [channel, setChannel] = useState<Channel>("stable");
  const [branch, setBranch] = useState("");
  const [exactTag, setExactTag] = useState("");
  const [manifestSHA256, setManifestSHA256] = useState("");
  const rememberedAPIs = useRef<Partial<Record<Provider, string>>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"check" | "stage" | "activate" | null>(null);
  const [error, setError] = useState("");
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/settings/api/appliance/system-update/status", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || body.message || "System update status is unavailable.");
      setStatus(body as ApplianceSystemUpdateStatus);
    } catch (loadError) {
      if (!quiet) setError(loadError instanceof Error ? loadError.message : "System update status is unavailable.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const loadSource = useCallback(async () => {
    const response = await fetch("/settings/api/appliance/system-update/source", { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "System update source is unavailable.");
    const source = body as ApplianceSystemUpdateSelection;
    setProvider(source.provider);
    setReleasesAPI(source.releases_api || "");
    rememberedAPIs.current[source.provider] = source.releases_api || "";
    setChannel(source.channel);
    setBranch(source.branch || "");
    setExactTag(source.exact_tag || "");
    setManifestSHA256(source.manifest_sha256 || "");
  }, []);

  useEffect(() => {
    void Promise.all([loadStatus(), loadSource()]).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : "System update settings are unavailable.");
      setLoading(false);
    });
  }, [loadSource, loadStatus]);
  useEffect(() => {
    if (!busy && !status?.state) return;
    const interval = window.setInterval(
      () => void loadStatus(true),
      ACTIVE_STATES.has(status?.state ?? "") || busy ? 2000 : 10000,
    );
    return () => window.clearInterval(interval);
  }, [busy, loadStatus, status?.state]);

  const selection = useMemo<ApplianceSystemUpdateSelection>(() => ({
    provider,
    ...(provider === "github" ? {} : { releases_api: releasesAPI.trim() }),
    channel,
    ...(channel === "branch" ? { branch: branch.trim() } : {}),
    ...(channel === "exact" ? { exact_tag: exactTag.trim(), manifest_sha256: manifestSHA256.trim().toLowerCase() } : {}),
    ...(confirmReplace ? { replace_failed: true } : {}),
  }), [branch, channel, confirmReplace, exactTag, manifestSHA256, provider, releasesAPI]);

  const exactValid = channel !== "exact"
    || (safeApplianceReleaseTag(exactTag.trim()) && /^[0-9a-f]{64}$/.test(manifestSHA256.trim()));
  const branchValid = channel !== "branch" || safeReleaseBranch(branch.trim());
  const sourceValid = provider === "github" || /^https:\/\/[^\s]+$/.test(releasesAPI.trim());

  async function action(next: "check" | "stage" | "activate") {
    setBusy(next);
    setError("");
    try {
      const headers = await protectedHeaders();
      const body = next === "activate" ? { reboot: true } : selection;
      const response = await fetch(`/settings/api/appliance/system-update/${next}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || result.message || `System update ${next} failed.`);
      setStatus(result as ApplianceSystemUpdateStatus);
      setConfirmRestart(false);
      setConfirmReplace(false);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `System update ${next} failed.`);
    } finally {
      setBusy(null);
      await loadStatus(true);
    }
  }

  function chooseProvider(next: Provider) {
    if (provider !== "github") rememberedAPIs.current[provider] = releasesAPI;
    setProvider(next);
    setReleasesAPI(next === "github" ? "" : rememberedAPIs.current[next] || "");
  }

  const downloaded = Object.values(status?.downloaded_bytes ?? {}).reduce((sum, bytes) => sum + bytes, 0);
  const mutableSelection = !status || ["healthy", "failed", "rolled-back"].includes(status.state);
  const canSubmit = busy === null && exactValid && branchValid && sourceValid;

  return (
    <section className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-primary">
            <ShieldCheck className="size-4" />
          </div>
          <div>
            <h2 className="text-[15px] font-semibold">System update</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              {status && <span aria-hidden className={`size-2 rounded-full ${statusDot(status.state)}`} />}
              <span>{status ? stateLabel(status.state) : loading ? "Checking status" : "Status unavailable"}</span>
              <span className="text-muted-foreground">· {checkedLabel(status?.updated_at)}</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Host system {status?.running_image || "version unavailable"}{status?.active_slot ? ` · System ${status.active_slot}` : ""}.
              Stable and Development metadata checks run automatically every six hours; downloads and restarts always wait for you.
            </p>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={() => void loadStatus()} disabled={loading} title="Refresh system update status">
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          <span className="sr-only">Refresh system update status</span>
        </Button>
      </div>

      {status?.target_image && (
        <div className="mt-4 rounded-lg bg-muted/50 p-3 text-sm">
          <div className="font-medium">Host system {status.target_image}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {status.state === "available" ? "Ready to download" : stateLabel(status.state)}
          </div>
          {status.state === "available" && (
            <p className="mt-2 text-sm text-muted-foreground">
              Updates the YouEye host OS and bundled Incus runtime. Applications and personal data stay in YE-DATA; a restart is required after preparation.
            </p>
          )}
          {status.release_notes && <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{status.release_notes}</p>}
        </div>
      )}

      {(status?.state === "downloading" || status?.state === "writing") && (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {stateLabel(status.state)}{downloaded > 0 ? ` · ${(downloaded / 1024 / 1024).toFixed(0)} MiB verified` : ""}
        </div>
      )}
      {status?.error && <Alert variant="destructive" className="mt-4"><AlertDescription>{status.error}</AlertDescription></Alert>}
      {error && <Alert variant="destructive" className="mt-4"><AlertDescription>{error}</AlertDescription></Alert>}

      <div className="mt-4 flex flex-wrap gap-2">
        {(!status || ["healthy", "rolled-back"].includes(status.state)) && (
          <Button onClick={() => void action("check")} disabled={!canSubmit}>
            {busy === "check" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Check now
          </Button>
        )}
        {status?.state === "failed" && (
          <Button onClick={() => setConfirmReplace(true)} disabled={!canSubmit}>
            <RotateCcw className="size-4" />Choose another release
          </Button>
        )}
        {status?.state === "available" && (
          <Button onClick={() => void action("stage")} disabled={busy !== null}>
            {busy === "stage" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            Download and prepare
          </Button>
        )}
        {status?.state === "staged" && (
          <Button onClick={() => setConfirmRestart(true)} disabled={busy !== null}>Restart and update</Button>
        )}
      </div>

      <details className="mt-4 border-t pt-4">
        <summary className="cursor-pointer text-sm font-medium">Advanced release settings</summary>
        <div className="mt-4 space-y-4">
          <div>
            <Label>Release source</Label>
            <div className="mt-2 inline-flex max-w-full flex-wrap rounded-md border p-1">
              {PROVIDERS.map((item) => (
                <Button
                  key={item.value}
                  type="button"
                  size="sm"
                  variant={provider === item.value ? "secondary" : "ghost"}
                  onClick={() => chooseProvider(item.value)}
                  disabled={!mutableSelection || busy !== null}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </div>
          {provider !== "github" && (
            <div className="space-y-1.5">
              <Label htmlFor="appliance-releases-api">Releases API</Label>
              <Input
                id="appliance-releases-api"
                value={releasesAPI}
                onChange={(event) => setReleasesAPI(event.target.value)}
                disabled={!mutableSelection || busy !== null}
              />
              <p className="text-xs text-muted-foreground">Enter the complete HTTPS API URL. Alternative sources are intentionally blank by default.</p>
            </div>
          )}
          <div>
            <Label>Release channel</Label>
            <div className="mt-2 inline-flex max-w-full flex-wrap rounded-md border p-1">
              {(["stable", "development", "branch", "exact"] as Channel[]).map((item) => (
                <Button
                  key={item}
                  type="button"
                  size="sm"
                  variant={channel === item ? "secondary" : "ghost"}
                  onClick={() => setChannel(item)}
                  disabled={!mutableSelection || busy !== null}
                  className="capitalize"
                >
                  {item}
                </Button>
              ))}
            </div>
          </div>
          {channel === "branch" && (
            <div className="space-y-1.5">
              <Label htmlFor="appliance-release-branch">Signed release branch</Label>
              <Input
                id="appliance-release-branch"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="feature-branch"
                disabled={!mutableSelection || busy !== null}
              />
              <p className="text-xs text-muted-foreground">Tracks only signed appliance releases published for this branch. Raw branch source is never installed.</p>
            </div>
          )}
          {channel === "exact" && (
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="appliance-exact-tag">Release tag</Label>
                <Input id="appliance-exact-tag" value={exactTag} onChange={(event) => setExactTag(event.target.value)} placeholder="appliance-dev-v<version>" disabled={!mutableSelection || busy !== null} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="appliance-manifest-sha">Manifest SHA-256</Label>
                <Input id="appliance-manifest-sha" value={manifestSHA256} onChange={(event) => setManifestSHA256(event.target.value.toLowerCase())} className="font-mono" disabled={!mutableSelection || busy !== null} />
              </div>
            </div>
          )}
          <div className="rounded-lg border p-3 text-xs text-muted-foreground">
            <div>Signed release: {status?.release_tag || "None selected"}</div>
            <div>Manifest: {status?.manifest_sha256 || "Not verified"}</div>
            <div>A/B target: {status?.candidate_slot ? `System ${status.candidate_slot}` : "Chosen only after verification"}</div>
            {status?.required_cache_bytes !== undefined && status.available_cache_bytes !== undefined && (
              <div>{`${(status.required_cache_bytes / 1024 / 1024).toFixed(0)} MiB required · ${(status.available_cache_bytes / 1024 / 1024 / 1024).toFixed(1)} GiB available`}</div>
            )}
          </div>
        </div>
      </details>

      <ConfirmDialog
        open={confirmRestart}
        title="Restart into the prepared system?"
        description="YouEye starts the inactive System slot as a counted trial. It becomes the known-good system only after health checks pass; otherwise the previous slot returns automatically."
        confirmLabel={busy === "activate" ? "Restarting" : "Restart and update"}
        confirmDisabled={busy !== null}
        onConfirm={() => void action("activate")}
        onCancel={() => setConfirmRestart(false)}
      />
      <ConfirmDialog
        open={confirmReplace}
        title="Replace the failed update transaction?"
        description="The failed candidate and its cached transaction will be replaced by the currently selected signed release. The running System slot and your data remain unchanged."
        confirmLabel="Replace failed update"
        confirmDisabled={busy !== null}
        destructive
        onConfirm={() => void action("check")}
        onCancel={() => setConfirmReplace(false)}
      />
    </section>
  );
}
