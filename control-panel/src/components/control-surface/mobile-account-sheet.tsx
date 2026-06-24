"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bell,
  ChevronDown,
  Clock,
  Home,
  LayoutGrid,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Shield,
  Sun,
  X,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { ThemeMode } from "@/lib/theme";

type SheetSection = "notifications" | "drawer" | "launcher" | null;

interface MobileAccountSheetProps {
  displayName: string;
  email: string;
  isAdmin: boolean;
  hasUserContext: boolean;
  avatarUrl?: string | null;
  unreadCount: number;
  uiBaseUrl: string;
  uiBaseOrigin: string;
  themeMode: string;
  embedMode: "light" | "dark";
  onThemeChange: (mode: ThemeMode) => void;
  onLogout: () => void;
}

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0])
      .join("")
      .toUpperCase()
      .slice(0, 2) || "YE"
  );
}

function SectionButton({
  section,
  activeSection,
  label,
  Icon,
  onOpen,
}: {
  section: Exclude<SheetSection, null>;
  activeSection: SheetSection;
  label: string;
  Icon: typeof Bell;
  onOpen: (section: SheetSection) => void;
}) {
  const open = activeSection === section;
  return (
    <button
      type="button"
      onClick={() => onOpen(open ? null : section)}
      className="flex w-full items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-accent"
      aria-expanded={open}
    >
      <Icon className="size-4 text-muted-foreground" />
      <span className="flex-1 text-left">{label}</span>
      <ChevronDown className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
    </button>
  );
}

export function MobileAccountSheet({
  displayName,
  email,
  isAdmin,
  hasUserContext,
  avatarUrl,
  unreadCount,
  uiBaseUrl,
  uiBaseOrigin,
  themeMode,
  embedMode,
  onThemeChange,
  onLogout,
}: MobileAccountSheetProps) {
  const [open, setOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<SheetSection>(null);
  const [localUnread, setLocalUnread] = useState(unreadCount);

  useEffect(() => setLocalUnread(unreadCount), [unreadCount]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!uiBaseOrigin) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== uiBaseOrigin) return;
      if (event.data?.type === "youeye:notifications" && typeof event.data.unread_count === "number") {
        setLocalUnread(event.data.unread_count);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [uiBaseOrigin]);

  const firstName = displayName.split(" ")[0] || displayName;
  const fallback = useMemo(() => initials(displayName), [displayName]);
  const base = uiBaseUrl.replace(/\/$/, "");

  const embedSrc = (kind: "notifications" | "drawer" | "launcher") => {
    if (!base) return "";
    const params = new URLSearchParams({ mode: embedMode, surface: "sheet" });
    if (kind === "drawer" && isAdmin) params.set("admin", "true");
    return `${base}/embed/${kind}?${params.toString()}`;
  };

  const themeModes: { mode: ThemeMode; Icon: typeof Sun; label: string }[] = [
    { mode: "light", Icon: Sun, label: "Light" },
    { mode: "dark", Icon: Moon, label: "Dark" },
    { mode: "system", Icon: Monitor, label: "Auto" },
  ];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Account menu"
        className="relative inline-flex size-12 items-center justify-center rounded-2xl transition-colors hover:bg-accent"
      >
        <Avatar className="size-8">
          {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
          <AvatarFallback className="text-xs">{fallback}</AvatarFallback>
        </Avatar>
        {localUnread > 0 && (
          <span className="absolute right-1 top-1 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-red-500 px-0.5 text-[9px] font-bold text-white">
            {localUnread > 99 ? "99+" : localUnread}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-[100] text-foreground">
          <button
            type="button"
            aria-label="Close account sheet"
            className="absolute inset-0 bg-background/45 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div className="fixed inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-3xl border border-border/60 bg-popover/95 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-2xl backdrop-blur-xl">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Account</span>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="rounded-2xl border border-border/50 bg-card/60">
              <p className="truncate px-6 pb-3 pt-4 text-center text-xs text-muted-foreground">{email}</p>
              <div className="flex flex-col items-center gap-2 px-5 pb-4">
                <Avatar className="size-[76px]">
                  {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
                  <AvatarFallback className="text-xl">{fallback}</AvatarFallback>
                </Avatar>
                <div className="flex items-center gap-1.5 text-base font-medium">
                  <span>Hi, {firstName}!</span>
                  {isAdmin && <Shield className="size-3.5 text-primary" />}
                </div>
              </div>
            </div>

            {hasUserContext && base && (
              <div className="mt-3 overflow-hidden rounded-2xl border border-border/50 bg-card/60">
                <SectionButton section="notifications" activeSection={activeSection} label="Notifications" Icon={Bell} onOpen={setActiveSection} />
                {activeSection === "notifications" && (
                  <iframe
                    title="YouEye notifications"
                    src={embedSrc("notifications")}
                    className="h-[380px] w-full border-t bg-transparent"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation-by-user-activation"
                    allow="clipboard-read; clipboard-write"
                  />
                )}
                <div className="border-t" />
                <SectionButton section="drawer" activeSection={activeSection} label="App drawer" Icon={LayoutGrid} onOpen={setActiveSection} />
                {activeSection === "drawer" && (
                  <iframe
                    title="YouEye app drawer"
                    src={embedSrc("drawer")}
                    className="h-[380px] w-full border-t bg-transparent"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation-by-user-activation"
                    allow="clipboard-read; clipboard-write"
                  />
                )}
                <div className="border-t" />
                <SectionButton section="launcher" activeSection={activeSection} label="Launcher" Icon={LayoutGrid} onOpen={setActiveSection} />
                {activeSection === "launcher" && (
                  <iframe
                    title="YouEye launcher"
                    src={embedSrc("launcher")}
                    className="h-[460px] w-full border-t bg-transparent"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation-by-user-activation"
                    allow="clipboard-read; clipboard-write"
                  />
                )}
              </div>
            )}

            <div className="mt-3 overflow-hidden rounded-2xl border border-border/50 bg-card/60">
              {hasUserContext && base && (
                <>
                  <a href={base} className="flex w-full items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-accent">
                    <Home className="size-4 text-muted-foreground" />
                    Home
                  </a>
                  <div className="border-t" />
                  <a href="/timeline" className="flex w-full items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-accent">
                    <Clock className="size-4 text-muted-foreground" />
                    Timeline
                  </a>
                  <div className="border-t" />
                </>
              )}
              <a href={hasUserContext ? "/settings" : "/settings/system"} className="flex w-full items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-accent">
                <Settings className="size-4 text-muted-foreground" />
                Settings
              </a>
              {hasUserContext && (
                <>
                  <div className="border-t" />
                  <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span className="flex items-center gap-3 text-sm">
                      <Sun className="size-4 text-muted-foreground" />
                      Theme
                    </span>
                    <div className="inline-flex rounded-lg border bg-background p-0.5">
                      {themeModes.map(({ mode, Icon, label }) => {
                        const active = themeMode === mode;
                        return (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => onThemeChange(mode)}
                            aria-pressed={active}
                            title={label}
                            className={`grid size-7 place-items-center rounded-md transition-colors ${
                              active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            <Icon className="size-3.5" />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={onLogout}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl py-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <LogOut className="size-4" />
              Sign out
            </button>
          </div>
        </div>
      )}
    </>
  );
}
