"use client";
import {useLocale} from "next-intl";



import { useTranslations as useInterfaceTranslations } from "next-intl";


import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Loader2, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CoreSystemUpdate } from "./core-system-update";
import type { CoreUpdateStatus, ApplianceSystemUpdateSelection, ApplianceSystemUpdateStatus } from "@/lib/spine/client";

type Channel = ApplianceSystemUpdateSelection["channel"];
const OFFICIAL_REPOSITORY = "https://github.com/YouEye-Platform/YouEye";

const ACTIVE_STATES = new Set(["downloading", "writing", "pending-reboot", "trial"]);

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



function statusDot(state: ApplianceSystemUpdateStatus["state"]) {
  if (state === "failed") return "bg-destructive";
  if (state === "rolled-back") return "bg-amber-500";
  if (state === "available" || state === "staged") return "bg-primary";
  if (ACTIVE_STATES.has(state)) return "bg-amber-500";
  return "bg-emerald-500";
}





export function ApplianceSystemUpdate() {
  const translateInterface = useInterfaceTranslations("interface");

  const [core, setCore] = useState<CoreUpdateStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/settings/api/appliance/core-update/status", { cache: "no-store", signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok || typeof body.managed !== "boolean") throw new Error(translateInterface("mc87dd5a532c0"));
      setCore(body);
    }).catch(cause => { if (!controller.signal.aborted) setError(translateInterface("mc87dd5a532c0")); });
    return () => controller.abort();
  }, []);
  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!core) return <p className="text-sm text-muted-foreground" role="status">{translateInterface("mdd27c3d0bc9e")}</p>;
  return core.managed ? <CoreSystemUpdate initial={core} /> : <LegacyApplianceSystemUpdate />;
}

