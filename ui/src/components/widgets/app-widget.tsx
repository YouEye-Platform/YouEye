"use client";

/**
 * App Widget — Iframe Embed
 *
 * Renders app-provided widgets inside a sandboxed iframe.
 * The iframe points to the app's /embed/widget/{widgetId} page,
 * which renders the widget content with the app's own styling.
 *
 * Security: Cross-origin iframe isolation prevents malicious apps
 * from accessing the parent page's DOM, cookies, or session.
 */

import { useEffect, useState } from "react";
import { Loader2, AlertCircle } from "lucide-react";

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

    // Look up app's subdomain URL from the drawer/navigation data
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

        // Validate URL — must be https:// to prevent javascript: or data: injection
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 p-3">
        <AlertCircle className="h-5 w-5" />
        <span className="text-xs text-center">{error}</span>
      </div>
    );
  }

  if (!embedUrl) return null;

  return (
    <iframe
      src={embedUrl}
      className="w-full h-full border-0"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      loading="lazy"
      style={{ background: "transparent", colorScheme: "normal" }}
      title={`${appId} widget`}
    />
  );
}
