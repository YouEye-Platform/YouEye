/**
 * App Drawer — 9-dot grid Popover with 4-column icon grid
 *
 * Shows installed apps in a compact grid. Apps that are unhealthy/down
 * appear greyed out and dimmed. Clicking navigates to the app.
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Settings,
  Search,
  BookOpen,
  StickyNote,
  Film,
  CloudSun,
  Languages,
  Package,
  Camera,
  MessageCircle,
} from "lucide-react";
import type { ComponentType } from "react";

function DotsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      {[4, 12, 20].map((cy) =>
        [4, 12, 20].map((cx) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2" />
        ))
      )}
    </svg>
  );
}
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTranslations } from "next-intl";
import Link from "next/link";

interface DrawerApp {
  id: string;
  name: string;
  original_name: string;
  icon: string | null;
  custom_icon_url: string | null;
  visible: boolean;
  order: number;
  section_id: string | null;
  status: string | null;
  url: string | null;
}

/** Map of Lucide icon names to components for native apps */
const ICON_MAP: Record<string, ComponentType<{ className?: string }>> = {
  search: Search,
  "book-open": BookOpen,
  "sticky-note": StickyNote,
  film: Film,
  "cloud-sun": CloudSun,
  languages: Languages,
  camera: Camera,
  "message-circle": MessageCircle,
  package: Package,
};

/** Convert PascalCase (e.g. "StickyNote") to kebab-case ("sticky-note") */
function toKebabCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** Renders the correct icon: custom URL > emoji > icon URL > Lucide name > fallback letter */
function AppIcon({
  icon,
  customIconUrl,
  name,
  className = "w-10 h-10",
}: {
  icon: string | null;
  customIconUrl: string | null;
  name: string;
  className?: string;
}) {
  // 1. Custom uploaded icon URL
  if (customIconUrl) {
    return (
      <img
        src={customIconUrl}
        alt={name}
        className={`${className} rounded-xl object-cover`}
      />
    );
  }
  // 2. Emoji icon (stored as "emoji:🎬")
  if (icon && icon.startsWith("emoji:")) {
    return (
      <span className="text-xl leading-none">{icon.slice(6)}</span>
    );
  }
  // 3. HTTP/path URL icon
  if (icon && (icon.startsWith("http") || icon.startsWith("/"))) {
    return (
      <img
        src={icon}
        alt={name}
        className={`${className} rounded-xl object-cover`}
      />
    );
  }
  // 4. Lucide icon by name
  if (icon) {
    // Normalize: DB may store PascalCase ("StickyNote") or kebab-case ("sticky-note")
    const key = toKebabCase(icon);
    const IconComponent = ICON_MAP[key];
    if (IconComponent) {
      return <IconComponent className="h-5 w-5 text-foreground/80" />;
    }
  }
  // 5. Fallback: first letter
  return (
    <span className="text-foreground/80">{name.charAt(0).toUpperCase()}</span>
  );
}

/** Whether an app should be shown as active (not dimmed) */
function isAppUp(status: string | null): boolean {
  return status !== "unhealthy";
}

export function AppDrawer() {
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState<DrawerApp[]>([]);
  const t = useTranslations("appDrawer");

  const fetchApps = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/apps/drawer");
      if (!res.ok) return;
      const data = await res.json();
      setApps(data.apps.filter((a: DrawerApp) => a.visible));
    } catch {
      // Silently fail
    }
  }, []);

  useEffect(() => {
    if (open) fetchApps();
  }, [open, fetchApps]);

  const handleAppClick = (app: DrawerApp) => {
    if (app.url) {
      window.location.href = app.url;
      setOpen(false);
    }
  };

  // Sort by display order, then alphabetically
  const sortedApps = [...apps].sort((a, b) => {
    const aOrder = a.order ?? 999;
    const bOrder = b.order ?? 999;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.name.localeCompare(b.name);
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          aria-label={t("title")}
        >
          <DotsIcon className="h-5 w-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[340px] rounded-xl p-0 origin-top-right"
      >
        {/* App Grid */}
        <ScrollArea className="max-h-[400px]">
          <div className="p-3">
            {sortedApps.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <p className="text-sm text-muted-foreground mb-3">
                  {t("noAppsInstalled")}
                </p>
                <Link
                  href="/settings/apps"
                  className="text-sm text-primary hover:underline"
                  onClick={() => setOpen(false)}
                >
                  {t("visitMarketplace") ?? "Visit Marketplace"}
                </Link>
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-1">
                {sortedApps.map((app) => {
                  const up = isAppUp(app.status);
                  return (
                    <div
                      key={app.id}
                      className={`relative flex flex-col items-center p-2 rounded-xl cursor-pointer transition-all duration-150 hover:bg-accent/60 hover:scale-105${up ? "" : " opacity-40 grayscale"}`}
                      onClick={() => handleAppClick(app)}
                      title={up ? app.name : `${app.name} — offline`}
                    >
                      {/* App Icon */}
                      <div className="w-10 h-10 rounded-xl bg-accent/80 flex items-center justify-center text-base font-medium shadow-sm overflow-hidden transition-transform duration-150">
                        <AppIcon
                          icon={app.icon}
                          customIconUrl={app.custom_icon_url}
                          name={app.name}
                        />
                      </div>

                      {/* App Name */}
                      <span className="text-[11px] text-center line-clamp-1 w-full mt-1.5 text-foreground/80 leading-tight">
                        {app.name}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="border-t px-3 py-2.5 flex items-center justify-between">
          <Link
            href="/settings/apps"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
            onClick={() => setOpen(false)}
          >
            <Settings className="h-3.5 w-3.5" />
            {t("manageApps") ?? "Manage Apps"}
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