function LegacyApplianceSystemUpdate() {
  const translateInterface = useInterfaceTranslations("interface");
  const locale = useLocale();
function stateLabel(state: ApplianceSystemUpdateStatus["state"]) {
  return ({
    healthy: translateInterface("mce29b7f85b9e"),
    available: translateInterface("mff8b555d818f"),
    downloading: "Downloading",
    writing: translateInterface("m24c3f40fe80f"),
    staged: translateInterface("m6a6c90ba7ebe"),
    "pending-reboot": translateInterface("m762d05992a1f"),
    trial: translateInterface("m42d2b8289f1c"),
    failed: translateInterface("mc1ebc7817870"),
    "rolled-back": translateInterface("m0365f40f6e55"),
  } as const)[state];
}

function checkedLabel(value?: string) {
  if (!value) return translateInterface("m881d23f6ba57");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? translateInterface("mea00961df33e") : translateInterface("m06d1e85f2b24", {time: date.toLocaleString(locale)});
}

async function protectedHeaders() {
  const response = await fetch("/settings/api/auth/csrf", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.csrfToken !== "string") throw new Error(translateInterface("m40bc9725985b"));
  return { "Content-Type": "application/json", "X-CSRF-Token": body.csrfToken as string };
}


  const [status, setStatus] = useState<ApplianceSystemUpdateStatus | null>(null);
  const [repository, setRepository] = useState(OFFICIAL_REPOSITORY);
  const [channel, setChannel] = useState<Channel>("stable");
  const [branch, setBranch] = useState("");
  const [exactTag, setExactTag] = useState("");
  const [manifestSHA256, setManifestSHA256] = useState("");
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
      if (!response.ok) throw new Error(body.error || body.message || translateInterface("mc87dd5a532c0"));
      setStatus(body as ApplianceSystemUpdateStatus);
    } catch (loadError) {
      if (!quiet) setError(translateInterface("mc87dd5a532c0"));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [translateInterface]);

  const loadSource = useCallback(async () => {
    const response = await fetch("/settings/api/appliance/system-update/source", { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || translateInterface("mcc269cd9d8bc"));
    const source = body as ApplianceSystemUpdateSelection;
    setRepository(source.repository_url);
    setChannel(source.channel);
    setBranch(source.branch || "");
    setExactTag(source.exact_tag || "");
    setManifestSHA256(source.manifest_sha256 || "");
  }, [translateInterface]);

  useEffect(() => {
    void Promise.all([loadStatus(), loadSource()]).catch((loadError) => {
      setError(translateInterface("m9fae3c0c19a3"));
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
    repository_url: repository.trim(),
    channel,
    ...(channel === "branch" ? { branch: branch.trim() } : {}),
    ...(channel === "exact" ? { exact_tag: exactTag.trim(), manifest_sha256: manifestSHA256.trim().toLowerCase() } : {}),
    ...(confirmReplace ? { replace_failed: true } : {}),
  }), [branch, channel, confirmReplace, exactTag, manifestSHA256, repository]);

  const exactValid = channel !== "exact"
    || (safeApplianceReleaseTag(exactTag.trim()) && /^[0-9a-f]{64}$/.test(manifestSHA256.trim()));
  const branchValid = channel !== "branch" || safeReleaseBranch(branch.trim());
  const sourceValid = /^https:\/\/[^\s]+$/.test(repository.trim());

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
      if (!response.ok) throw new Error(result.error || result.message || translateInterface("mc87dee4cd9fc", {action: next}));
      setStatus(result as ApplianceSystemUpdateStatus);
      setConfirmRestart(false);
      setConfirmReplace(false);
    } catch (actionError) {
      setError(translateInterface("mdbb0741dcdf7", { value0: String(next) }));
    } finally {
      setBusy(null);
      await loadStatus(true);
    }
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
            <h2 className="text-[15px] font-semibold">{translateInterface("mdcfe3eedc4b9")}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              {status && <span aria-hidden className={`size-2 rounded-full ${statusDot(status.state)}`} />}
              <span>{status ? stateLabel(status.state) : loading ? translateInterface("ma4a534f1f446") : translateInterface("m7eb5af92e49c")}</span>
              <span className="text-muted-foreground">· {checkedLabel(status?.updated_at)}</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {translateInterface("mecb90df381c4")}{status?.running_image || translateInterface("ma191bf55dd89")}{status?.active_slot ? translateInterface("m9e8bb6b1709b", { value0: String(status.active_slot) }) : ""}.
              {translateInterface("m92ee5fb8a064")}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={() => void loadStatus()} disabled={loading} title={translateInterface("m4c63c9356029")}>
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          <span className="sr-only">{translateInterface("m4c63c9356029")}</span>
        </Button>
      </div>

      {status?.target_image && (
        <div className="mt-4 rounded-lg bg-muted/50 p-3 text-sm">
          <div className="font-medium">{translateInterface("mecb90df381c4")}{status.target_image}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {status.state === "available" ? translateInterface("m6cf0130193e2") : stateLabel(status.state)}
          </div>
          {status.state === "available" && (
            <p className="mt-2 text-sm text-muted-foreground">
              {translateInterface("md019b83e46a4")}</p>
          )}
          {status.release_notes && <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{status.release_notes}</p>}
        </div>
      )}

      {(status?.state === "downloading" || status?.state === "writing") && (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {stateLabel(status.state)}{downloaded > 0 ? translateInterface("m7562aacd6e0e", { value0: String((downloaded / 1024 / 1024).toLocaleString(locale, {maximumFractionDigits: 0})) }) : ""}
        </div>
      )}
      {status?.error && <Alert variant="destructive" className="mt-4"><AlertDescription>{status.error}</AlertDescription></Alert>}
      {error && <Alert variant="destructive" className="mt-4"><AlertDescription>{error}</AlertDescription></Alert>}

      <div className="mt-4 flex flex-wrap gap-2">
        {(!status || ["healthy", "rolled-back"].includes(status.state)) && (
          <Button onClick={() => void action("check")} disabled={!canSubmit}>
            {busy === "check" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {translateInterface("m2937cffb37ab")}</Button>
        )}
        {status?.state === "failed" && (
          <Button onClick={() => setConfirmReplace(true)} disabled={!canSubmit}>
            <RotateCcw className="size-4" />{translateInterface("m520726092489")}</Button>
        )}
        {status?.state === "available" && (
          <Button onClick={() => void action("stage")} disabled={busy !== null}>
            {busy === "stage" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            {translateInterface("m5ee8104662a5")}</Button>
        )}
        {status?.state === "staged" && (
          <Button onClick={() => setConfirmRestart(true)} disabled={busy !== null}>{translateInterface("m78b017c77e5b")}</Button>
        )}
      </div>

      <details className="mt-4 border-t pt-4">
        <summary className="cursor-pointer text-sm font-medium">{translateInterface("m7388b6779524")}</summary>
        <div className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="appliance-repository">{translateInterface("ma025a524505f")}</Label>
            <Input id="appliance-repository" value={repository}
              onChange={(event) => setRepository(event.target.value)} disabled={!mutableSelection || busy !== null} />
            <Button size="sm" variant="ghost" onClick={() => setRepository(OFFICIAL_REPOSITORY)} disabled={!mutableSelection || busy !== null}>{translateInterface("mc0d8bd59fac0")}</Button>
            <p className="text-xs text-muted-foreground">{translateInterface("m1e02e552d102")}</p>
          </div>
          <div>
            <Label>{translateInterface("md89ba8a2a6fc")}</Label>
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
              <Label htmlFor="appliance-release-branch">{translateInterface("m4aed53b0d8b3")}</Label>
              <Input
                id="appliance-release-branch"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="feature-branch"
                disabled={!mutableSelection || busy !== null}
              />
              <p className="text-xs text-muted-foreground">{translateInterface("maa28c3b63c56")}</p>
            </div>
          )}
          {channel === "exact" && (
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="appliance-exact-tag">{translateInterface("ma971c51d2964")}</Label>
                <Input id="appliance-exact-tag" value={exactTag} onChange={(event) => setExactTag(event.target.value)} placeholder="appliance-dev-v<version>" disabled={!mutableSelection || busy !== null} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="appliance-manifest-sha">{translateInterface("mc3f0d3168ff2")}</Label>
                <Input id="appliance-manifest-sha" value={manifestSHA256} onChange={(event) => setManifestSHA256(event.target.value.toLowerCase())} className="font-mono" disabled={!mutableSelection || busy !== null} />
              </div>
            </div>
          )}
          <div className="rounded-lg border p-3 text-xs text-muted-foreground">
            <div>{translateInterface("mefcbaf44cdd6")}{status?.release_tag || translateInterface("m557832355c85")}</div>
            <div>{translateInterface("m0afe6aade03c")}{status?.manifest_sha256 || translateInterface("m151339072593")}</div>
            <div>{translateInterface("m9ff4c1e3892b")}{status?.candidate_slot ? translateInterface("m3106e4926c69", { value0: String(status.candidate_slot) }) : translateInterface("mf2fb270eb601")}</div>
            {status?.required_cache_bytes !== undefined && status.available_cache_bytes !== undefined && (
              <div>{translateInterface("m4a338e1dfce0", { value0: String((status.required_cache_bytes / 1024 / 1024).toLocaleString(locale, {maximumFractionDigits: 0})), value1: String((status.available_cache_bytes / 1024 / 1024 / 1024).toLocaleString(locale, {minimumFractionDigits: 1, maximumFractionDigits: 1})) })}</div>
            )}
          </div>
        </div>
      </details>

      <ConfirmDialog
        open={confirmRestart}
        title={translateInterface("m19618a212608")}
        description={translateInterface("m75ffda7037dc")}
        confirmLabel={busy === "activate" ? translateInterface("m40f68cf75ff6") : translateInterface("m78b017c77e5b")}
        confirmDisabled={busy !== null}
        onConfirm={() => void action("activate")}
        onCancel={() => setConfirmRestart(false)}
      />
      <ConfirmDialog
        open={confirmReplace}
        title={translateInterface("m841575478567")}
        description={translateInterface("m8e32ed821ce4")}
        confirmLabel={translateInterface("m8e8e3ed86082")}
        confirmDisabled={busy !== null}
        destructive
        onConfirm={() => void action("check")}
        onCancel={() => setConfirmReplace(false)}
      />
    </section>
  );
}
