/**
 * Global App Install Listener
 *
 * Listens for postMessage events from the App Market embed (in CP iframe)
 * and shows toast notifications for app install progress/completion.
 * Polls the UI API proxy for progress when installs are active.
 * Visible on all pages — not just when App Market is open.
 */

"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { toast } from "sonner";
import { Download, CheckCircle2, XCircle } from "lucide-react";

interface TrackedInstall {
  appId: string;
  appName: string;
  toastId: string;
}

interface PollInstall {
  appId: string;
  appName: string;
  done: boolean;
  error?: string;
  events: Array<{
    step: number;
    totalSteps: number;
    status: string;
    message: string;
  }>;
}

export function AppInstallListener() {
  const [tracked, setTracked] = useState<TrackedInstall[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const pollProgress = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/admin/install-progress");
      if (!res.ok) return;
      const data = await res.json();
      const installs: PollInstall[] = data.installs ?? [];

      setTracked((prev) => {
        const updated = [...prev];
        for (const t of updated) {
          const match = installs.find((i) => i.appId === t.appId);
          if (match) {
            const last = match.events?.[match.events.length - 1];
            const pct = last
              ? Math.round(
                  (last.step / Math.max(last.totalSteps, 1)) * 100
                )
              : 0;

            if (match.done) {
              if (match.error) {
                toast.error(`${t.appName} install failed`, {
                  id: t.toastId,
                  description: match.error,
                  icon: <XCircle className="w-4 h-4" />,
                });
              } else {
                toast.success(`${t.appName} installed`, {
                  id: t.toastId,
                  icon: <CheckCircle2 className="w-4 h-4" />,
                });
              }
            } else {
              toast.loading(
                `Installing ${t.appName}... ${pct}%`,
                {
                  id: t.toastId,
                  description: last?.message || "Starting...",
                  icon: <Download className="w-4 h-4" />,
                }
              );
            }
          }
        }
        // Remove completed installs after a delay
        const active = installs.filter((i) => !i.done);
        if (active.length === 0) {
          // All done — clear tracked after toast shows
          setTimeout(() => setTracked([]), 3000);
        }
        return updated;
      });

      // Stop polling if no active installs
      const active = installs.filter((i: PollInstall) => !i.done);
      if (active.length === 0) {
        stopPolling();
      }
    } catch {
      // Network error — keep polling
    }
  }, [stopPolling]);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(pollProgress, 3000);
    // Immediate first poll
    pollProgress();
  }, [pollProgress]);

  // Listen for postMessages from App Market embed
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === "youeye-app-install-started") {
        const { appId, appName } = e.data;
        const toastId = `install-${appId}`;

        toast.loading(`Installing ${appName}...`, {
          id: toastId,
          description: "Starting installation...",
          icon: <Download className="w-4 h-4" />,
          duration: Infinity,
        });

        setTracked((prev) => {
          if (prev.some((t) => t.appId === appId)) return prev;
          return [...prev, { appId, appName, toastId }];
        });

        startPolling();
      }

      if (e.data?.type === "youeye-app-install-complete") {
        const { appId, appName, error } = e.data;
        const toastId = `install-${appId}`;

        if (error) {
          toast.error(`${appName} install failed`, {
            id: toastId,
            description: error,
            icon: <XCircle className="w-4 h-4" />,
          });
        } else {
          toast.success(`${appName} installed`, {
            id: toastId,
            icon: <CheckCircle2 className="w-4 h-4" />,
          });
        }

        setTracked((prev) => prev.filter((t) => t.appId !== appId));
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [startPolling]);

  // On mount, check for any active installs (handles page refresh)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/v1/admin/install-progress");
        if (!res.ok) return;
        const data = await res.json();
        const active: PollInstall[] = (data.installs ?? []).filter(
          (i: PollInstall) => !i.done
        );
        if (active.length > 0) {
          const newTracked = active.map((i) => ({
            appId: i.appId,
            appName: i.appName,
            toastId: `install-${i.appId}`,
          }));
          setTracked(newTracked);
          for (const t of newTracked) {
            toast.loading(`Installing ${t.appName}...`, {
              id: t.toastId,
              description: "In progress...",
              icon: <Download className="w-4 h-4" />,
              duration: Infinity,
            });
          }
          startPolling();
        }
      } catch {
        // No active installs or API unavailable
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  return null;
}
