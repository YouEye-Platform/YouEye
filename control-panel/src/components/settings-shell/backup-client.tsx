"use client";

import {useLocale} from "next-intl";





import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArchiveRestore, CalendarClock, Check, CheckCircle2, Circle, Clock3, HardDrive, HardDriveDownload, Loader2, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/settings-shell/page-header";

interface BackupRecord {
  id: string;
  createdAt: string;
  completedAt?: string;
  status: "creating" | "completed" | "failed";
  appCount: number;
  apps?: string[];
  mediaId?: string;
  reason?: "manual" | "scheduled" | "pre-restore";
  sizeBytes?: number;
  verifiedAt?: string;
  source?: { image_version?: string; release_branch?: string };
  compatibility?: { compatible: boolean; summary: string };
  error?: string;
}

interface BackupApp { id: string; name: string }
interface BackupMedia {
  id: string;
  device: string;
  model?: string;
  size_bytes: number;
  state: "blank" | "available" | "ready" | "unsupported";
  reason?: string;
  backup_ids?: string[];
}
interface BackupConfig {
  enabled?: boolean;
  mediaId?: string;
  selectedApps?: string[];
  lastError?: string;
	schedule?: { core?: { frequency?: "daily" | "weekly"; time?: string; last_run?: string }; overrides?: Record<string, { frequency?: "daily" | "weekly"; last_run?: string }> };
}
interface RestoreStatus { status: "running" | "completed" | "failed"; message: string; error?: string }

const RESTORE_STATUS_TIMEOUT_MS = 30 * 60 * 1000;









