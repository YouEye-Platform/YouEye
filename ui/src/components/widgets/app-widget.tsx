"use client";

/**
 * App Widget — Plan 1 Workstream E5.
 *
 * Renders an app-provided dashboard widget through the ONE
 * <UnifiedEmbed kind="widget" fill> (origin-validated `youeye:ready/resize/action`,
 * lazy mount, timeout → fallback). `fill` makes the embed own 100% of the host
 * widget card (the card is the fixed box; the app paints inside it).
 *
 * Security: cross-origin iframe isolation + UnifiedEmbed origin validation prevent
 * a malicious app from reaching the parent DOM/session.
 */

import { useEffect, useState } from "react";
import { Loader2, AlertCircle } from "lucide-react";
import { UnifiedEmbed } from "@/components/embeds/unified-embed";

interface AppWidgetProps {
  settings?: Record<string, unknown>;
}

export function AppWidget({ settings }: AppWidgetProps) {
  const [embedUrl, setEmbedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const appId = settings?.appId as string;
  const widgetId = settings?.widgetId as string;

  useEffect(() => {
    if (!appId || !widgetId) {
      setError("Widget not configured");
      setLoading(false);
      return;
    }

    // Resolve the app's subdomain URL from the drawer/navigation data (UI API).
    fetch("/api/v1/apps/drawer")
      .then((r) => {
        if (!r.ok) throw new Error(`Failed: ${r.status}`);
        return r.json();
      })
      .then((data) => {
        const app = data.apps?.find(
          (a: { id: string; url?: string }) => a.id === appId
        );
        if (!app?.url) {
          setError("App not found");
          return;
        }

        // Must be http(s) — reject javascript:/data: injection.
        const url = app.url as string;
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
          setError("Invalid app URL");
          return;
        }

        setEmbedUrl(`${url}/embed/widget/${encodeURIComponent(widgetId)}`);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Failed to load widget");
      })
      .finally(() => setLoading(false));
  }, [appId, widgetId]);

  const errorView = (message: string) => (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-muted-foreground">
      <AlertCircle className="h-5 w-5" />
      <span className="text-center text-xs">{message}</span>
    </div>
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (error) return errorView(error);
  if (!embedUrl) return null;

  return (
    <UnifiedEmbed
      url={embedUrl}
      kind="widget"
      fill
      timeout={5000}
      title={`${appId} widget`}
      fallback={errorView("This widget couldn't load")}
      className="h-full w-full"
    />
  );
}
