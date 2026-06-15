/**
 * User Menu — Plan 1 Workstream E4 (D14-revised, toned down 2026-06-15).
 *
 * Account panel: centered email, large avatar (display only — no pencil-edit),
 * "Hi, <first name>!", grouped card (Timeline / Settings / Theme as a
 * Light·Dark·Auto segmented control), ghost Sign out. The Google-isms removed
 * per the owner: the "Manage your account" pill, the avatar pencil-edit, and the
 * Privacy · About footer. Mirrored on CP (control-header) and native (Canvas).
 */

"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { LogOut, Shield, Settings, Clock, Sun, Moon, Monitor } from "lucide-react";

interface UserMenuProps {
  username: string;
  email: string;
  isAdmin: boolean;
}

type ThemeMode = "light" | "dark" | "system";

export function UserMenu({ username, email, isAdmin }: UserMenuProps) {
  const router = useRouter();
  const t = useTranslations("nav");
  const { theme, setTheme } = useTheme();
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(username);

  // Fetch avatar and name from profile.
  useEffect(() => {
    fetch("/api/v1/user/profile")
      .then((r) => r.json())
      .then((data) => {
        if (data.image) setAvatarUrl(data.image);
        if (data.name) setDisplayName(data.name);
      })
      .catch(() => {});
  }, []);

  // Live updates from the profile page.
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

  const initials = displayName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
  const firstName = displayName.split(" ")[0] || displayName;

  function applyTheme(mode: ThemeMode) {
    setTheme(mode);
    // Sync to DB so native apps pick up the mode.
    fetch("/api/v1/themes/active", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }).catch(() => {});
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  const THEMES: { mode: ThemeMode; Icon: typeof Sun; label: string }[] = [
    { mode: "light", Icon: Sun, label: t("themeLight") },
    { mode: "dark", Icon: Moon, label: t("themeDark") },
    { mode: "system", Icon: Monitor, label: t("themeSystem") },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent transition-colors outline-none">
          <Avatar className="size-7">
            {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-[340px] rounded-3xl p-0 overflow-hidden border bg-muted"
      >
        {/* Email, centered */}
        <p className="pt-4 pb-3 text-center text-xs text-muted-foreground truncate px-6">{email}</p>

        {/* Big avatar + greeting — display only (no pencil-edit), toned down per D14-revised */}
        <div className="flex flex-col items-center gap-2 px-5">
          <Avatar className="size-[76px]">
            {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
            <AvatarFallback className="text-xl">{initials}</AvatarFallback>
          </Avatar>
          <div className="flex items-center gap-1.5 text-base font-medium">
            <span>Hi, {firstName}!</span>
            {isAdmin && <Shield className="size-3.5 text-primary" />}
          </div>
        </div>

        {/* Grouped card */}
        <div className="m-3 rounded-2xl bg-card border overflow-hidden">
          <button
            type="button"
            onClick={() => router.push("/timeline")}
            className="flex w-full items-center gap-3 px-4 py-3 text-sm hover:bg-accent transition-colors"
          >
            <Clock className="size-4 text-muted-foreground" />
            {t("timeline")}
          </button>
          <div className="border-t" />
          <button
            type="button"
            onClick={() => router.push("/settings")}
            className="flex w-full items-center gap-3 px-4 py-3 text-sm hover:bg-accent transition-colors"
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
                    className={`grid place-items-center size-7 rounded-md transition-colors ${
                      active
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Icon className="size-3.5" />
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Sign out */}
        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={handleLogout}
            className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <LogOut className="size-4" />
            {t("signOut")}
          </button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
