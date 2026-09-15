'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, HardDrive, Loader2, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ApplianceSystemUpdateSelection, ApplianceSystemUpdateStatus } from '@/lib/spine/client';

interface Props {
  onContinue: () => void;
}

async function protectedHeaders() {
  const response = await fetch('/api/auth/csrf', { cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.csrfToken !== 'string') throw new Error('Could not start a protected update action.');
  return { 'Content-Type': 'application/json', 'X-CSRF-Token': body.csrfToken as string };
}

export default function SetupApplianceUpdate({ onContinue }: Props) {
  const [status, setStatus] = useState<ApplianceSystemUpdateStatus | null>(null);
  const [selection, setSelection] = useState<ApplianceSystemUpdateSelection | null>(null);
  const [busy, setBusy] = useState<'checking' | 'staging' | 'restarting' | null>('checking');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const response = await fetch('/settings/api/appliance/system-update/status', { cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'System update status is unavailable.');
    setStatus(body as ApplianceSystemUpdateStatus);
    return body as ApplianceSystemUpdateStatus;
  }, []);

  const check = useCallback(async () => {
    setBusy('checking');
    setError('');
    try {
      const current = await load();
      if (!['healthy', 'rolled-back'].includes(current.state)) return;
      const sourceResponse = await fetch('/settings/api/appliance/system-update/source', { cache: 'no-store' });
      const source = await sourceResponse.json().catch(() => ({}));
      if (!sourceResponse.ok) throw new Error(source.error || 'Could not load the signed release source.');
      setSelection(source as ApplianceSystemUpdateSelection);
      const headers = await protectedHeaders();
      const response = await fetch('/settings/api/appliance/system-update/check', {
        method: 'POST',
        headers,
        body: JSON.stringify(source),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Could not check for a signed system image.');
      setStatus(body as ApplianceSystemUpdateStatus);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not check for a signed system image.');
    } finally {
      setBusy(null);
    }
  }, [load]);

  useEffect(() => { void check(); }, [check]);

  async function updateNow() {
    setBusy('staging');
    setError('');
    try {
      if (!selection) throw new Error('Check the signed release source before updating.');
      const headers = await protectedHeaders();
      const stageResponse = await fetch('/settings/api/appliance/system-update/stage', {
        method: 'POST', headers, body: JSON.stringify(selection),
      });
      const staged = await stageResponse.json().catch(() => ({}));
      if (!stageResponse.ok) throw new Error(staged.error || 'Could not stage the signed system image.');
      setStatus(staged as ApplianceSystemUpdateStatus);
      setBusy('restarting');
      const activateHeaders = await protectedHeaders();
      const activateResponse = await fetch('/settings/api/appliance/system-update/activate', {
        method: 'POST', headers: activateHeaders, body: JSON.stringify({ reboot: true }),
      });
      const activated = await activateResponse.json().catch(() => ({}));
      if (!activateResponse.ok) throw new Error(activated.error || 'Could not restart into the staged image.');
      setStatus(activated as ApplianceSystemUpdateStatus);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'System update failed.');
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
        <h1 className="text-2xl font-semibold">System update</h1>
        <p className="mt-2 text-sm text-muted-foreground">Continue with the packaged host system, or install a newer signed update before server setup.</p>
      </div>

      <div className="border-y py-4 text-sm">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">Packaged system</span>
          <span className="font-medium">{status?.running_image || 'Installed'}</span>
        </div>
        {available && (
          <div className="mt-3 flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Signed update</span>
            <span className="flex items-center gap-2 font-medium">{status.target_image}<Badge variant="secondary">Available</Badge></span>
          </div>
        )}
      </div>

      {busy === 'checking' && <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Checking signed releases</div>}
      {busy === 'staging' && <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Downloading and preparing the inactive system</div>}
      {busy === 'restarting' && <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Restarting and checking the updated system</div>}
      {error && <Alert><AlertDescription>{error} You can continue with the packaged image.</AlertDescription></Alert>}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {!busy && error && <Button variant="ghost" onClick={() => void check()}><RefreshCw className="size-4" />Retry check</Button>}
        <Button variant="outline" onClick={onContinue} disabled={busy === 'staging' || busy === 'restarting'}>Continue with packaged version</Button>
        {available && <Button onClick={() => void updateNow()} disabled={busy !== null}><Download className="size-4" />Update now</Button>}
      </div>
    </div>
  );
}
