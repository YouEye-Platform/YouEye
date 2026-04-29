"use client";

import { useEffect, useRef, useCallback } from "react";

/**
 * Hidden iframe client that bridges update commands between YE-UI and CP.
 *
 * Polls /api/apps/queue for status and posts changes to parent.
 * Handles start-update, check-updates, get-status, acknowledge commands.
 */
export function UpdateProgressClient() {
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastStatusRef = useRef<string>("");

  const fetchAndPostStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/apps/queue");
      if (!res.ok) return;
      const data = await res.json();
      const entries = data.entries ?? [];

      // Only post if status changed (avoid flooding parent)
      const statusKey = JSON.stringify(entries.map((e: { id: number; status: string; progress: number }) => `${e.id}:${e.status}:${e.progress}`));
      if (statusKey === lastStatusRef.current) return;
      lastStatusRef.current = statusKey;

      window.parent.postMessage({
        type: "update-status",
        entries,
        timestamp: new Date().toISOString(),
      }, "*");
    } catch {
      // silently retry on next poll
    }
  }, []);

  const handleMessage = useCallback(async (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== "object" || !data.type) return;

    switch (data.type) {
      case "start-update": {
        if (!data.component) return;
        try {
          const res = await fetch(`/api/apps/${encodeURIComponent(data.component)}/enqueue`, {
            method: "POST",
          });
          const result = await res.json();
          window.parent.postMessage({
            type: "update-enqueued",
            component: data.component,
            entry: result.entry,
            position: result.position,
            alreadyQueued: result.alreadyQueued,
          }, "*");
          // Immediately fetch fresh status
          fetchAndPostStatus();
          // Switch to fast polling
          startFastPolling();
        } catch (err) {
          window.parent.postMessage({
            type: "error",
            message: `Failed to enqueue ${data.component}: ${err instanceof Error ? err.message : String(err)}`,
          }, "*");
        }
        break;
      }

      case "check-updates": {
        try {
          await fetch("/api/apps/check-updates", { method: "POST" });
          window.parent.postMessage({ type: "check-updates-started" }, "*");
        } catch (err) {
          window.parent.postMessage({
            type: "error",
            message: `Check updates failed: ${err instanceof Error ? err.message : String(err)}`,
          }, "*");
        }
        break;
      }

      case "get-status": {
        fetchAndPostStatus();
        break;
      }

      case "acknowledge": {
        if (!data.id) return;
        try {
          await fetch("/api/apps/queue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: data.id }),
          });
          fetchAndPostStatus();
        } catch {
          // silent
        }
        break;
      }
    }
  }, [fetchAndPostStatus]);

  const startFastPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(fetchAndPostStatus, 2000);
  }, [fetchAndPostStatus]);

  const startSlowPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(fetchAndPostStatus, 30000);
  }, [fetchAndPostStatus]);

  useEffect(() => {
    window.addEventListener("message", handleMessage);

    // Initial status fetch + signal ready
    fetchAndPostStatus().then(() => {
      window.parent.postMessage({ type: "youeye-embed-ready" }, "*");
    });

    // Start with slow polling; switches to fast when updates are active
    startSlowPolling();

    return () => {
      window.removeEventListener("message", handleMessage);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [handleMessage, fetchAndPostStatus, startSlowPolling]);

  // Monitor entries and adjust polling speed
  useEffect(() => {
    const checkPollSpeed = () => {
      const status = lastStatusRef.current;
      const hasActive = status.includes(":pending:") || status.includes(":running:");
      if (hasActive) {
        startFastPolling();
      } else {
        startSlowPolling();
      }
    };

    // Check every time status changes
    const interval = setInterval(checkPollSpeed, 5000);
    return () => clearInterval(interval);
  }, [startFastPolling, startSlowPolling]);

  // Render nothing — this is a hidden iframe
  return null;
}