function AppChecklist({ apps, selected, onChange, disabled = false }: { apps: BackupApp[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const translateInterface = useInterfaceTranslations("interface");

  if (apps.length === 0) return <p className="text-sm text-muted-foreground">{translateInterface("me0180e8b1565")}</p>;
  return <div className="grid gap-2 sm:grid-cols-2">{apps.map(app => {
    const checked = selected.includes(app.id);
    return <Button key={app.id} type="button" variant="outline" aria-pressed={checked} disabled={disabled}
      className={`h-auto justify-start gap-3 px-3 py-2.5 font-normal ${checked ? "border-primary bg-primary/5" : ""}`}
      onClick={() => onChange(checked ? selected.filter(id => id !== app.id) : [...selected, app.id])}>
      <span className={`flex size-5 items-center justify-center rounded border ${checked ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}>{checked && <Check className="size-3.5" />}</span>
      <span>{app.name}</span>
    </Button>;
  })}</div>;
}

export function BackupClient() {
  const locale = useLocale();

  const translateInterface = useInterfaceTranslations("interface");
async function csrfToken() {
  const response = await fetch("/settings/api/auth/csrf", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.csrfToken !== "string") throw new Error(translateInterface("mf03325312e78"));
  return body.csrfToken as string;
}

function formatSize(bytes?: number) {
  if (!bytes) return translateInterface("md7d557fa439a");
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toLocaleString(locale, {minimumFractionDigits: value >= 10 || unit === 0 ? 0 : 1, maximumFractionDigits: value >= 10 || unit === 0 ? 0 : 1})} ${units[unit]}`;
}

async function readStream(response: Response, onEvent: (event: { message?: string; progress?: number }) => void) {
  if (!response.ok) throw new Error(await response.text() || translateInterface("m0b177dd13786"));
  const reader = response.body?.getReader();
  if (!reader) throw new Error(translateInterface("m4da74be747d0"));
  const decoder = new TextDecoder();
  let buffer = "";
  let terminalError = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const block of events) {
      const line = block.split("\n").find(item => item.startsWith("data: "));
      if (!line || line === "data: [DONE]") continue;
      const event = JSON.parse(line.slice(6)) as { status?: string; message?: string; progress?: number };
      onEvent(event);
      if (event.status === "error") terminalError = event.message || translateInterface("m0b177dd13786");
    }
  }
  if (terminalError) throw new Error(terminalError);
}

async function waitForRestore(operationId: string, onMessage: (message: string) => void) {
  const started = Date.now();
  while (Date.now() - started < RESTORE_STATUS_TIMEOUT_MS) {
    try {
      const response = await fetch(`/settings/api/backup/restore?operationId=${encodeURIComponent(operationId)}`, { cache: "no-store" });
      if (response.ok) {
        const status = await response.json() as RestoreStatus;
        onMessage(status.message);
        if (status.status === "completed") return;
        if (status.status === "failed") throw new Error(status.error || status.message);
      }
    } catch (error) {
      if (error instanceof Error && error.message && !error.message.includes("fetch")) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(translateInterface("mc01013ff2584"));
}


  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [apps, setApps] = useState<BackupApp[]>([]);
  const [media, setMedia] = useState<BackupMedia[]>([]);
  const [mediaError, setMediaError] = useState("");
  const [selectedMedia, setSelectedMedia] = useState("");
  const [selectedApps, setSelectedApps] = useState<string[]>([]);
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [automatic, setAutomatic] = useState(false);
  const [frequency, setFrequency] = useState<"daily" | "weekly">("daily");
  const [scheduleTime, setScheduleTime] = useState("03:00");
	const [appFrequencies, setAppFrequencies] = useState<Record<string, "never" | "daily" | "weekly">>({});
  const [prepareTarget, setPrepareTarget] = useState<BackupMedia | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupRecord | null>(null);
  const [restoreApps, setRestoreApps] = useState<string[]>([]);
  const [restoreCore, setRestoreCore] = useState(false);
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
	const configurationInitialized = useRef(false);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    try {
      const response = await fetch("/settings/api/backup/core", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || translateInterface("m1e30d919bf9e"));
      const nextApps = Array.isArray(body.apps) ? body.apps as BackupApp[] : [];
      const nextMedia = Array.isArray(body.media) ? body.media as BackupMedia[] : [];
      const config = (body.config || {}) as BackupConfig;
      setBackups(Array.isArray(body.backups) ? body.backups : []);
      setApps(nextApps);
      setMedia(nextMedia);
      setMediaError(typeof body.mediaError === "string" ? body.mediaError : "");
	  if (!configurationInitialized.current) {
		setSelectedMedia(config.mediaId || nextMedia.find(item => item.state !== "unsupported")?.id || "");
		setSelectedApps(nextApps.map(app => app.id));
		setAutomatic(config.enabled === true);
		setFrequency(config.schedule?.core?.frequency === "weekly" ? "weekly" : "daily");
		setScheduleTime(config.schedule?.core?.time || "03:00");
		setAppFrequencies(Object.fromEntries(nextApps.map(app => {
		  const appFrequency = config.schedule?.overrides?.[app.id]?.frequency;
		  return [app.id, appFrequency === "daily" || appFrequency === "weekly" ? appFrequency : "never"];
		})));
		configurationInitialized.current = true;
	  }
      if (config.lastError) setMediaError(config.lastError);
    } catch (loadError) {
      setError(translateInterface("m1e30d919bf9e"));
    } finally {
      if (initial) setLoading(false);
    }
  }, [translateInterface]);

  useEffect(() => {
    void load(true);
    const poll = setInterval(() => { if (!busy) void load(false); }, 5000);
    return () => clearInterval(poll);
  }, [busy, load]);

  const selectedDrive = useMemo(() => media.find(item => item.id === selectedMedia), [media, selectedMedia]);
  const driveReady = selectedDrive?.state === "ready" || selectedDrive?.state === "available";
  const readyDrive = useMemo(() => media.find(item => item.state === "ready" || item.state === "available"), [media]);
  const latestBackup = backups[0];
  const passwordsMatch = passphrase.length >= 12 && passphrase === confirmPassphrase;

  async function protectedPost(url: string, body: Record<string, unknown>) {
    const csrf = await csrfToken();
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(body) });
    if (!response.ok) {
      const responseBody = await response.json().catch(() => ({}));
      throw new Error(responseBody.error || await response.text().catch(() => "") || translateInterface("m544d23516d8f"));
    }
    return response;
  }

  async function prepareDrive() {
    if (!prepareTarget) return;
    setPrepareTarget(null); setBusy(true); setError(""); setMessage("");
    try {
      await protectedPost("/settings/api/backup/media", { action: "prepare", mediaId: prepareTarget.id, confirm: true });
      setMessage(translateInterface("mb9334c7c3e4a"));
      await load(false);
    } catch (prepareError) { setError(translateInterface("m094ec228d4ef")); }
    finally { setBusy(false); }
  }

  async function createBackup() {
    setBusy(true); setError(""); setMessage(""); setProgress(1); setProgressMessage(translateInterface("m0e931020a56e"));
    try {
      const response = await protectedPost("/settings/api/backup/core", { passphrase, mediaId: selectedMedia, appIds: selectedApps });
      await readStream(response, event => { if (event.message) setProgressMessage(event.message); if (typeof event.progress === "number") setProgress(event.progress); });
      setMessage(translateInterface("m823b46a25b1a"));
      setPassphrase(""); setConfirmPassphrase("");
      await load(false);
    } catch (createError) { setError(translateInterface("me4063f6e6091")); }
    finally { setBusy(false); setProgress(0); setProgressMessage(""); }
  }

  async function ejectDrive(mediaId: string) {
	setBusy(true); setError(""); setMessage("");
	try {
	  await protectedPost("/settings/api/backup/media", { action: "eject", mediaId });
	  setMessage(translateInterface("m60bccd2b9f46"));
	  await load(false);
	} catch (ejectError) { setError(translateInterface("m8f4a638c02e0")); }
	finally { setBusy(false); }
  }

  async function saveAutomatic() {
    setBusy(true); setError(""); setMessage("");
    try {
	  if (automatic && !passwordsMatch) throw new Error(translateInterface("m6dc7db435fb5"));
	  const scheduledAppIds = apps.map(app => app.id).filter(appId => appFrequencies[appId] === "daily" || appFrequencies[appId] === "weekly");
	  await protectedPost("/settings/api/backup/media", { action: "schedule", enabled: automatic, mediaId: selectedMedia, appIds: scheduledAppIds, appFrequencies, passphrase, frequency, time: scheduleTime });
      setMessage(automatic ? translateInterface("mdfe2a0860b1e") : translateInterface("m17e778d6846b"));
      setPassphrase(""); setConfirmPassphrase("");
      await load(false);
    } catch (scheduleError) { setError(translateInterface("m0b2a7b811220")); }
    finally { setBusy(false); }
  }

  async function restoreBackup() {
    if (!restoreTarget) return;
    setConfirmRestore(false); setBusy(true); setError(""); setMessage(""); setProgress(1); setProgressMessage(translateInterface("m2b72eaa1cc4f"));
    try {
      const operationId = crypto.randomUUID();
      const response = await protectedPost("/settings/api/backup/restore", {
        backupId: restoreTarget.id,
		mediaId: restoreTarget.mediaId,
        passphrase: restorePassphrase,
        operationId,
        confirm: true,
        restoreCore,
        appIds: restoreApps,
      });
      await readStream(response, event => { if (event.message) setProgressMessage(event.message); if (typeof event.progress === "number") setProgress(event.progress); }).catch(() => undefined);
      await waitForRestore(operationId, setProgressMessage);
	  setMessage(restoreCore ? translateInterface("mcd9b5c5a80ab") : translateInterface("me51663682ecb"));
      setRestorePassphrase(""); setRestoreTarget(null);
      await load(false);
    } catch (restoreError) { setError(translateInterface("mc998f96febc3")); }
    finally { setBusy(false); setProgress(0); setProgressMessage(""); }
  }

  return <div>
    <PageHeader title={translateInterface("m3334fee2c77f")} description={translateInterface("m4e24401192f6")} />

    {(error || message) && <Alert variant={error ? "destructive" : "default"} className="mb-5"><AlertDescription>{error || message}</AlertDescription></Alert>}
    {busy && progressMessage && <div className="mb-6 space-y-2 rounded-lg border bg-card p-4"><div className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" />{progressMessage}</div><Progress value={progress} /></div>}

    <div className="mb-6 grid gap-3 md:grid-cols-3">
      <div className="rounded-xl border bg-card p-4 shadow-sm"><div className="flex items-center gap-2 text-sm font-medium"><HardDrive className="size-4 text-primary" />{translateInterface("me06956e5d7e6")}</div><div className="mt-3 flex items-center gap-2 text-sm"><span className={`size-2 rounded-full ${readyDrive ? "bg-primary" : "bg-destructive"}`} /><span>{readyDrive ? translateInterface("m5fa7aac5375c") : translateInterface("m45bf454e495a")}</span></div><p className="mt-1 text-xs text-muted-foreground">{readyDrive ? `${readyDrive.model || readyDrive.device} · ${formatSize(readyDrive.size_bytes)}` : translateInterface("me98c2fe1c0c9")}</p></div>
      <div className="rounded-xl border bg-card p-4 shadow-sm"><div className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4 text-primary" />{translateInterface("m53aa06db2a02")}</div><div className="mt-3 flex items-center gap-2 text-sm"><span className={`size-2 rounded-full ${latestBackup ? "bg-primary" : "bg-muted-foreground"}`} /><span>{latestBackup ? translateInterface("m4f7838402f37") : translateInterface("m1d1827745b69")}</span></div><p className="mt-1 text-xs text-muted-foreground">{latestBackup ? new Date(latestBackup.createdAt).toLocaleString(locale) : translateInterface("mff3157013b50")}</p></div>
      <div className="rounded-xl border bg-card p-4 shadow-sm"><div className="flex items-center gap-2 text-sm font-medium"><CalendarClock className="size-4 text-primary" />{translateInterface("mcb8603c8ce91")}</div><div className="mt-3 flex items-center gap-2 text-sm"><span className={`size-2 rounded-full ${automatic ? "bg-primary" : "bg-muted-foreground"}`} /><span>{automatic ? translateInterface("m130011756125") : translateInterface("mca7981b46ecf")}</span></div><p className="mt-1 text-xs text-muted-foreground">{automatic ? frequency === "daily" ? translateInterface("mb342dd0e1eef", {time: scheduleTime}) : translateInterface("m92c7537dcd7f", {time: scheduleTime}) : translateInterface("mff7bd7fb8704")}</p></div>
    </div>

    <section className="border-b pb-6">
      <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-5 text-primary" /><div><h2 className="text-[15px] font-semibold">{translateInterface("m69b9692f78a4")}</h2><p className="mt-1 text-sm text-muted-foreground">{translateInterface("mf4b6e40668b4")}</p></div></div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="backup-passphrase">{translateInterface("m69b9692f78a4")}</Label><Input id="backup-passphrase" type="password" value={passphrase} onChange={event => setPassphrase(event.target.value)} autoComplete="new-password" disabled={busy} /></div>
        <div className="space-y-2"><Label htmlFor="backup-confirm">{translateInterface("m5a2348ad34d3")}</Label><Input id="backup-confirm" type="password" value={confirmPassphrase} onChange={event => setConfirmPassphrase(event.target.value)} autoComplete="new-password" disabled={busy} /></div>
      </div>
    </section>

    <section className="border-b py-6">
      <div className="flex items-center justify-between gap-3"><div><h2 className="text-[15px] font-semibold">{translateInterface("me06956e5d7e6")}</h2><p className="mt-1 text-sm text-muted-foreground">{translateInterface("m766dfcb78abf")}</p></div><Button variant="ghost" size="icon" onClick={() => void load(false)} disabled={busy} title={translateInterface("m5b2606b078b9")}><RefreshCw className="size-4" /><span className="sr-only">{translateInterface("m5b2606b078b9")}</span></Button></div>
      {mediaError && <Alert className="mt-4"><TriangleAlert className="size-4" /><AlertDescription>{mediaError}</AlertDescription></Alert>}
      {loading ? <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{translateInterface("mcd6434a45213")}</div> : media.length === 0 ? <div className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">{translateInterface("mdf1b1e7b62f1")}</div> : <div className="mt-4 grid gap-3">{media.map(drive => {
        const selected = selectedMedia === drive.id;
        return <div key={drive.id} className={`flex items-center gap-2 rounded-xl border p-2 ${selected ? "border-primary bg-primary/5" : ""}`}>
          <Button type="button" variant="ghost" aria-pressed={selected} onClick={() => setSelectedMedia(drive.id)} disabled={drive.state === "unsupported" || busy} className="h-auto min-w-0 flex-1 justify-start gap-3 px-2 py-2 text-left font-normal">
            {selected ? <CheckCircle2 className="size-5 shrink-0 text-primary" /> : <Circle className="size-5 shrink-0 text-muted-foreground" />}
            <HardDrive className="size-5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{drive.model || drive.device}</span><span className="block text-xs text-foreground/70">{formatSize(drive.size_bytes)} · {drive.state === "blank" ? translateInterface("m25688445db07") : drive.state === "ready" ? translateInterface("m5fa7aac5375c") : drive.state === "available" ? translateInterface("m00139f1afa9a") : drive.reason || translateInterface("mca1844969742")}</span></span>
          </Button>
          {drive.state === "blank" && <Button type="button" variant="outline" size="sm" onClick={() => setPrepareTarget(drive)} disabled={busy}>{translateInterface("mee820467e916")}</Button>}
		  {drive.state === "ready" && <Button type="button" variant="ghost" size="sm" onClick={() => void ejectDrive(drive.id)} disabled={busy}>{translateInterface("m4496452440f3")}</Button>}
        </div>;
      })}</div>}
    </section>

    <section className="border-b py-6">
      <h2 className="text-[15px] font-semibold">{translateInterface("m6b4fc314ae7d")}</h2>
      <div className="mt-4 flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-2.5 text-sm"><CheckCircle2 className="size-4 text-primary" /><span><span className="font-medium">{translateInterface("madd8ec6e3557")}</span><span className="ml-2 text-muted-foreground">{translateInterface("mee0d1a4ba3f9")}</span></span></div>
      <div className="mt-3"><AppChecklist apps={apps} selected={selectedApps} onChange={setSelectedApps} disabled={busy} /></div>
      <Button className="mt-4" onClick={() => void createBackup()} disabled={busy || !driveReady || !passwordsMatch}><HardDriveDownload className="size-4" />{translateInterface("m02a2840b598b")}</Button>
    </section>

    <section className="border-b py-6">
      <div className="flex items-center justify-between gap-4"><div><h2 className="text-[15px] font-semibold">{translateInterface("mcb8603c8ce91")}</h2><p className="mt-1 text-sm text-muted-foreground">{translateInterface("m5d4f4a50f5c6")}</p></div><Switch checked={automatic} onCheckedChange={setAutomatic} disabled={busy} aria-label={translateInterface("mcb8603c8ce91")} /></div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="backup-frequency">{translateInterface("mdaae8bd431fa")}</Label><Select value={frequency} onValueChange={value => setFrequency(value === "weekly" ? "weekly" : "daily")} disabled={!automatic || busy}><SelectTrigger id="backup-frequency"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="daily">{translateInterface("mb36c2611dcdf")}</SelectItem><SelectItem value="weekly">{translateInterface("m2975132481a7")}</SelectItem></SelectContent></Select></div>
        <div className="space-y-2"><Label htmlFor="backup-time">{translateInterface("m33b93476cf59")}</Label><Input id="backup-time" type="time" value={scheduleTime} onChange={event => setScheduleTime(event.target.value)} disabled={!automatic || busy} /></div>
      </div>
      {apps.length > 0 && <div className="mt-4 space-y-2"><Label>{translateInterface("m3fc1d79f5b10")}</Label><div className="divide-y rounded-xl border">{apps.map(app => <div key={app.id} className="flex items-center justify-between gap-4 px-3 py-2.5"><span className="text-sm">{app.name}</span><Select value={appFrequencies[app.id] || "never"} onValueChange={value => setAppFrequencies(current => ({ ...current, [app.id]: value as "never" | "daily" | "weekly" }))} disabled={!automatic || busy}><SelectTrigger aria-label={translateInterface("m721c759deb60", { value0: String(app.name) })} className="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="never">{translateInterface("mb665bfc292d9")}</SelectItem><SelectItem value="daily">{translateInterface("mb36c2611dcdf")}</SelectItem><SelectItem value="weekly">{translateInterface("m2975132481a7")}</SelectItem></SelectContent></Select></div>)}</div></div>}
      <Button variant="outline" className="mt-4" onClick={() => void saveAutomatic()} disabled={busy || (automatic && (!driveReady || !passwordsMatch))}><Clock3 className="size-4" />{translateInterface("m94c4fb6c1714")}</Button>
    </section>

    <section className="py-6">
      <div className="flex items-center justify-between"><h2 className="text-[15px] font-semibold">{translateInterface("m7e90851df722")}</h2><Button variant="ghost" size="icon" onClick={() => void load(false)} disabled={busy}><RefreshCw className="size-4" /><span className="sr-only">{translateInterface("m36d72acb85cf")}</span></Button></div>
      {!loading && backups.length === 0 ? <div className="mt-4 flex items-center gap-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground"><ArchiveRestore className="size-4" />{translateInterface("ma8d8eac8a447")}</div> : <div className="mt-4 divide-y rounded-xl border">{backups.map(backup => {
        const compatible = backup.compatibility?.compatible === true;
        return <div key={backup.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center"><span className={`size-2 shrink-0 rounded-full ${compatible ? "bg-primary" : "bg-destructive"}`} /><div className="min-w-0 flex-1"><div className="text-sm font-medium">{new Date(backup.createdAt).toLocaleString(locale)}</div><div className="mt-1 text-xs text-muted-foreground">{translateInterface("mb0e3669b18e7", {size: formatSize(backup.sizeBytes), count: backup.appCount})}{backup.reason === "scheduled" ? translateInterface("m336659c84a0f") : ""}{backup.source?.image_version ? ` · YouEye ${backup.source.image_version}` : ""}</div><div className="mt-1 text-xs text-muted-foreground">{compatible ? translateInterface("m87672f62ea3f", {date: backup.verifiedAt ? new Date(backup.verifiedAt).toLocaleString(locale) : ""}) : backup.compatibility?.summary || translateInterface("m2396a6b97407")}</div></div><Button variant="outline" onClick={() => { setRestoreTarget(backup); setRestoreApps(backup.apps ?? []); setRestoreCore(false); setRestorePassphrase(""); }} disabled={busy || backup.status !== "completed" || !compatible}><ArchiveRestore className="size-4" />{translateInterface("ma76e13b98392")}</Button></div>;
      })}</div>}

      {restoreTarget && <div className="mt-5 space-y-4 border-t pt-5"><div><h3 className="text-sm font-semibold">{translateInterface("ma76e13b98392")}{new Date(restoreTarget.createdAt).toLocaleString(locale)}</h3><p className="mt-1 text-sm text-muted-foreground">{translateInterface("md925758daf9c")}</p></div>
        <Button type="button" variant="outline" aria-pressed={restoreCore} onClick={() => setRestoreCore(value => !value)} className={`h-auto w-full justify-start gap-3 p-3 text-left font-normal ${restoreCore ? "border-primary bg-primary/5" : ""}`}><span className={`flex size-5 shrink-0 items-center justify-center rounded border ${restoreCore ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}>{restoreCore && <Check className="size-3.5" />}</span><span><span className="block font-medium">{translateInterface("m00d9be7ada83")}</span><span className="mt-1 block text-muted-foreground">{translateInterface("md45726019011")}</span></span></Button>
        <AppChecklist apps={(restoreTarget.apps ?? []).map(id => ({ id, name: id }))} selected={restoreApps} onChange={setRestoreApps} disabled={busy} />
        <div className="flex flex-col gap-2 sm:flex-row"><Input type="password" value={restorePassphrase} onChange={event => setRestorePassphrase(event.target.value)} placeholder={translateInterface("m69b9692f78a4")} aria-label={translateInterface("m8bcf3d74ea4c")} autoComplete="current-password" disabled={busy} /><Button variant="destructive" onClick={() => setConfirmRestore(true)} disabled={busy || restorePassphrase.length < 12 || (!restoreCore && restoreApps.length === 0)}>{translateInterface("m967bd624c2d5")}</Button><Button variant="ghost" onClick={() => setRestoreTarget(null)} disabled={busy}>{translateInterface("m19766ed6ccb2")}</Button></div>
      </div>}
    </section>

    <ConfirmDialog open={Boolean(prepareTarget)} title={translateInterface("ma77f574e36ce")} description={translateInterface("m044b984a0b61")} confirmLabel={translateInterface("m4a5b5e783667")} destructive onConfirm={() => void prepareDrive()} onCancel={() => setPrepareTarget(null)} />
    <ConfirmDialog open={confirmRestore} title={restoreCore ? translateInterface("mac9c444f8575") : translateInterface("m408579f8979d")} description={restoreCore ? translateInterface("me36abae6dc93") : translateInterface("m073362764359")} confirmLabel={translateInterface("ma76e13b98392")} destructive onConfirm={() => void restoreBackup()} onCancel={() => setConfirmRestore(false)} />
  </div>;
}
