"use client";



import { useTranslations as useInterfaceTranslations } from "next-intl";
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

interface WidgetSurface {
  app_id: string;
  surface_id: string;
  kind: string;
  placement: string;
  app_url: string | null;
  embed_path: string;
}

export function AppWidget({ settings }: AppWidgetProps) {
  const translateInterface = useInterfaceTranslations("interface");

  const [embedUrl, setEmbedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const appId = settings?.appId as string;
  const widgetId = settings?.widgetId as string;

  useEffect(() => {
    if (!appId || !widgetId) {
      setError(translateInterface("mddd22ce6fc47"));
      setLoading(false);
      return;
    }

    fetch("/api/v1/apps/surfaces")
      .then((r) => {
        if (!r.ok) throw new Error(`Failed: ${r.status}`);
        return r.json();
      })
      .then((data) => {
        const surfaces = Array.isArray(data.surfaces) ? data.surfaces as WidgetSurface[] : [];
        const surface = surfaces.find(
          (item) =>
            item.kind === "widget" &&
            item.placement === "dashboard" &&
            item.app_id === appId &&
            item.surface_id === widgetId
        );
        if (!surface?.app_url || !surface.embed_path) {
          setError(translateInterface("mce2fa0d974db"));
          return;
        }

        const url = new URL(surface.embed_path, surface.app_url).toString();
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
          setError(translateInterface("m4ef86e93324a"));
          return;
        }

        setEmbedUrl(url);
      })
      .catch((e) => {
        setError(translateInterface("m606622c8aed7"));
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
      title={translateInterface("m55403f68eb28", { value0: String(appId) })}
      fallback={errorView(translateInterface("m5721644b8ec7"))}
      className="h-full w-full"
    />
  );
}
