"use client";
import { useTranslations as useInterfaceTranslations } from "next-intl";


import { useCallback, useEffect, useState } from "react";
import { Cable, Loader2, WifiOff } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { SpineHostNetworkStatus } from "@/lib/spine/client";



export function HostNetworkCard() {
  const translateInterface = useInterfaceTranslations("interface");
function phaseLabel(phase?: SpineHostNetworkStatus["phase"]) {
  switch (phase) {
    case "ready": return translateInterface("m22965568d22a");
    case "needs_attention": return translateInterface("mc1ebc7817870");
    case "checking": return translateInterface("m0dfe1d63c9d8");
    default: return "Starting";
  }
}


  const [status, setStatus] = useState<SpineHostNetworkStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const response = await fetch("/settings/api/appliance/network", { cache: "no-store" });
    if (response.ok) setStatus(await response.json());
    else setError((await response.json().catch(() => ({}))).error || translateInterface("m0cdc63b6ff5f"));
    setLoading(false);
  }, [translateInterface]);

  useEffect(() => { load(); }, [load]);

  const healthy = status?.phase === "ready";
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start justify-between gap-4 border-b p-4">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold"><Cable className="size-4" />{translateInterface("m21496cdb9d67")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{translateInterface("me113781dfa0f")}</p>
        </div>
        {loading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <span className={`size-2 rounded-full ${healthy ? "bg-green-500" : "bg-amber-500"}`} />
            {phaseLabel(status?.phase)}
          </span>
        )}
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-3">
        <div><p className="text-xs text-muted-foreground">{translateInterface("m0252b8490103")}</p><p className="mt-1 text-sm font-medium">{status?.adapter || translateInterface("m87504d17e5c1")}</p></div>
        <div><p className="text-xs text-muted-foreground">IPv4</p><p className="mt-1 text-sm font-medium">{status?.ipv4_address || translateInterface("m13075c233611")}</p></div>
        <div><p className="text-xs text-muted-foreground">{translateInterface("mb332c3492d5e")}</p><p className="mt-1 text-sm font-medium">{status?.ipv4_mode === "static" ? translateInterface("m7e1077448b4c") : translateInterface("mdf7c8f177d2e")}</p></div>
      </div>
      <div className="space-y-2 border-t p-4 text-xs text-muted-foreground">
        {status?.detail && <p className={status.phase === "needs_attention" ? "text-destructive" : undefined}>{status.detail}</p>}
        {error && <p className="text-destructive">{error}</p>}
        <p className="flex items-start gap-2"><WifiOff className="mt-0.5 size-3.5 shrink-0" />{translateInterface("ma3f089766734")}</p>
      </div>
    </Card>
  );
}
