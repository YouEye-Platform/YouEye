"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Bell,
  Grid3X3,
  Home,
  LogOut,
  Settings,
  Shield,
  Store,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";

interface ControlHeaderProps {
  username: string;
  isAdmin: boolean;
}

interface BridgeProfile {
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

interface DrawerApp {
  id: string;
  name: string;
  icon?: string | null;
  custom_icon_url?: string | null;
  url?: string | null;
  visible?: boolean;
}

function bridgeApi(path: string) {
  const prefix = typeof window !== "undefined" && window.location.pathname.startsWith("/market")
    ? "/market/api/ui-settings"
    : "/settings/api/ui-settings";
  return `${prefix}/${path.replace(/^\/+/, "")}`;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "YE";
}

export function ControlHeader({ username, isAdmin }: ControlHeaderProps) {
  const [profile, setProfile] = useState<BridgeProfile | null>(null);
  const [apps, setApps] = useState<DrawerApp[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(bridgeApi("profile"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setProfile(data);
      })
      .catch(() => {});

    fetch(bridgeApi("apps/drawer"), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) {
          setApps((data?.apps ?? []).filter((app: DrawerApp) => app.visible !== false));
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const displayName = profile?.name || username;
  const avatar = profile?.image || null;
  const visibleApps = useMemo(() => apps.slice(0, 12), [apps]);

  async function logout() {
    await fetch("/settings/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/";
  }

  return (
    <header className="sticky top-0 z-50 flex h-14 items-center justify-between border-b border-border/40 bg-background/95 px-4 backdrop-blur-md">
      <Link href="/" className="flex items-center gap-2 transition-opacity hover:opacity-80">
        <img src="/settings/api/branding/favicon?size=32" alt="" className="h-6 w-6 rounded-md object-contain" />
        <span className="text-base font-semibold tracking-normal">YouEye</span>
      </Link>

      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-9 w-9" asChild title="Dashboard">
          <Link href="/">
            <Home className="h-4 w-4" />
          </Link>
        </Button>

        <div className="relative">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            title="Apps"
            onClick={() => {
              setDrawerOpen((open) => !open);
              setMenuOpen(false);
            }}
          >
            <Grid3X3 className="h-4 w-4" />
          </Button>
          {drawerOpen && (
            <div className="absolute right-0 mt-2 w-80 rounded-lg border bg-popover p-3 text-popover-foreground shadow-xl">
              <div className="mb-2 flex items-center justify-between px-1">
                <p className="text-sm font-medium">Apps</p>
                <Link href="/settings/apps" className="text-xs text-muted-foreground hover:text-foreground">
                  Manage
                </Link>
              </div>
              {visibleApps.length === 0 ? (
                <p className="px-1 py-6 text-center text-sm text-muted-foreground">No apps visible</p>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {visibleApps.map((app) => (
                    <a
                      key={app.id}
                      href={app.url || `/app/${app.id}`}
                      className="flex min-h-20 flex-col items-center justify-center gap-2 rounded-md p-2 text-center text-xs hover:bg-accent"
                    >
                      {app.custom_icon_url ? (
                        <img src={app.custom_icon_url} alt="" className="h-7 w-7 rounded-md object-contain" />
                      ) : (
                        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-sm font-semibold">
                          {initials(app.name).slice(0, 1)}
                        </span>
                      )}
                      <span className="line-clamp-2 break-words">{app.name}</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <Button variant="ghost" size="icon" className="h-9 w-9" asChild title="Notifications">
          <Link href="/notifications">
            <Bell className="h-4 w-4" />
          </Link>
        </Button>

        <div className="relative">
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors hover:bg-accent"
            onClick={() => {
              setMenuOpen((open) => !open);
              setDrawerOpen(false);
            }}
            title={displayName}
          >
            <span className="flex size-7 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium">
              {avatar ? <img src={avatar} alt="" className="h-full w-full object-cover" /> : initials(displayName)}
            </span>
          </button>
          {menuOpen && (
            <div className="absolute right-0 mt-2 w-56 rounded-lg border bg-popover p-1 text-popover-foreground shadow-xl">
              <div className="px-3 py-2">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  {displayName}
                  {isAdmin && <Shield className="size-3 text-primary" />}
                </p>
                <p className="truncate text-xs text-muted-foreground">{profile?.email || username}</p>
              </div>
              <div className="my-1 border-t" />
              <Link href="/settings" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent">
                <Settings className="size-4" />
                Settings
              </Link>
              <Link href="/market" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent">
                <Store className="size-4" />
                App Market
              </Link>
              <div className="my-1 border-t" />
              <button
                type="button"
                onClick={logout}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-destructive hover:bg-accent"
              >
                <LogOut className="size-4" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
