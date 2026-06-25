/**
 * Telemetry Export Card
 *
 * Allows admins to download the anonymous usage report
 * for sharing with the development team.
 */

"use client";

import { useState } from "react";
import { Download, RotateCcw, FileJson } from "lucide-react";

export function TelemetryExport() {
  const [resetting, setResetting] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  const handleDownload = () => {
    // Trigger file download via the export endpoint
    window.location.href = "/api/v1/telemetry/export";
  };

  const handleReset = async () => {
    if (!confirm("Reset all usage data? This cannot be undone.")) return;

    setResetting(true);
    try {
      await fetch("/api/v1/telemetry/export", { method: "DELETE" });
      setResetDone(true);
      setTimeout(() => setResetDone(false), 3000);
    } catch {
      // Silent
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="rounded-lg border bg-card p-6 space-y-4">
      <div className="flex items-start gap-3">
        <FileJson className="w-5 h-5 text-primary mt-0.5" />
        <div className="flex-1">
          <h3 className="font-semibold">Usage Report</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Download anonymous usage data showing which features and pages are
            being used. This helps the development team identify unused code and
            improve the platform. No personal data is included.
          </p>
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <button
          onClick={handleDownload}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Download className="w-4 h-4" />
          Download Report
        </button>

        <button
          onClick={handleReset}
          disabled={resetting}
          className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-50"
        >
          <RotateCcw className={`w-4 h-4 ${resetting ? "animate-spin" : ""}`} />
          {resetDone ? "Reset!" : "Reset Data"}
        </button>
      </div>

      <p className="text-xs text-muted-foreground">
        Data includes: page visit counts, feature usage counts, app launch counts,
        and error summaries. No usernames, IPs, or personal information is recorded.
      </p>
    </div>
  );
}
