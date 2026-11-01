'use client';

import { useState, useRef, useEffect } from 'react';
import { useTranslations as useInterfaceTranslations } from "next-intl";
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
  const translateInterface = useInterfaceTranslations("interface");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const verification = useRef<AbortController | null>(null);
  useEffect(() => () => verification.current?.abort(), [name, fqdn]);

  const verify = async () => {
    if (verification.current) return;
    const controller = new AbortController();
    verification.current = controller;
    setLoading(true);
    setError('');
    try {
      let accepted = '';
      await runNamesEnrollment('lease_claim', {
        name,
        signal: controller.signal,
        accept: (proof) => { accepted = proof; },
      });
      if (!accepted) throw new Error(translateInterface("m7e53f14e46f0"));
      if (!controller.signal.aborted) onVerified(accepted);
    } catch (reason) {
      setError(translateInterface("meccb34acb8a7"));
    } finally {
      verification.current = null;
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold">{translateInterface("mfbb2288ca6b6")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {translateInterface("m4029c23fa6cb")}</p>
      </div>
      <p className="text-sm text-muted-foreground">
        {translateInterface("m9df877e8ce4b")}</p>

      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-blue-500" />
          <span className="text-sm font-medium">{translateInterface("m4377586214cd")}</span>
        </div>
        <p className="mt-3 truncate font-mono text-sm" title={fqdn}>{fqdn}</p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {translateInterface("m3460df24b0cd")}</p>
      </div>

      {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={onBack} disabled={loading} className="gap-2">
          <ArrowLeft className="h-4 w-4" /> {" "}{translateInterface("m76900f1bfd16")}</Button>
        <Button onClick={() => void verify()} disabled={loading} className="gap-2">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          {loading ? translateInterface("m2b69f6c546fd") : translateInterface("m637845e0d3dc")}
        </Button>
      </div>
    </div>
  );
}
