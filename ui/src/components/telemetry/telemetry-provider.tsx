/**
 * Telemetry Provider (Client-side)
 *
 * Tracks page views automatically on route changes.
 * Batches events and sends them to the server every 30 seconds.
 * Exposes trackFeature() and trackAppLaunch() for manual event tracking.
 *
 * Privacy: Only records route paths and feature IDs — no user data,
 * no personal information, no fingerprinting.
 *
 * This is temporary for private beta testing and will be removed.
 */

"use client";

import { useEffect, useRef, useCallback, createContext, useContext } from "react";
import { usePathname } from "next/navigation";

interface TelemetryEvent {
  type: "route" | "feature" | "app_launch" | "error";
  key: string;
  message?: string;
}

interface TelemetryContextValue {
  trackFeature: (featureId: string) => void;
  trackAppLaunch: (appSlug: string) => void;
}

const TelemetryContext = createContext<TelemetryContextValue>({
  trackFeature: () => {},
  trackAppLaunch: () => {},
});

export function useTelemetry() {
  return useContext(TelemetryContext);
}

const BATCH_INTERVAL_MS = 30_000; // 30 seconds
const ENDPOINT = "/api/v1/telemetry/record";

export function TelemetryProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const queueRef = useRef<TelemetryEvent[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Flush the event queue to the server
  const flush = useCallback(() => {
    if (queueRef.current.length === 0) return;

    const events = [...queueRef.current];
    queueRef.current = [];

    // Use sendBeacon for reliability (works even on page unload)
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, JSON.stringify({ events }));
    } else {
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
        keepalive: true,
      }).catch(() => {
        // Silent failure — telemetry is best-effort
      });
    }
  }, []);

  // Queue an event
  const enqueue = useCallback((event: TelemetryEvent) => {
    queueRef.current.push(event);
  }, []);

  // Track page views on route changes
  useEffect(() => {
    if (pathname) {
      enqueue({ type: "route", key: pathname });
    }
  }, [pathname, enqueue]);

  // Set up periodic flush and flush on unload
  useEffect(() => {
    timerRef.current = setInterval(flush, BATCH_INTERVAL_MS);

    const handleUnload = () => flush();
    window.addEventListener("beforeunload", handleUnload);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      window.removeEventListener("beforeunload", handleUnload);
      flush();
    };
  }, [flush]);

  const trackFeature = useCallback(
    (featureId: string) => enqueue({ type: "feature", key: featureId }),
    [enqueue]
  );

  const trackAppLaunch = useCallback(
    (appSlug: string) => enqueue({ type: "app_launch", key: appSlug }),
    [enqueue]
  );

  return (
    <TelemetryContext.Provider value={{ trackFeature, trackAppLaunch }}>
      {children}
    </TelemetryContext.Provider>
  );
}
