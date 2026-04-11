/**
 * Widget Card
 *
 * Wrapper for individual widgets providing a styled container.
 * Renders the appropriate widget component from the registry.
 */

"use client";

import { WIDGET_REGISTRY } from "@/components/widgets";
import { useTranslations } from "next-intl";

interface WidgetCardProps {
  widgetType: string;
  settings?: Record<string, unknown>;
}

export function WidgetCard({ widgetType, settings }: WidgetCardProps) {
  const t = useTranslations('widgets');
  const Component = WIDGET_REGISTRY[widgetType];

  if (!Component) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('unknown', { type: widgetType })}
      </div>
    );
  }

  return <Component settings={settings} />;
}
