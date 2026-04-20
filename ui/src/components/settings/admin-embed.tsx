"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useTheme } from "next-themes";

const HEALTH_POLL_INTERVAL = 5000;

function getCpOrigin(signedUrl: string): string {
  try {
    return new URL(signedUrl).origin;
  } catch {
    return '';
  }
}

interface AdminEmbedProps {
  signedUrl: string;
  title?: string;
  minHeight?: number;
}

export function AdminEmbed({ signedUrl, title, minHeight = 200 }: AdminEmbedProps) {
  const cpOrigin = getCpOrigin(signedUrl);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const healthRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [height, setHeight] = useState(minHeight);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [restarting, setRestarting] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();

  const sendThemeToEmbed = useCallback(() => {
    if (!iframeRef.current?.contentWindow || !resolvedTheme) return;
    iframeRef.current.contentWindow.postMessage(
      { type: "youeye-embed-theme", theme: resolvedTheme },
      cpOrigin
    );
  }, [resolvedTheme]);

  const stopHealthPoll = useCallback(() => {
    if (healthRef.current) {
      clearInterval(healthRef.current);
      healthRef.current = null;
    }
  }, []);

  const startHealthPoll = useCallback(() => {
    stopHealthPoll();
    healthRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${cpOrigin}/embed/health`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          stopHealthPoll();
          setRestarting(null);
          setReady(false);
          setError(false);
          if (iframeRef.current) {
            const url = new URL(signedUrl);
            url.searchParams.set("ts", String(Math.floor(Date.now() / 1000)));
            iframeRef.current.src = signedUrl;
          }
        }
      } catch { /* still down */ }
    }, HEALTH_POLL_INTERVAL);
  }, [signedUrl, stopHealthPoll]);

  const handleMessage = useCallback(
    (e: MessageEvent) => {
      if (e.origin !== cpOrigin) return;

      if (e.data?.type === "youeye-embed-ready" || e.data?.type === "youeye-embed-resize") {
        setReady(true);
        setError(false);
        sendThemeToEmbed();
      }

      if (e.data?.type === "youeye-embed-resize" && typeof e.data.height === "number") {
        setHeight(Math.max(e.data.height, minHeight));
      }

      if (e.data?.type === "youeye-embed-action") {
        const action = e.data.action as string;
        if (action === "cp-restarting") {
          setRestarting("Control Panel");
          startHealthPoll();
        } else if (action === "ui-restarting") {
          setRestarting("YouEye UI");
        }
      }
    },
    [minHeight, startHealthPoll, sendThemeToEmbed]
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      stopHealthPoll();
    };
  }, [handleMessage, stopHealthPoll]);

  useEffect(() => {
    if (ready) sendThemeToEmbed();
  }, [resolvedTheme, ready, sendThemeToEmbed]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!ready && !restarting) setError(true);
    }, 8000);
    return () => clearTimeout(timeout);
  }, [ready, restarting]);

  const handleRetry = () => {
    setError(false);
    setReady(false);
    if (iframeRef.current) {
      iframeRef.current.src = signedUrl;
    }
  };

  if (restarting) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-3 py-16 rounded-lg border border-border bg-background"
        style={{ minHeight }}
      >
        <div className="h-6 w-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        <p className="text-sm font-medium">{restarting} is restarting...</p>
        <p className="text-xs text-muted-foreground">
          This page will reload automatically when the service is back online.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-3 py-12 rounded-lg border border-border"
        style={{ minHeight }}
      >
        <p className="text-sm text-muted-foreground">
          Control Panel is not responding.
        </p>
        <button
          onClick={handleRetry}
          className="text-sm px-3 py-1.5 rounded-md border border-border bg-background hover:bg-accent transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      {!ready && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center rounded-lg border border-border bg-background"
          style={{ minHeight }}
        >
          <div className="space-y-3 w-full max-w-md px-8">
            <div className="h-4 w-3/4 rounded bg-muted animate-pulse" />
            <div className="h-4 w-full rounded bg-muted animate-pulse" />
            <div className="h-4 w-1/2 rounded bg-muted animate-pulse" />
          </div>
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={signedUrl}
        title={title || "Admin Settings"}
        sandbox="allow-scripts allow-same-origin allow-forms"
        style={{
          width: "100%",
          height,
          border: "none",
          borderRadius: 8,
          opacity: ready ? 1 : 0,
          transition: "opacity 0.2s ease",
        }}
      />
    </div>
  );
}
