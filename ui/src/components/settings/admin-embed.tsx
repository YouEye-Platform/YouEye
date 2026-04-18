/**
 * AdminEmbed — iframes a CP embed page inside YE-UI settings.
 *
 * Handles:
 * - Auto-height via postMessage resize events
 * - Skeleton loader when CP is unavailable
 * - Origin validation on all messages
 * - Theme forwarding to the embed
 */

"use client";

import { useEffect, useRef, useState, useCallback } from "react";

const CP_ORIGIN = process.env.NEXT_PUBLIC_CP_ORIGIN || "https://control.devvm.test";

interface AdminEmbedProps {
  signedUrl: string;
  title?: string;
  minHeight?: number;
}

export function AdminEmbed({ signedUrl, title, minHeight = 200 }: AdminEmbedProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(minHeight);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  const handleMessage = useCallback(
    (e: MessageEvent) => {
      if (e.origin !== CP_ORIGIN) return;

      if (e.data?.type === "youeye-embed-ready" || e.data?.type === "youeye-embed-resize") {
        setReady(true);
        setError(false);
      }

      if (e.data?.type === "youeye-embed-resize" && typeof e.data.height === "number") {
        setHeight(Math.max(e.data.height, minHeight));
      }
    },
    [minHeight]
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!ready) setError(true);
    }, 8000);
    return () => clearTimeout(timeout);
  }, [ready]);

  const handleRetry = () => {
    setError(false);
    setReady(false);
    if (iframeRef.current) {
      iframeRef.current.src = signedUrl;
    }
  };

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
