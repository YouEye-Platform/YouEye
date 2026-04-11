/**
 * Update Overlay
 *
 * Shows a full-screen overlay when CP or UI is restarting during a self-update.
 * Polls the health endpoint and auto-dismisses when the service is back.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Check } from "lucide-react";

interface UpdateOverlayProps {
  /** Which component is restarting */
  component: "control" | "ui";
  /** Called when the service comes back online */
  onReconnected: () => void;
  /** Called to dismiss the overlay */
  onDismiss: () => void;
}

export function UpdateOverlay({ component, onReconnected, onDismiss }: UpdateOverlayProps) {
  const [status, setStatus] = useState<"waiting" | "reconnected">("waiting");
  const [dots, setDots] = useState("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dotsRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const label = component === "control" ? "Control Panel" : "YouEye UI";

  useEffect(() => {
    // Animated dots
    dotsRef.current = setInterval(() => {
      setDots(prev => prev.length >= 3 ? "" : prev + ".");
    }, 500);

    // Poll health endpoint
    const pollHealth = async () => {
      try {
        // For CP: poll the bridge from UI side
        // For UI: poll our own health endpoint
        const url = component === "control"
          ? "/api/admin/system"
          : "/api/health";

        const res = await fetch(url, { cache: "no-store" });
        if (res.ok || res.status === 401) {
          setStatus("reconnected");
          if (intervalRef.current) clearInterval(intervalRef.current);
          onReconnected();
          // Auto-dismiss after showing success for 2 seconds
          setTimeout(onDismiss, 2000);
        }
      } catch {
        // Still down, keep polling
      }
    };

    // Wait 5 seconds before starting to poll (give it time to go down)
    const startTimeout = setTimeout(() => {
      intervalRef.current = setInterval(pollHealth, 3000);
    }, 5000);

    return () => {
      clearTimeout(startTimeout);
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (dotsRef.current) clearInterval(dotsRef.current);
    };
  }, [component, onReconnected, onDismiss]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="text-center space-y-4 p-8 rounded-xl bg-card border shadow-lg max-w-md">
        {status === "waiting" ? (
          <>
            <Loader2 className="h-10 w-10 animate-spin text-primary mx-auto" />
            <h2 className="text-lg font-semibold">
              {label} is restarting{dots}
            </h2>
            <p className="text-sm text-muted-foreground">
              This usually takes 15-30 seconds. The page will reconnect automatically.
            </p>
          </>
        ) : (
          <>
            <Check className="h-10 w-10 text-green-600 mx-auto" />
            <h2 className="text-lg font-semibold text-green-700">
              {label} is back online
            </h2>
          </>
        )}
      </div>
    </div>
  );
}
