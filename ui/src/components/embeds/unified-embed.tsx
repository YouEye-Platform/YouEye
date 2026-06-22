"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * UnifiedEmbed — Plan 1 Workstream E0: the ONE embed wrapper + protocol.
 *
 * Replaces the four divergent embed mechanisms (timeline-embed, notification-
 * surface-embed, app-widget, app-settings-detail). Every app surface — widgets,
 * info-cards, timeline-cards, notifications, settings-panels, launcher — renders
 * through this single component.
 *
 * Protocol (child -> parent postMessage), origin-validated against the app subdomain:
 *   { type: "youeye:ready" }
 *   { type: "youeye:resize", height }            // child debounces ~100ms
 *   { type: "youeye:action", action, data? }
 * Legacy message types (youeye-embed-ready/resize, youeye-card-ready,
 * youeye-app-settings-resize) are accepted for one release with a deprecation warning,
 * then removed.
 */

export type EmbedKind =
  | "widget"
  | "info-card"
  | "timeline-card"
  | "notification"
  | "settings-panel"
  | "launcher";

export interface UnifiedEmbedProps {
  /** Full embed URL on the app's own subdomain. Its origin is validated on every message. */
  url: string;
  kind: EmbedKind;
  /** px sizing. `default` is the initial height; `min`/`max` clamp resize messages. */
  size?: { default?: number; min?: number; max?: number };
  /** ms to wait for `youeye:ready` before showing the fallback (never silent). */
  timeout?: number;
  /**
   * Fill the parent instead of content-sizing. For fixed-size surfaces — dashboard
   * widgets (E5) — where the host card owns the box and the embed must be 100% tall;
   * `youeye:resize` height messages are ignored. Default false (content-height).
   */
  fill?: boolean;
  /** Rendered if the embed errors or times out. */
  fallback?: ReactNode;
  /** Token delivery — appended as ?theme & ?mode so the embed themes itself. */
  theme?: string;
  mode?: "light" | "dark";
  onReady?: () => void;
  onAction?: (action: string, data?: unknown) => void;
  onError?: (reason: "timeout" | "load-error") => void;
  className?: string;
  title?: string;
}

const LEGACY_READY = new Set(["youeye-embed-ready", "youeye-card-ready"]);
const LEGACY_RESIZE = new Set(["youeye-embed-resize", "youeye-app-settings-resize"]);

function buildSrc(url: string, theme?: string, mode?: "light" | "dark"): string {
  try {
    const u = new URL(url);
    if (theme) u.searchParams.set("theme", theme);
    if (mode) u.searchParams.set("mode", mode);
    return u.toString();
  } catch {
    return url;
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function UnifiedEmbed({
  url,
  kind,
  size,
  timeout = 5000,
  fill = false,
  fallback,
  theme,
  mode,
  onReady,
  onAction,
  onError,
  className,
  title,
}: UnifiedEmbedProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const reactId = useId();
  const [visible, setVisible] = useState(false); // lazy mount via IntersectionObserver
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState<number>(size?.default ?? 200);

  const expectedOrigin = originOf(url);
  const src = buildSrc(url, theme, mode);
  const markReady = useCallback(() => {
    setReady((wasReady) => {
      if (!wasReady) onReady?.();
      return true;
    });
  }, [onReady]);

  // Lazy: only load the iframe once it scrolls near the viewport.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  // Timeout -> fallback. Always surfaced, never silent.
  useEffect(() => {
    if (!visible || ready || failed) return;
    const t = setTimeout(() => {
      if (!ready) {
        setFailed(true);
        onError?.("timeout");
      }
    }, timeout);
    return () => clearTimeout(t);
  }, [visible, ready, failed, timeout, onError]);

  // The single message handler (new protocol + one-cycle legacy compat).
  useEffect(() => {
    if (!visible) return;
    const clampHeight = (h: number) => {
      const min = size?.min ?? 24;
      const max = size?.max ?? 1200;
      return Math.max(min, Math.min(max, h));
    };
    const handler = (event: MessageEvent) => {
      // Accept only messages from this embed's own iframe + registered origin.
      if (frameRef.current && event.source !== frameRef.current.contentWindow) return;
      if (expectedOrigin && event.origin !== expectedOrigin) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const type = (data as { type?: string }).type;
      if (!type) return;

      if (type === "youeye:ready" || LEGACY_READY.has(type)) {
        if (LEGACY_READY.has(type)) {
          console.warn(`[UnifiedEmbed] legacy ready message "${type}" — migrate to "youeye:ready"`);
        }
        markReady();
        return;
      }
      if (type === "youeye:resize" || LEGACY_RESIZE.has(type)) {
        if (LEGACY_RESIZE.has(type)) {
          console.warn(`[UnifiedEmbed] legacy resize message "${type}" — migrate to "youeye:resize"`);
        }
        // A resize means the embed has mounted and is running — treat it as ready.
        // Legacy surfaces (e.g. settings panels via `youeye-app-settings-resize`)
        // only ever send resize, never an explicit ready; without this they would
        // time out to the fallback even though they are alive.
        markReady();
        const h = Number((data as { height?: number }).height);
        if (Number.isFinite(h) && h > 0) setHeight(clampHeight(h));
        return;
      }
      if (type === "youeye:action") {
        const { action, data: payload } = data as { action?: string; data?: unknown };
        if (action) onAction?.(action, payload);
        return;
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [visible, expectedOrigin, size?.min, size?.max, markReady, onAction]);

  if (failed) {
    return (
      <div
        ref={containerRef}
        className={className}
        data-embed-kind={kind}
        data-embed-state="fallback"
        style={fill ? { height: "100%" } : undefined}
      >
        {fallback ?? null}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={className}
      data-embed-kind={kind}
      style={{ position: "relative", ...(fill ? { height: "100%" } : {}) }}
    >
      {visible && !ready && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 12,
            background: "color-mix(in srgb, currentColor 6%, transparent)",
          }}
        />
      )}
      {visible && (
        <iframe
          ref={frameRef}
          src={src}
          title={title ?? `${kind} embed`}
          aria-busy={!ready}
          onError={() => {
            setFailed(true);
            onError?.("load-error");
          }}
          onLoad={() => {
            if (kind === "widget") markReady();
          }}
          sandbox="allow-scripts allow-same-origin allow-forms"
          id={`embed-${reactId}`}
          style={{
            width: "100%",
            height: fill ? "100%" : height,
            border: "none",
            background: "transparent",
            display: "block",
            opacity: ready ? 1 : 0,
            transition: "opacity .2s ease",
          }}
        />
      )}
    </div>
  );
}

export default UnifiedEmbed;
