"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
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
import { AppDrawer } from "./app-drawer";
import { Launcher } from "./launcher";
import { NotificationBell } from "./notification-bell";

interface MobileAccountSheetProps {
  username: string;
  email: string;
  isAdmin: boolean;
}

type ThemeMode = "light" | "dark" | "system";
type SheetSection = "notifications" | "drawer" | "launcher" | null;

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

export function MobileAccountSheet({ username, email, isAdmin }: MobileAccountSheetProps) {
  const router = useRouter();
  const t = useTranslations("nav");
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<SheetSection>(null);
  const [mounted, setMounted] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(username);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    fetch("/api/v1/user/profile")
      .then((r) => r.json())
      .then((data) => {
        if (data.image) setAvatarUrl(data.image);
        if (data.name) setDisplayName(data.name);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/v1/notifications?limit=1")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (typeof data?.unread_count === "number") setUnreadCount(data.unread_count);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onAvatar = (e: Event) => setAvatarUrl((e as CustomEvent).detail?.url || null);
    const onName = (e: Event) => {
      const name = (e as CustomEvent).detail?.name;
      if (name) setDisplayName(name);
    };
    window.addEventListener("avatar-updated", onAvatar);
    window.addEventListener("name-updated", onName);
    return () => {
      window.removeEventListener("avatar-updated", onAvatar);
      window.removeEventListener("name-updated", onName);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const fallback = useMemo(() => initials(displayName), [displayName]);
  const firstName = displayName.split(" ")[0] || displayName;

  const closeAndGo = useCallback((href: string) => {
    setOpen(false);
    router.push(href);
  }, [router]);

  function applyTheme(mode: ThemeMode) {
    setTheme(mode);
    fetch("/api/v1/themes/active", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }).catch(() => {});
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.push("/login");
  }

  const THEMES: { mode: ThemeMode; Icon: typeof Sun; label: string }[] = [
    { mode: "light", Icon: Sun, label: t("themeLight") },
    { mode: "dark", Icon: Moon, label: t("themeDark") },
    { mode: "system", Icon: Monitor, label: t("themeSystem") },
  ];

  const sheet = open && mounted ? createPortal(
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

        <div className="mt-3 overflow-hidden rounded-2xl border border-border/50 bg-card/60">
          <SectionButton section="notifications" activeSection={activeSection} label="Notifications" Icon={Bell} onOpen={setActiveSection} />
          {activeSection === "notifications" && (
            <div className="border-t bg-background/35">
              <NotificationBell embedded onUnreadCountChange={setUnreadCount} />
            </div>
          )}
          <div className="border-t" />
          <SectionButton section="drawer" activeSection={activeSection} label="App drawer" Icon={LayoutGrid} onOpen={setActiveSection} />
          {activeSection === "drawer" && (
            <div className="border-t bg-background/35">
              <AppDrawer embedded isAdmin={isAdmin} onOpenLauncher={() => setActiveSection("launcher")} />
            </div>
          )}
          <div className="border-t" />
          <SectionButton section="launcher" activeSection={activeSection} label="Launcher" Icon={LayoutGrid} onOpen={setActiveSection} />
          {activeSection === "launcher" && (
            <div className="h-[460px] border-t bg-background/35">
              <Launcher embedded />
            </div>
          )}
        </div>

        <div className="mt-3 overflow-hidden rounded-2xl border border-border/50 bg-card/60">
          <button
            type="button"
            onClick={() => closeAndGo("/")}
            className="flex w-full items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-accent"
          >
            <Home className="size-4 text-muted-foreground" />
            Home
          </button>
          <div className="border-t" />
          <button
            type="button"
            onClick={() => closeAndGo("/timeline")}
            className="flex w-full items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-accent"
          >
            <Clock className="size-4 text-muted-foreground" />
            {t("timeline")}
          </button>
          <div className="border-t" />
          <button
            type="button"
            onClick={() => closeAndGo("/settings")}
            className="flex w-full items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-accent"
          >
            <Settings className="size-4 text-muted-foreground" />
            {t("settings")}
          </button>
          <div className="border-t" />
          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="flex items-center gap-3 text-sm">
              <Sun className="size-4 text-muted-foreground" />
              Theme
            </span>
            <div className="inline-flex rounded-lg border bg-background p-0.5">
              {THEMES.map(({ mode, Icon, label }) => {
                const active = (theme ?? "system") === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => applyTheme(mode)}
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
        </div>

        <button
          type="button"
          onClick={handleLogout}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl py-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <LogOut className="size-4" />
          {t("signOut")}
        </button>
      </div>
    </div>,
    document.body,
  ) : null;

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
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-red-500 px-0.5 text-[9px] font-bold text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>
      {sheet}
    </>
  );
}
