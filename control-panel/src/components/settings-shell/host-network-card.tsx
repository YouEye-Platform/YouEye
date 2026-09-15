"use client";

import { useCallback, useEffect, useState } from "react";
import { Cable, Loader2, WifiOff } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { SpineHostNetworkStatus } from "@/lib/spine/client";

function phaseLabel(phase?: SpineHostNetworkStatus["phase"]) {
  switch (phase) {
    case "ready": return "Connected";
    case "needs_attention": return "Needs attention";
    case "checking": return "Checking";
    default: return "Starting";
  }
}

export function HostNetworkCard() {
  const [status, setStatus] = useState<SpineHostNetworkStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const response = await fetch("/settings/api/appliance/network", { cache: "no-store" });
    if (response.ok) setStatus(await response.json());
    else setError((await response.json().catch(() => ({}))).error || "Host network status is unavailable.");
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const healthy = status?.phase === "ready";
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start justify-between gap-4 border-b p-4">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold"><Cable className="size-4" />Host network</h2>
          <p className="mt-1 text-sm text-muted-foreground">The wired connection used while this server starts.</p>
        </div>
        {loading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <span className={`size-2 rounded-full ${healthy ? "bg-green-500" : "bg-amber-500"}`} />
            {phaseLabel(status?.phase)}
          </span>
        )}
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-3">
        <div><p className="text-xs text-muted-foreground">Adapter</p><p className="mt-1 text-sm font-medium">{status?.adapter || "Detecting"}</p></div>
        <div><p className="text-xs text-muted-foreground">IPv4</p><p className="mt-1 text-sm font-medium">{status?.ipv4_address || "Not assigned"}</p></div>
        <div><p className="text-xs text-muted-foreground">Configuration</p><p className="mt-1 text-sm font-medium">{status?.ipv4_mode === "static" ? "Static IPv4" : "Automatic (DHCP)"}</p></div>
      </div>
      <div className="space-y-2 border-t p-4 text-xs text-muted-foreground">
        {status?.detail && <p className={status.phase === "needs_attention" ? "text-destructive" : undefined}>{status.detail}</p>}
        {error && <p className="text-destructive">{error}</p>}
        <p className="flex items-start gap-2"><WifiOff className="mt-0.5 size-3.5 shrink-0" />Initial setup currently supports wired Ethernet and IPv4. Change or recover the host connection locally on the device.</p>
      </div>
    </Card>
  );
}
