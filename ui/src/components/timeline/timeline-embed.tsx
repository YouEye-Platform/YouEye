/**
 * Timeline Embed
 *
 * Renders a rich timeline entry card via iframe from the source app,
 * with lazy loading (IntersectionObserver) and fallback to a standard
 * card when the app is unavailable or the embed times out.
 *
 * The embed URL is constructed from the entry's embed_path + the app's
 * subdomain. The app renders the card using only URL params — no
 * server-side storage needed for the specific timeline entry.
 *
 * postMessage protocol:
 *   iframe → parent: { type: "youeye-embed-ready" }
 *   iframe → parent: { type: "youeye-embed-resize", height: number }
 */

"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Globe,
  Film,
  Camera,
  FileText,
  Search,
  Calendar,
  Star,
  Package,
  ExternalLink,
  AlertCircle,
} from "lucide-react";

// ─── Standard Card Fallback ──────────────────────────────────────────

interface StandardCardData {
  app_id: string;
  entry_type: string;
  title: string;
  timestamp: string;
  data: Record<string, unknown>;
  tags: Record<string, unknown>;
}

const APP_ICONS: Record<string, typeof Film> = {
  "ye-cinema": Film,
  "ye-search": Search,
  "ye-wiki": Globe,
  "ye-notes": FileText,
  "ye-photos": Camera,
  "ye-weather": Calendar,
  cinema: Film,
  search: Search,
  wiki: Globe,
  notes: FileText,
  photos: Camera,
};

const APP_COLORS: Record<string, string> = {
  "ye-cinema": "border-purple-500/40 bg-purple-500/5",
  "ye-search": "border-amber-500/40 bg-amber-500/5",
  "ye-wiki": "border-blue-500/40 bg-blue-500/5",
  "ye-notes": "border-emerald-500/40 bg-emerald-500/5",
  "ye-photos": "border-cyan-500/40 bg-cyan-500/5",
  cinema: "border-purple-500/40 bg-purple-500/5",
  search: "border-amber-500/40 bg-amber-500/5",
  wiki: "border-blue-500/40 bg-blue-500/5",
  notes: "border-emerald-500/40 bg-emerald-500/5",
  photos: "border-cyan-500/40 bg-cyan-500/5",
};

function StandardCard({ entry }: { entry: StandardCardData }) {
  const Icon = APP_ICONS[entry.app_id] ?? Package;
  const colorClass = APP_COLORS[entry.app_id] ?? "border-gray-500/40 bg-muted/30";
  const description = entry.data.description as string | undefined;
  const thumbnailUrl = entry.data.thumbnail_url as string | undefined;
  const url = entry.data.url as string | undefined;

  return (
    <div className={`flex gap-3 rounded-lg border p-3 ${colorClass}`}>
      {/* Thumbnail */}
      {thumbnailUrl && (
        <img
          src={thumbnailUrl}
          alt=""
          className="w-12 h-16 object-cover rounded flex-shrink-0"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      )}

      <div className="flex-1 min-w-0">
        {/* App badge + type */}
        <div className="flex items-center gap-1.5 mb-1">
          <Icon className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-[11px] text-muted-foreground capitalize">
            {entry.app_id.replace(/^ye-/, "")}
          </span>
          <span className="text-[11px] text-muted-foreground">·</span>
          <span className="text-[11px] text-muted-foreground">
            {entry.entry_type.replace(/^cinema-|^search-|^wiki-/, "").replace(/-/g, " ")}
          </span>
        </div>

        {/* Description */}
        {description && (
          <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
            {description}
          </p>
        )}

        {/* External link */}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline mt-1"
          >
            {new URL(url).hostname.replace("www.", "")}
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Embed Iframe ────────────────────────────────────────────────────

const EMBED_TIMEOUT_MS = 5000;
const EMBED_MAX_HEIGHT = 200;
const EMBED_MIN_HEIGHT = 48;

interface TimelineEmbedProps {
  entry: {
    app_id: string;
    entry_type: string;
    title: string;
    timestamp: string;
    embed_path?: string;
    tags: Record<string, unknown>;
    data: Record<string, unknown>;
  };
  /** Base domain for app subdomains (e.g. "devvm.test") */
  domain: string;
  className?: string;
}

export function TimelineEmbed({ entry, domain, className }: TimelineEmbedProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [embedReady, setEmbedReady] = useState(false);
  const [embedFailed, setEmbedFailed] = useState(false);
  const [embedHeight, setEmbedHeight] = useState(EMBED_MIN_HEIGHT);
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  // No embed_path → always show standard card
  if (!entry.embed_path) {
    return (
      <div className={className}>
        <StandardCard entry={entry} />
      </div>
    );
  }

  // Construct full embed URL
  const appSlug = entry.app_id.replace(/^ye-/, "");
  const embedUrl = `https://${appSlug}.${domain}${entry.embed_path}`;

  // IntersectionObserver: lazy-load iframe
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([obs]) => {
        if (obs.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px", threshold: 0 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // postMessage listener
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      // Only accept messages from our embed origin
      if (!embedUrl.startsWith(event.origin)) return;
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "youeye-embed-ready") {
        setEmbedReady(true);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
      }

      if (msg.type === "youeye-embed-resize" && typeof msg.height === "number") {
        setEmbedHeight(
          Math.min(Math.max(msg.height, EMBED_MIN_HEIGHT), EMBED_MAX_HEIGHT)
        );
      }
    },
    [embedUrl]
  );

  // Attach message listener + timeout when iframe becomes visible
  useEffect(() => {
    if (!isVisible) return;

    window.addEventListener("message", handleMessage);

    // Timeout: if embed doesn't signal ready, fall back to standard card
    timeoutRef.current = setTimeout(() => {
      if (!embedReady) {
        setEmbedFailed(true);
      }
    }, EMBED_TIMEOUT_MS);

    return () => {
      window.removeEventListener("message", handleMessage);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [isVisible, handleMessage, embedReady]);

  // Handle iframe load error
  const handleIframeError = () => {
    setEmbedFailed(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  };

  return (
    <div ref={containerRef} className={className}>
      {/* Skeleton while waiting for visibility or embed ready */}
      {!isVisible && (
        <div className="h-12 rounded-lg bg-muted/30 animate-pulse" />
      )}

      {isVisible && !embedFailed && (
        <>
          {/* Loading skeleton (shown until embed is ready) */}
          {!embedReady && (
            <div className="h-12 rounded-lg bg-muted/30 animate-pulse" />
          )}

          {/* Iframe — hidden until ready, shown on top when ready */}
          <iframe
            ref={iframeRef}
            src={embedUrl}
            sandbox="allow-scripts allow-same-origin"
            loading="lazy"
            onError={handleIframeError}
            className={`w-full border-0 rounded-lg transition-opacity duration-200 ${
              embedReady ? "opacity-100" : "opacity-0 absolute pointer-events-none"
            }`}
            style={{
              height: embedReady ? embedHeight : 0,
              background: "transparent",
              colorScheme: "normal",
            }}
          />
        </>
      )}

      {/* Fallback: standard card when embed fails */}
      {isVisible && embedFailed && <StandardCard entry={entry} />}
    </div>
  );
}
