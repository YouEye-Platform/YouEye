/**
 * Timeline Info Card
 *
 * Lazy-loads an app-declared info-card surface when the timeline entry becomes
 * visible. The host resolves URL triggers through the provider list, then renders
 * the matched app iframe through the one UnifiedEmbed protocol.
 */

"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { UnifiedEmbed } from "@/components/embeds/unified-embed";
import { cn } from "@/lib/utils";

type InfoCardSize = "compact" | "default" | "expanded";

interface InfoCardSurface {
  id: string;
  app_id: string;
  app_name: string;
  app_url: string | null;
  icon: string | null;
  surface_id: string;
  kind: string;
  placement: string;
  name: string;
  embed_path: string | null;
  triggers: string[];
}

interface InfoCardMatch {
  surface: InfoCardSurface;
  targetUrl: string;
}

interface TimelineInfoCardProps {
  targetUrl: string;
  size?: InfoCardSize;
  className?: string;
  fallback?: ReactNode;
}

let surfacesRequest: Promise<InfoCardSurface[]> | null = null;

function fetchInfoCardSurfaces(): Promise<InfoCardSurface[]> {
  if (!surfacesRequest) {
    surfacesRequest = fetch("/api/v1/apps/surfaces")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`${res.status}`))))
      .then((json) => (Array.isArray(json.surfaces) ? json.surfaces : []))
      .then((surfaces: InfoCardSurface[]) =>
        surfaces
          .filter((surface) => surface.kind === "info-card" && !!surface.embed_path)
          .map((surface) => ({
            ...surface,
            triggers: Array.isArray(surface.triggers) ? surface.triggers : [],
          }))
      )
      .catch((error) => {
        surfacesRequest = null;
        throw error;
      });
  }
  return surfacesRequest;
}

function normalizeNestedTarget(value: string): string {
  if (value.startsWith("/wiki/")) return `https://en.wikipedia.org${value}`;
  return value;
}

function normalizeInfoCardTargetUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return value;
  if (value.startsWith("/wiki/")) return normalizeNestedTarget(value);

  try {
    const parsed = new URL(
      value,
      typeof window !== "undefined" ? window.location.origin : undefined
    );
    const nestedUrl = parsed.searchParams.get("url");
    if (nestedUrl) return normalizeNestedTarget(nestedUrl);
  } catch {
    // Not a URL; leave it for trigger matching/fallback.
  }

  return value;
}

function findMatch(surfaces: InfoCardSurface[], targetUrl: string): InfoCardMatch | null {
  const normalized = targetUrl.toLowerCase();
  for (const surface of surfaces) {
    if (!surface.embed_path) continue;
    if (surface.triggers.some((trigger) => normalized.includes(trigger.toLowerCase()))) {
      return { surface, targetUrl };
    }
  }
  return null;
}

function buildEmbedUrl(match: InfoCardMatch, size: InfoCardSize): string | null {
  if (!match.surface.app_url || !match.surface.embed_path) return null;
  try {
    const url = new URL(match.surface.embed_path, match.surface.app_url);
    url.searchParams.set("url", match.targetUrl);
    url.searchParams.set("w", size === "expanded" ? "640" : "480");
    return url.toString();
  } catch {
    return null;
  }
}

function embedSize(size: InfoCardSize): { default: number; min: number; max: number } {
  if (size === "compact") return { default: 160, min: 72, max: 360 };
  if (size === "expanded") return { default: 360, min: 120, max: 720 };
  return { default: 240, min: 96, max: 520 };
}

function InfoCardSkeleton({ size = "default" }: { size?: InfoCardSize }) {
  return (
    <div className="flex gap-3 rounded-lg border bg-card p-3 animate-pulse">
      <div
        className={cn(
          "rounded bg-muted flex-shrink-0",
          size === "compact" ? "h-10 w-10" : "h-16 w-16"
        )}
      />
      <div className="flex-1 space-y-2">
        <div className="h-4 bg-muted rounded w-3/4" />
        {size !== "compact" && <div className="h-3 bg-muted rounded w-full" />}
        {size !== "compact" && <div className="h-3 bg-muted rounded w-1/2" />}
      </div>
    </div>
  );
}

export function TimelineInfoCard({
  targetUrl,
  size = "default",
  className,
  fallback = null,
}: TimelineInfoCardProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "none" | "error">("idle");
  const [match, setMatch] = useState<InfoCardMatch | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const normalizedTarget = useMemo(() => normalizeInfoCardTargetUrl(targetUrl), [targetUrl]);

  // IntersectionObserver: only fetch card data when element enters viewport
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px", threshold: 0 }
    );

    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible || !normalizedTarget) return;

    let alive = true;
    setStatus("loading");
    setMatch(null);

    fetchInfoCardSurfaces()
      .then((surfaces) => {
        if (!alive) return;
        const found = findMatch(surfaces, normalizedTarget);
        setMatch(found);
        setStatus(found ? "ready" : "none");
      })
      .catch(() => {
        if (!alive) return;
        setMatch(null);
        setStatus("error");
      });

    return () => {
      alive = false;
    };
  }, [isVisible, normalizedTarget]);

  const embedUrl = match ? buildEmbedUrl(match, size) : null;

  return (
    <div ref={containerRef} className={className}>
      {!isVisible && <InfoCardSkeleton size={size} />}
      {isVisible && status === "loading" && <InfoCardSkeleton size={size} />}
      {isVisible && status === "ready" && embedUrl && (
        <UnifiedEmbed
          url={embedUrl}
          kind="info-card"
          size={embedSize(size)}
          timeout={5000}
          title={`${match?.surface.app_name ?? "App"} info card`}
          fallback={fallback}
        />
      )}
      {isVisible && (status === "none" || status === "error" || (status === "ready" && !embedUrl)) && fallback}
    </div>
  );
}
