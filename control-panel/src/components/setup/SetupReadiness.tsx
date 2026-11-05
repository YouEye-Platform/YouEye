'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useRef as useInterfaceTranslationRef } from "react";

/** Normal success advances automatically. Only exceptions interrupt the wizard. */
export default function SetupReadiness({ onReady }: { onReady: () => void }) {
  const translateInterface = useInterfaceTranslations("interface");
  const interfaceTranslationRef = useInterfaceTranslationRef(translateInterface);
  interfaceTranslationRef.current = translateInterface;

  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void fetch('/api/setup/readiness', { cache: 'no-store' }).then(async (response) => {
      const result = await response.json();
      if (!response.ok || result.ready !== true) throw new Error(result.error || interfaceTranslationRef.current("m49cb3312ae05"));
      if (active) onReady();
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : interfaceTranslationRef.current("m271f5f0219ba")); });
    return () => { active = false; };
  }, [attempt, onReady]);
  return <div className="mx-auto max-w-lg space-y-4">
    <h1 className="text-2xl font-semibold">{error ? translateInterface("m39d845bcc1d7") : translateInterface("m479bdd96f73a")}</h1>
    <p role={error ? 'alert' : 'status'} className="text-sm text-muted-foreground">{error || translateInterface("mf2ad191d4c91")}</p>
    {error && <Button onClick={() => { setError(''); setAttempt((value) => value + 1); }}>{translateInterface("m0fec9a1fb3fa")}</Button>}
  </div>;
}
