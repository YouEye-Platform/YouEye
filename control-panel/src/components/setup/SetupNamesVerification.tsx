'use client';

import { useState, useRef, useEffect } from 'react';
import { useTranslations as useInterfaceTranslations } from "next-intl";
import { ArrowLeft, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { bindVerifiedSetupChannel, requestVerifiedSetupChallenge } from '@/lib/youeye-names/verified-setup-channel';
import type { VerifiedSetupChallenge } from '@/lib/youeye-names/verified-setup-contract';
import { runNamesEnrollment } from '@/lib/youeye-names/popup';
import { randomBrowserUUID } from '@/lib/browser-random';

export default function SetupNamesVerification({
  name,
  fqdn,
  onVerified,
  onBack,
  useVerifiedSetup = false,
}: {
  name: string;
  fqdn: string;
  onVerified: (proof: string, kind?: "verified_setup") => void;
  useVerifiedSetup?: boolean;
  onBack: () => void;
}) {
  const translateInterface = useInterfaceTranslations("interface");

  const verifiedText = useInterfaceTranslations("setup.verifiedNames");
  const [challenge,setChallenge]=useState<VerifiedSetupChallenge|null>(null);
  const [channelState,setChannelState]=useState<"waiting"|"challenge"|"blocked"|"expired">("waiting");
  const [standalone,setStandalone]=useState(false);
  const [pasted,setPasted]=useState("");
  const frame=useRef<HTMLIFrameElement|null>(null);
  const channel=useRef<ReturnType<typeof bindVerifiedSetupChannel>|null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const verification = useRef<AbortController | null>(null);
  const verifiedCallback=useRef(onVerified);
  verifiedCallback.current=onVerified;
  useEffect(() => { setChallenge(null);setPasted('');setError('');setLoading(false);return () => { verification.current?.abort();channel.current?.dispose(); }; }, [name, fqdn,useVerifiedSetup]);
  useEffect(()=>{
    if(!challenge || !verification.current || verification.current.signal.aborted)return;
    try {
      const bound=bindVerifiedSetupChannel(challenge,{frameWindow:()=>frame.current?.contentWindow??null,signal:verification.current.signal,
        accept:credential=>verifiedCallback.current(credential,"verified_setup"),state:next=>{setChannelState(next);if(next==="challenge")frame.current?.focus();}});
      channel.current=bound;
      return ()=>{bound.dispose();if(channel.current===bound)channel.current=null;};
    } catch { setChannelState("expired"); }
  },[challenge]);

  const verify = async () => {
    if (verification.current) { if(!useVerifiedSetup || loading)return; verification.current.abort();channel.current?.dispose();setChallenge(null); }
    const controller = new AbortController();
    verification.current = controller;
    setLoading(true);
    setError(''); setPasted('');setStandalone(false);setChannelState('waiting');
    try {
      if(useVerifiedSetup) {
        const issued=await requestVerifiedSetupChallenge(name,randomBrowserUUID(),controller.signal);
        if(!controller.signal.aborted)setChallenge(issued);
        return;
      }
      let accepted = '';
      await runNamesEnrollment('lease_claim', {
        name,
        signal: controller.signal,
        accept: (proof) => { accepted = proof; },
      });
      if (!accepted) throw new Error(translateInterface("m7e53f14e46f0"));
      if (!controller.signal.aborted) onVerified(accepted);
    } catch (reason) {
      if(!controller.signal.aborted)setError(useVerifiedSetup ? verifiedText("failed") : translateInterface("meccb34acb8a7"));
    } finally {
      if(!useVerifiedSetup && verification.current===controller)verification.current=null;
      if(!controller.signal.aborted)setLoading(false);
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
        {useVerifiedSetup ? verifiedText("explanation") : translateInterface("m9df877e8ce4b")}</p>

      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-blue-500" />
          <span className="text-sm font-medium">{translateInterface("m4377586214cd")}</span>
        </div>
        <p className="mt-3 truncate font-mono text-sm" title={fqdn}>{fqdn}</p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {translateInterface("m3460df24b0cd")}</p>
      </div>

      {challenge && useVerifiedSetup && <div className="space-y-3">
        <p role="status" className="text-sm text-muted-foreground">{verifiedText(channelState)}</p>
        {!standalone && channelState!=="expired" && <iframe ref={frame} src={challenge.embeddedEnrollmentUrl} title={verifiedText("frameTitle")} referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" className="min-h-80 w-full rounded-lg border bg-background" />}
        {channelState!=="expired" && <div className="space-y-3">
          <Button type="button" variant="outline" className="min-h-11 w-full" onClick={()=>{if(channel.current?.openStandalone()){setStandalone(true);setChannelState("challenge");}else setChannelState("blocked");}}>{verifiedText("openPage")}</Button>
          <details className="text-sm">
            <summary className="cursor-pointer py-2">{verifiedText("manualFallback")}</summary>
            <div className="space-y-3 pt-2">
              <p className="text-muted-foreground">{verifiedText("pasteHelp")}</p>
              <a href={challenge.enrollmentUrl} target="_blank" rel="noreferrer" className="inline-block min-h-11 py-3 underline">{verifiedText("openPage")}</a>
              <label className="block space-y-2"><span>{verifiedText("verificationCode")}</span><textarea value={pasted} onChange={event=>setPasted(event.target.value)} autoComplete="off" spellCheck={false} maxLength={8192} className="min-h-24 w-full rounded-md border bg-background p-2 font-mono text-sm" /></label>
              <Button type="button" onClick={()=>{if(!channel.current?.acceptPasted(pasted))setError(verifiedText("invalidCode"));}} disabled={!pasted.trim()}>{verifiedText("useCode")}</Button>
            </div>
          </details>
        </div>}
      </div>}

      {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={()=>{verification.current?.abort();channel.current?.dispose();onBack();}} className="gap-2">
          <ArrowLeft className="h-4 w-4" /> {" "}{translateInterface("m76900f1bfd16")}</Button>
        <Button onClick={() => void verify()} disabled={loading} className="gap-2">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          {loading ? translateInterface("m2b69f6c546fd") : challenge ? verifiedText("retry") : translateInterface("m637845e0d3dc")}
        </Button>
      </div>
    </div>
  );
}
