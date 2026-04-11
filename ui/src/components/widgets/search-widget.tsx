/**
 * Search Widget — shadcn styled
 */

"use client";

import { useTranslations } from "next-intl";
import { Search } from "lucide-react";

interface SearchWidgetProps {
  settings?: { engine?: string };
}

const ENGINES: Record<string, { url: string; param: string }> = {
  google: { url: "https://www.google.com/search", param: "q" },
  duckduckgo: { url: "https://duckduckgo.com/", param: "q" },
  bing: { url: "https://www.bing.com/search", param: "q" },
};

export function SearchWidget({ settings }: SearchWidgetProps) {
  const t = useTranslations("widgets");
  const engine = settings?.engine || "google";
  const { url, param } = ENGINES[engine] ?? ENGINES.google;

  return (
    <div className="flex h-full items-center justify-center px-2">
      <form
        action={url}
        method="GET"
        target="_blank"
        className="flex w-full max-w-lg items-center gap-2 rounded-lg border border-border/60 bg-background/50 px-3 py-2 shadow-sm transition-all focus-within:border-primary focus-within:ring-1 focus-within:ring-ring"
      >
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          type="text"
          name={param}
          placeholder={t("searchPlaceholder")}
          autoComplete="off"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
        />
      </form>
    </div>
  );
}
