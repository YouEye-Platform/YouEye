"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Globe,
  Languages,
  LayoutGrid,
  Info,
  Palette,
  User,
  Users,
  Server,
} from "lucide-react";
import { cn } from "@/lib/utils";

const USER_SECTIONS = [
  { id: "profile", label: "Profile", icon: User, href: "/settings" },
  { id: "appearance", label: "Appearance", icon: Palette, href: "/settings/appearance" },
  { id: "apps", label: "Apps", icon: LayoutGrid, href: "/settings/apps" },
  { id: "language", label: "Language", icon: Languages, href: "/settings/language" },
];

// Market intentionally NOT in Settings (Plan 1 D9 — it's a launcher app with its own Sources page).
// Privacy + Backups deferred to C2: their CP pages are stubs (redirect to /settings) until implemented.
const ADMIN_SECTIONS = [
  { id: "users", label: "People", icon: Users, href: "/settings/users" },
  { id: "system", label: "System", icon: Server, href: "/settings/system" },
  { id: "network", label: "Network", icon: Globe, href: "/settings/network" },
  { id: "about", label: "About", icon: Info, href: "/settings/about" },
];

interface SettingsShellProps {
  children: React.ReactNode;
  isAdmin: boolean;
  username: string;
  hasUserContext?: boolean;
}

export function SettingsShell({ children, isAdmin, username, hasUserContext = true }: SettingsShellProps) {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/settings") return pathname === "/settings";
    if (href === "/settings/apps") {
      return pathname === "/settings/apps" || (pathname.startsWith("/settings/apps/") && !pathname.startsWith("/settings/apps-list"));
    }
    return pathname.startsWith(href);
  };

  const renderItem = (section: (typeof USER_SECTIONS)[number]) => {
    const Icon = section.icon;
    const active = isActive(section.href);
    return (
      <Link
        key={section.id}
        href={section.href}
        className={cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
          active
            ? "bg-primary/10 text-primary font-medium"
            : "text-muted-foreground hover:bg-muted hover:text-foreground"
        )}
      >
        <Icon className="h-4 w-4" />
        <span>{section.label}</span>
      </Link>
    );
  };

  return (
    <div className="mx-auto flex max-w-6xl gap-8 px-6 py-8">
      <nav className="w-52 shrink-0">
        <div className="sticky top-20 space-y-1">
          {hasUserContext && (
            <>
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Personal
              </p>
              {USER_SECTIONS.map(renderItem)}
            </>
          )}

          {isAdmin && (
            <>
              {hasUserContext && <div className="my-3 border-t" />}
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Administration
              </p>
              {ADMIN_SECTIONS.map(renderItem)}
            </>
          )}

          <div className="mt-4 border-t pt-3">
            <p className="truncate px-3 text-xs text-muted-foreground">{username}</p>
          </div>
        </div>
      </nav>

      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
