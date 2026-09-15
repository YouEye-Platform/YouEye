'use client';

import { useState } from 'react';
import { ArrowLeft, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { runNamesEnrollment } from '@/lib/youeye-names/popup';

export default function SetupNamesVerification({
  name,
  fqdn,
  onVerified,
  onBack,
}: {
  name: string;
  fqdn: string;
  onVerified: (proof: string) => void;
  onBack: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const verify = async () => {
    setLoading(true);
    setError('');
    try {
      let accepted = '';
      await runNamesEnrollment('lease_claim', {
        name,
        accept: (proof) => { accepted = proof; },
      });
      if (!accepted) throw new Error('YouEye Names did not return a claim proof.');
      onVerified(accepted);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not verify this address.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md space-y-6">
      <div className="text-center">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
          <ShieldCheck className="h-8 w-8 text-primary" />
        </div>
        <h1 className="text-2xl font-bold">Confirm your secure address</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          One final accountless check reserves this address for this YouEye.
        </p>
      </div>

      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-blue-500" />
          <span className="text-sm font-medium">Verification needed</span>
        </div>
        <p className="mt-3 truncate font-mono text-sm" title={fqdn}>{fqdn}</p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          YouEye Names publishes this private-network destination and requests its trusted certificate. It does not proxy your traffic, and the TLS private key stays on this server.
        </p>
      </div>

      {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={onBack} disabled={loading} className="gap-2">
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <Button onClick={() => void verify()} disabled={loading} className="gap-2">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          {loading ? 'Waiting for verification…' : 'Verify and start setup'}
        </Button>
      </div>
    </div>
  );
}
