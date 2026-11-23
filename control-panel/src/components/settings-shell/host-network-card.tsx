"use client";
import { useTranslations as useInterfaceTranslations } from "next-intl";


import { useCallback, useEffect, useState } from "react";
import { Cable, Loader2, WifiOff } from "lucide-react";
import type { SpineHostNetworkStatus } from "@/lib/spine/client";



export function HostNetworkCard() {
  const translateInterface = useInterfaceTranslations("interface");
function phaseLabel(phase?: SpineHostNetworkStatus["phase"]) {
  switch (phase) {
    case "ready": return translateInterface("m22965568d22a");
    case "needs_attention": return translateInterface("mc1ebc7817870");
    case "checking": return translateInterface("m0dfe1d63c9d8");
    default: return translateInterface("m0dfe1d63c9d8");
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
  const rows = [
    { label: translateInterface("m0252b8490103"), value: status?.adapter || translateInterface("m87504d17e5c1") },
    { label: "IPv4", value: status?.ipv4_address || translateInterface("m13075c233611") },
    { label: translateInterface("mb332c3492d5e"), value: status?.ipv4_mode === "static" ? translateInterface("m7e1077448b4c") : translateInterface("mdf7c8f177d2e") },
  ];
  return (
    <section>
      <div className="mb-2 flex items-start justify-between gap-4 px-1">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold"><Cable className="size-4 shrink-0" aria-hidden="true" />{translateInterface("m21496cdb9d67")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{translateInterface("me113781dfa0f")}</p>
        </div>
        {loading ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : (
          <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground" role="status">
            <span className={`size-2 rounded-full ${healthy ? "bg-green-500" : "bg-amber-500"}`} aria-hidden="true" />
            {phaseLabel(status?.phase)}
          </span>
        )}
      </div>
      <ul className="settings-group">
        {rows.map((row) => (
          <li key={row.label} className="flex min-h-12 items-center justify-between gap-4 px-4 py-2.5 text-[15px]">
            <span className="shrink-0 text-muted-foreground">{row.label}</span>
            <span className="min-w-0 break-all text-right font-medium tabular-nums">{row.value}</span>
          </li>
        ))}
      </ul>
      <div className="mt-2 space-y-1.5 px-1 text-xs text-muted-foreground">
        {status?.detail && <p className={status.phase === "needs_attention" ? "text-destructive" : undefined}>{status.detail}</p>}
        {error && <p className="text-destructive" role="alert">{error}</p>}
        <p className="flex items-start gap-2"><WifiOff className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{translateInterface("ma3f089766734")}</p>
      </div>
    </section>
  );
}
