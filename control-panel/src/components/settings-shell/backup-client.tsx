"use client";

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

async function csrfToken() {
  const response = await fetch("/settings/api/auth/csrf", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.csrfToken !== "string") throw new Error("Could not start a protected backup action.");
  return body.csrfToken as string;
}

function formatSize(bytes?: number) {
  if (!bytes) return "Size unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

async function readStream(response: Response, onEvent: (event: { message?: string; progress?: number }) => void) {
  if (!response.ok) throw new Error(await response.text() || "Backup operation failed.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No progress stream returned.");
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
      if (event.status === "error") terminalError = event.message || "Backup operation failed.";
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
  throw new Error("Restore did not finish within 30 minutes.");
}

function AppChecklist({ apps, selected, onChange, disabled = false }: { apps: BackupApp[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  if (apps.length === 0) return <p className="text-sm text-muted-foreground">No optional applications are installed.</p>;
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
      if (!response.ok) throw new Error(body.error || "Backups are unavailable.");
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
      setError(loadError instanceof Error ? loadError.message : "Backups are unavailable.");
    } finally {
      if (initial) setLoading(false);
    }
  }, []);

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
      throw new Error(responseBody.error || await response.text().catch(() => "") || "Backup action failed.");
    }
    return response;
  }

  async function prepareDrive() {
    if (!prepareTarget) return;
    setPrepareTarget(null); setBusy(true); setError(""); setMessage("");
    try {
      await protectedPost("/settings/api/backup/media", { action: "prepare", mediaId: prepareTarget.id, confirm: true });
      setMessage("Backup drive prepared and mounted.");
      await load(false);
    } catch (prepareError) { setError(prepareError instanceof Error ? prepareError.message : "Could not prepare drive."); }
    finally { setBusy(false); }
  }

  async function createBackup() {
    setBusy(true); setError(""); setMessage(""); setProgress(1); setProgressMessage("Preparing recovery point");
    try {
      const response = await protectedPost("/settings/api/backup/core", { passphrase, mediaId: selectedMedia, appIds: selectedApps });
      await readStream(response, event => { if (event.message) setProgressMessage(event.message); if (typeof event.progress === "number") setProgress(event.progress); });
      setMessage("Encrypted recovery point completed and verified.");
      setPassphrase(""); setConfirmPassphrase("");
      await load(false);
    } catch (createError) { setError(createError instanceof Error ? createError.message : "Backup failed."); }
    finally { setBusy(false); setProgress(0); setProgressMessage(""); }
  }

  async function ejectDrive(mediaId: string) {
	setBusy(true); setError(""); setMessage("");
	try {
	  await protectedPost("/settings/api/backup/media", { action: "eject", mediaId });
	  setMessage("Backup drive can now be safely unplugged.");
	  await load(false);
	} catch (ejectError) { setError(ejectError instanceof Error ? ejectError.message : "Could not eject drive."); }
	finally { setBusy(false); }
  }

  async function saveAutomatic() {
    setBusy(true); setError(""); setMessage("");
    try {
	  if (automatic && !passwordsMatch) throw new Error("Enter and confirm the recovery key used for automatic backups.");
	  const scheduledAppIds = apps.map(app => app.id).filter(appId => appFrequencies[appId] === "daily" || appFrequencies[appId] === "weekly");
	  await protectedPost("/settings/api/backup/media", { action: "schedule", enabled: automatic, mediaId: selectedMedia, appIds: scheduledAppIds, appFrequencies, passphrase, frequency, time: scheduleTime });
      setMessage(automatic ? "Automatic backups saved." : "Automatic backups turned off.");
      setPassphrase(""); setConfirmPassphrase("");
      await load(false);
    } catch (scheduleError) { setError(scheduleError instanceof Error ? scheduleError.message : "Could not save automatic backups."); }
    finally { setBusy(false); }
  }

  async function restoreBackup() {
    if (!restoreTarget) return;
    setConfirmRestore(false); setBusy(true); setError(""); setMessage(""); setProgress(1); setProgressMessage("Validating encrypted recovery point");
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
	  setMessage(restoreCore ? "Server restore completed. Server interface is restarting." : "Selected applications restored.");
      setRestorePassphrase(""); setRestoreTarget(null);
      await load(false);
    } catch (restoreError) { setError(restoreError instanceof Error ? restoreError.message : "Restore failed."); }
    finally { setBusy(false); setProgress(0); setProgressMessage(""); }
  }

  return <div>
    <PageHeader title="Backups" description="Encrypted recovery points for this server and the apps you choose." />

    {(error || message) && <Alert variant={error ? "destructive" : "default"} className="mb-5"><AlertDescription>{error || message}</AlertDescription></Alert>}
    {busy && progressMessage && <div className="mb-6 space-y-2 rounded-lg border bg-card p-4"><div className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" />{progressMessage}</div><Progress value={progress} /></div>}

    <div className="mb-6 grid gap-3 md:grid-cols-3">
      <div className="rounded-xl border bg-card p-4 shadow-sm"><div className="flex items-center gap-2 text-sm font-medium"><HardDrive className="size-4 text-primary" />Backup drive</div><div className="mt-3 flex items-center gap-2 text-sm"><span className={`size-2 rounded-full ${readyDrive ? "bg-primary" : "bg-destructive"}`} /><span>{readyDrive ? "Ready" : "Needs a drive"}</span></div><p className="mt-1 text-xs text-muted-foreground">{readyDrive ? `${readyDrive.model || readyDrive.device} · ${formatSize(readyDrive.size_bytes)}` : "Attach and prepare an external drive."}</p></div>
      <div className="rounded-xl border bg-card p-4 shadow-sm"><div className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4 text-primary" />Latest recovery point</div><div className="mt-3 flex items-center gap-2 text-sm"><span className={`size-2 rounded-full ${latestBackup ? "bg-primary" : "bg-muted-foreground"}`} /><span>{latestBackup ? "Verified" : "Not created"}</span></div><p className="mt-1 text-xs text-muted-foreground">{latestBackup ? new Date(latestBackup.createdAt).toLocaleString() : "Create the first encrypted recovery point."}</p></div>
      <div className="rounded-xl border bg-card p-4 shadow-sm"><div className="flex items-center gap-2 text-sm font-medium"><CalendarClock className="size-4 text-primary" />Automatic backups</div><div className="mt-3 flex items-center gap-2 text-sm"><span className={`size-2 rounded-full ${automatic ? "bg-primary" : "bg-muted-foreground"}`} /><span>{automatic ? "On" : "Off"}</span></div><p className="mt-1 text-xs text-muted-foreground">{automatic ? `${frequency === "daily" ? "Daily" : "Weekly"} at ${scheduleTime}` : "Turn on after choosing a ready drive."}</p></div>
    </div>

    <section className="border-b pb-6">
      <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-5 text-primary" /><div><h2 className="text-[15px] font-semibold">Recovery key</h2><p className="mt-1 text-sm text-muted-foreground">Backups are encrypted before they reach the drive. Keep this key somewhere separate; a new YouEye installation needs it to restore.</p></div></div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="backup-passphrase">Recovery key</Label><Input id="backup-passphrase" type="password" value={passphrase} onChange={event => setPassphrase(event.target.value)} autoComplete="new-password" disabled={busy} /></div>
        <div className="space-y-2"><Label htmlFor="backup-confirm">Repeat recovery key</Label><Input id="backup-confirm" type="password" value={confirmPassphrase} onChange={event => setConfirmPassphrase(event.target.value)} autoComplete="new-password" disabled={busy} /></div>
      </div>
    </section>

    <section className="border-b py-6">
      <div className="flex items-center justify-between gap-3"><div><h2 className="text-[15px] font-semibold">Backup drive</h2><p className="mt-1 text-sm text-muted-foreground">Plug in a drive and YouEye will detect it here.</p></div><Button variant="ghost" size="icon" onClick={() => void load(false)} disabled={busy} title="Refresh drives"><RefreshCw className="size-4" /><span className="sr-only">Refresh drives</span></Button></div>
      {mediaError && <Alert className="mt-4"><TriangleAlert className="size-4" /><AlertDescription>{mediaError}</AlertDescription></Alert>}
      {loading ? <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Looking for drives…</div> : media.length === 0 ? <div className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">No eligible external drive is attached.</div> : <div className="mt-4 grid gap-3">{media.map(drive => {
        const selected = selectedMedia === drive.id;
        return <div key={drive.id} className={`flex items-center gap-2 rounded-xl border p-2 ${selected ? "border-primary bg-primary/5" : ""}`}>
          <Button type="button" variant="ghost" aria-pressed={selected} onClick={() => setSelectedMedia(drive.id)} disabled={drive.state === "unsupported" || busy} className="h-auto min-w-0 flex-1 justify-start gap-3 px-2 py-2 text-left font-normal">
            {selected ? <CheckCircle2 className="size-5 shrink-0 text-primary" /> : <Circle className="size-5 shrink-0 text-muted-foreground" />}
            <HardDrive className="size-5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{drive.model || drive.device}</span><span className="block text-xs text-foreground/70">{formatSize(drive.size_bytes)} · {drive.state === "blank" ? "Blank drive" : drive.state === "ready" ? "Ready" : drive.state === "available" ? "Ready to mount" : drive.reason || "Unavailable"}</span></span>
          </Button>
          {drive.state === "blank" && <Button type="button" variant="outline" size="sm" onClick={() => setPrepareTarget(drive)} disabled={busy}>Prepare</Button>}
		  {drive.state === "ready" && <Button type="button" variant="ghost" size="sm" onClick={() => void ejectDrive(drive.id)} disabled={busy}>Eject</Button>}
        </div>;
      })}</div>}
    </section>

    <section className="border-b py-6">
      <h2 className="text-[15px] font-semibold">What to back up</h2>
      <div className="mt-4 flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-2.5 text-sm"><CheckCircle2 className="size-4 text-primary" /><span><span className="font-medium">YouEye server</span><span className="ml-2 text-muted-foreground">Always included: accounts, settings, domain, services, and app inventory</span></span></div>
      <div className="mt-3"><AppChecklist apps={apps} selected={selectedApps} onChange={setSelectedApps} disabled={busy} /></div>
      <Button className="mt-4" onClick={() => void createBackup()} disabled={busy || !driveReady || !passwordsMatch}><HardDriveDownload className="size-4" />Back up now</Button>
    </section>

    <section className="border-b py-6">
      <div className="flex items-center justify-between gap-4"><div><h2 className="text-[15px] font-semibold">Automatic backups</h2><p className="mt-1 text-sm text-muted-foreground">If the drive is away at the scheduled time, YouEye waits and starts when it returns.</p></div><Switch checked={automatic} onCheckedChange={setAutomatic} disabled={busy} aria-label="Automatic backups" /></div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="backup-frequency">Server frequency</Label><Select value={frequency} onValueChange={value => setFrequency(value === "weekly" ? "weekly" : "daily")} disabled={!automatic || busy}><SelectTrigger id="backup-frequency"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="daily">Daily</SelectItem><SelectItem value="weekly">Weekly</SelectItem></SelectContent></Select></div>
        <div className="space-y-2"><Label htmlFor="backup-time">Time</Label><Input id="backup-time" type="time" value={scheduleTime} onChange={event => setScheduleTime(event.target.value)} disabled={!automatic || busy} /></div>
      </div>
      {apps.length > 0 && <div className="mt-4 space-y-2"><Label>Application schedule</Label><div className="divide-y rounded-xl border">{apps.map(app => <div key={app.id} className="flex items-center justify-between gap-4 px-3 py-2.5"><span className="text-sm">{app.name}</span><Select value={appFrequencies[app.id] || "never"} onValueChange={value => setAppFrequencies(current => ({ ...current, [app.id]: value as "never" | "daily" | "weekly" }))} disabled={!automatic || busy}><SelectTrigger aria-label={`${app.name} backup frequency`} className="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="never">Not included</SelectItem><SelectItem value="daily">Daily</SelectItem><SelectItem value="weekly">Weekly</SelectItem></SelectContent></Select></div>)}</div></div>}
      <Button variant="outline" className="mt-4" onClick={() => void saveAutomatic()} disabled={busy || (automatic && (!driveReady || !passwordsMatch))}><Clock3 className="size-4" />Save automatic backups</Button>
    </section>

    <section className="py-6">
      <div className="flex items-center justify-between"><h2 className="text-[15px] font-semibold">Recovery points</h2><Button variant="ghost" size="icon" onClick={() => void load(false)} disabled={busy}><RefreshCw className="size-4" /><span className="sr-only">Refresh recovery points</span></Button></div>
      {!loading && backups.length === 0 ? <div className="mt-4 flex items-center gap-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground"><ArchiveRestore className="size-4" />No recovery points yet.</div> : <div className="mt-4 divide-y rounded-xl border">{backups.map(backup => {
        const compatible = backup.compatibility?.compatible === true;
        return <div key={backup.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center"><span className={`size-2 shrink-0 rounded-full ${compatible ? "bg-primary" : "bg-destructive"}`} /><div className="min-w-0 flex-1"><div className="text-sm font-medium">{new Date(backup.createdAt).toLocaleString()}</div><div className="mt-1 text-xs text-muted-foreground">{formatSize(backup.sizeBytes)} · YouEye server · {backup.appCount} {backup.appCount === 1 ? "app" : "apps"}{backup.reason === "scheduled" ? " · Automatic" : ""}{backup.source?.image_version ? ` · YouEye ${backup.source.image_version}` : ""}</div><div className="mt-1 text-xs text-muted-foreground">{compatible ? `Verified${backup.verifiedAt ? ` ${new Date(backup.verifiedAt).toLocaleString()}` : ""}` : backup.compatibility?.summary || "Compatibility evidence unavailable"}</div></div><Button variant="outline" onClick={() => { setRestoreTarget(backup); setRestoreApps(backup.apps ?? []); setRestoreCore(false); setRestorePassphrase(""); }} disabled={busy || backup.status !== "completed" || !compatible}><ArchiveRestore className="size-4" />Restore</Button></div>;
      })}</div>}

      {restoreTarget && <div className="mt-5 space-y-4 border-t pt-5"><div><h3 className="text-sm font-semibold">Restore {new Date(restoreTarget.createdAt).toLocaleString()}</h3><p className="mt-1 text-sm text-muted-foreground">Restore individual apps without changing the rest of the server, or include the required YouEye server configuration for a whole recovery.</p></div>
        <Button type="button" variant="outline" aria-pressed={restoreCore} onClick={() => setRestoreCore(value => !value)} className={`h-auto w-full justify-start gap-3 p-3 text-left font-normal ${restoreCore ? "border-primary bg-primary/5" : ""}`}><span className={`flex size-5 shrink-0 items-center justify-center rounded border ${restoreCore ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}>{restoreCore && <Check className="size-3.5" />}</span><span><span className="block font-medium">Restore YouEye server configuration</span><span className="mt-1 block text-muted-foreground">Accounts, domain, platform settings, and core services will be replaced.</span></span></Button>
        <AppChecklist apps={(restoreTarget.apps ?? []).map(id => ({ id, name: id }))} selected={restoreApps} onChange={setRestoreApps} disabled={busy} />
        <div className="flex flex-col gap-2 sm:flex-row"><Input type="password" value={restorePassphrase} onChange={event => setRestorePassphrase(event.target.value)} placeholder="Recovery key" aria-label="Backup recovery key" autoComplete="current-password" disabled={busy} /><Button variant="destructive" onClick={() => setConfirmRestore(true)} disabled={busy || restorePassphrase.length < 12 || (!restoreCore && restoreApps.length === 0)}>Review restore</Button><Button variant="ghost" onClick={() => setRestoreTarget(null)} disabled={busy}>Cancel</Button></div>
      </div>}
    </section>

    <ConfirmDialog open={Boolean(prepareTarget)} title="Prepare this backup drive?" description="Everything currently on this blank drive will be erased. YouEye re-checks the exact drive before formatting it." confirmLabel="Erase and prepare" destructive onConfirm={() => void prepareDrive()} onCancel={() => setPrepareTarget(null)} />
    <ConfirmDialog open={confirmRestore} title={restoreCore ? "Restore this server and selected apps?" : "Restore selected apps?"} description={restoreCore ? "Current accounts, configuration, core services, and selected app data will be replaced. The system image remains on its current release." : "Only the selected apps will be replaced from this recovery point. Other apps and server settings stay unchanged."} confirmLabel="Restore" destructive onConfirm={() => void restoreBackup()} onCancel={() => setConfirmRestore(false)} />
  </div>;
}
