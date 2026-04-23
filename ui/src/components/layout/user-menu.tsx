/**
 * User Menu Component
 *
 * Dropdown menu showing the current user's name/email and a logout button.
 * Uses shadcn/ui DropdownMenu with Avatar trigger.
 */

"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { LogOut, Shield, Settings, Clock, Sun, Moon, Monitor } from "lucide-react";

interface UserMenuProps {
  username: string;
  email: string;
  isAdmin: boolean;
}

export function UserMenu({ username, email, isAdmin }: UserMenuProps) {
  const router = useRouter();
  const t = useTranslations("nav");
  const { theme, setTheme } = useTheme();
  const [systemPref, setSystemPref] = useState<"light" | "dark">("light");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemPref(mq.matches ? "dark" : "light");
    const handler = (e: MediaQueryListEvent) =>
      setSystemPref(e.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Fetch avatar from profile
  useEffect(() => {
    fetch("/api/v1/user/profile")
      .then((r) => r.json())
      .then((data) => {
        if (data.image) setAvatarUrl(data.image);
      })
      .catch(() => {});
  }, []);

  // Listen for avatar updates from profile page
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setAvatarUrl(detail?.url || null);
    };
    window.addEventListener("avatar-updated", handler);
    return () => window.removeEventListener("avatar-updated", handler);
  }, []);

  const initials = username
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent transition-colors outline-none">
          <Avatar className="size-7">
            {avatarUrl && <AvatarImage src={avatarUrl} alt={username} />}
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            {username}
            {isAdmin && <Shield className="size-3 text-primary" />}
          </span>
          <span className="text-xs font-normal text-muted-foreground">
            {email}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push("/timeline")}>
          <Clock className="size-4" />
          {t("timeline")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push("/settings")}>
          <Settings className="size-4" />
          {t("settings")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            const next = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
            setTheme(next);
            // Sync to DB so native apps pick up the mode
            fetch("/api/v1/themes/active", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ mode: next }),
            }).catch(() => {});
          }}
        >
          {theme === "light" ? (
            <Sun className="size-4" />
          ) : theme === "dark" ? (
            <Moon className="size-4" />
          ) : (
            <Monitor className="size-4" />
          )}
          {theme === "light"
            ? t("themeLight")
            : theme === "dark"
              ? t("themeDark")
              : t("themeSystem")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleLogout} className="text-destructive">
          <LogOut className="size-4" />
          {t("signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
