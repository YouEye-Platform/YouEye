'use client';







import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useCallback, useEffect, useState } from 'react';
import { Download, HardDrive, Loader2, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { CoreUpdateStatus, ApplianceSystemUpdateSelection, ApplianceSystemUpdateStatus } from '@/lib/spine/client';

interface Props {
  onContinue: () => void;
}



export default function SetupApplianceUpdate({ onContinue }: Props) {
  const translateInterface = useInterfaceTranslations("interface");

  const [core, setCore] = useState<CoreUpdateStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    // Setup sessions use onboarding APIs; Settings requires completed setup.
    const response = await fetch('/api/appliance/core-update/status', { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || typeof body.managed !== 'boolean') throw new Error(translateInterface("m49cb3312ae05"));
    setCore(body as CoreUpdateStatus);
    return body as CoreUpdateStatus;
  }, [translateInterface]);
  useEffect(() => { void refresh().catch(() => setError(translateInterface("m49cb3312ae05"))); }, [refresh]);
  async function proceed() {
    setBusy(true); setError('');
    try {
      const current = await refresh();
      if (!current.managed || !current.installed || (current.transaction && !current.transaction.complete)) throw new Error(translateInterface("m82ac9d64312f"));
      onContinue();
    } catch (cause) { setError(translateInterface("ma98d59b0ab9f")); }
    finally { setBusy(false); }
  }
  if (core?.managed === false) return <LegacySetupApplianceUpdate onContinue={onContinue} />;
  return <div className="mx-auto w-full max-w-lg space-y-6">
    <div className="text-center"><h1 className="text-2xl font-semibold">{translateInterface("m2a1ec4ff37ff")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{core?.installed ? translateInterface("m75da79f336fa", { value0: String(core.installed.release.version) }) : translateInterface("m88e6bcd109ec")}</p></div>
    {error && <Alert><AlertDescription>{error}</AlertDescription></Alert>}
    {core?.transaction && !core.transaction.complete && <p className="text-sm" role="status">{translateInterface("mdc5fc95c3673")}</p>}
    <div className="flex justify-end"><Button disabled={busy || !core?.installed} onClick={() => void proceed()}>{busy && <Loader2 className="size-4 animate-spin" />}{translateInterface("mc5702c19da53")}</Button></div>
  </div>;
}

function LegacySetupApplianceUpdate({ onContinue }: Props) {
  const translateInterface = useInterfaceTranslations("interface");
async function protectedHeaders() {
  const response = await fetch('/api/auth/csrf', { cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.csrfToken !== 'string') throw new Error(translateInterface("m40bc9725985b"));
  return { 'Content-Type': 'application/json', 'X-CSRF-Token': body.csrfToken as string };
}


  const [status, setStatus] = useState<ApplianceSystemUpdateStatus | null>(null);
  const [selection, setSelection] = useState<ApplianceSystemUpdateSelection | null>(null);
  const [busy, setBusy] = useState<'checking' | 'staging' | 'restarting' | null>('checking');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const response = await fetch('/settings/api/appliance/system-update/status', { cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || translateInterface("mc87dd5a532c0"));
    setStatus(body as ApplianceSystemUpdateStatus);
    return body as ApplianceSystemUpdateStatus;
  }, [translateInterface]);

  const check = useCallback(async () => {
    setBusy('checking');
    setError('');
    try {
      const current = await load();
      if (!['healthy', 'rolled-back'].includes(current.state)) return;
      const sourceResponse = await fetch('/settings/api/appliance/system-update/source', { cache: 'no-store' });
      const source = await sourceResponse.json().catch(() => ({}));
      if (!sourceResponse.ok) throw new Error(source.error || translateInterface("m0c078debc64d"));
      setSelection(source as ApplianceSystemUpdateSelection);
      const headers = await protectedHeaders();
      const response = await fetch('/settings/api/appliance/system-update/check', {
        method: 'POST',
        headers,
        body: JSON.stringify(source),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || translateInterface("m9fc3f802127a"));
      setStatus(body as ApplianceSystemUpdateStatus);
    } catch (reason) {
      setError(translateInterface("m9fc3f802127a"));
    } finally {
      setBusy(null);
    }
  }, [load, translateInterface]);

  useEffect(() => { void check(); }, [check]);

  async function updateNow() {
    setBusy('staging');
    setError('');
    try {
      if (!selection) throw new Error(translateInterface("m872c138cdb0b"));
      const headers = await protectedHeaders();
      const stageResponse = await fetch('/settings/api/appliance/system-update/stage', {
        method: 'POST', headers, body: JSON.stringify(selection),
      });
      const staged = await stageResponse.json().catch(() => ({}));
      if (!stageResponse.ok) throw new Error(staged.error || translateInterface("m20b8c7665e48"));
      setStatus(staged as ApplianceSystemUpdateStatus);
      setBusy('restarting');
      const activateHeaders = await protectedHeaders();
      const activateResponse = await fetch('/settings/api/appliance/system-update/activate', {
        method: 'POST', headers: activateHeaders, body: JSON.stringify({ reboot: true }),
      });
      const activated = await activateResponse.json().catch(() => ({}));
      if (!activateResponse.ok) throw new Error(activated.error || translateInterface("m059731eac212"));
      setStatus(activated as ApplianceSystemUpdateStatus);
    } catch (reason) {
      setError(translateInterface("mad183bccc3c3"));
      setBusy(null);
    }
  }

  const available = status?.state === 'available';

  return (
    <div className="mx-auto w-full max-w-lg space-y-6">
      <div className="text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <HardDrive className="size-6" />
        </div>
        <h1 className="text-2xl font-semibold">{translateInterface("mdcfe3eedc4b9")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{translateInterface("m94d61dd8dfb8")}</p>
      </div>

      <div className="border-y py-4 text-sm">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{translateInterface("m494d93a38113")}</span>
          <span className="font-medium">{status?.running_image || translateInterface("mf8b32f4e92bd")}</span>
        </div>
        {available && (
          <div className="mt-3 flex items-center justify-between gap-4">
            <span className="text-muted-foreground">{translateInterface("m351849bf6a57")}</span>
            <span className="flex items-center gap-2 font-medium">{status.target_image}<Badge variant="secondary">{translateInterface("me674447337e8")}</Badge></span>
          </div>
        )}
      </div>

      {busy === 'checking' && <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{translateInterface("m8cdfd350040b")}</div>}
      {busy === 'staging' && <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{translateInterface("m8feb39b05e37")}</div>}
      {busy === 'restarting' && <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{translateInterface("m5db46fce6652")}</div>}
      {error && <Alert><AlertDescription>{error} {translateInterface("m93c26355fb9f")}</AlertDescription></Alert>}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {!busy && error && <Button variant="ghost" onClick={() => void check()}><RefreshCw className="size-4" />{translateInterface("mf2ba6d4f2252")}</Button>}
        <Button variant="outline" onClick={onContinue} disabled={busy === 'staging' || busy === 'restarting'}>{translateInterface("m3bd59c688337")}</Button>
        {available && <Button onClick={() => void updateNow()} disabled={busy !== null}><Download className="size-4" />{translateInterface("m63bf045213ce")}</Button>}
      </div>
    </div>
  );
}
