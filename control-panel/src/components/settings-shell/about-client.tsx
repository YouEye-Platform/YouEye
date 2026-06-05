"use client";

import { useState } from "react";
import { Download, FileJson, RotateCcw } from "lucide-react";

export function AboutClient() {
  const [resetting, setResetting] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  function download() {
    window.location.href = "/api/telemetry/export";
  }

  async function reset() {
    if (!confirm("Reset all usage data? This cannot be undone.")) return;
    setResetting(true);
    await fetch("/api/telemetry/export", { method: "DELETE" }).catch(() => {});
    setResetting(false);
    setResetDone(true);
    setTimeout(() => setResetDone(false), 2500);
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">About & Usage</h2>
        <p className="mt-1 text-muted-foreground">Platform info and anonymous usage data for beta testing.</p>
      </div>
      <div className="space-y-4 rounded-lg border bg-card p-6">
        <div className="flex items-start gap-3">
          <FileJson className="mt-0.5 h-5 w-5 text-primary" />
          <div className="flex-1">
            <h3 className="font-semibold">Usage Report</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Download anonymous usage data showing which Control Panel features and pages are being used.
            </p>
          </div>
        </div>
        <div className="flex gap-3 pt-2">
          <button onClick={download} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            <Download className="h-4 w-4" />Download Report
          </button>
          <button onClick={reset} disabled={resetting} className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground disabled:opacity-50">
            <RotateCcw className={`h-4 w-4 ${resetting ? "animate-spin" : ""}`} />{resetDone ? "Reset!" : "Reset Data"}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Data includes page visit counts, feature usage counts, and error summaries. No usernames, IPs, or personal information are included.
        </p>
      </div>
    </div>
  );
}
