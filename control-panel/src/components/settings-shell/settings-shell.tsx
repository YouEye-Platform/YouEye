"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronDown,
  Globe,
  Languages,
  LayoutGrid,
  Info,
  Palette,
  User,
  Users,
  Server,
  ArchiveRestore,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const USER_SECTIONS = [
  { id: "profile", label: "Profile", icon: User, href: "/settings" },
  { id: "appearance", label: "Appearance", icon: Palette, href: "/settings/appearance" },
  { id: "apps", label: "Apps", icon: LayoutGrid, href: "/settings/apps" },
  { id: "ai", label: "AI", icon: Sparkles, href: "/settings/ai" },
  { id: "language", label: "Language", icon: Languages, href: "/settings/language" },
];

// Market intentionally NOT in Settings (Plan 1 D9 — it's a launcher app with its own Sources page).
const ADMIN_SECTIONS = [
  { id: "users", label: "People", icon: Users, href: "/settings/users" },
  { id: "system", label: "System", icon: Server, href: "/settings/system" },
  { id: "network", label: "Network", icon: Globe, href: "/settings/network" },
  { id: "backup", label: "Backups", icon: ArchiveRestore, href: "/settings/backup" },
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
            ? "bg-primary/5 text-primary font-medium"
            : "text-muted-foreground hover:bg-muted hover:text-foreground"
        )}
      >
        <Icon className="h-4 w-4" />
        <span>{section.label}</span>
      </Link>
    );
  };

  const visibleSections = [
    ...(hasUserContext ? USER_SECTIONS : []),
    ...(isAdmin ? ADMIN_SECTIONS : []),
  ];
  const activeSection = visibleSections.find((section) => isActive(section.href)) ?? visibleSections[0];
  const ActiveIcon = activeSection?.icon ?? User;

  const renderMobileItem = (section: (typeof USER_SECTIONS)[number]) => {
    const Icon = section.icon;
    const active = isActive(section.href);
    return (
      <DropdownMenuItem
        key={section.id}
        asChild
        className={cn(active && "bg-primary/5 text-primary focus:bg-primary/5 focus:text-primary")}
      >
        <Link href={section.href}>
          <Icon className="size-4" />
          <span>{section.label}</span>
        </Link>
      </DropdownMenuItem>
    );
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-5 md:flex-row md:gap-8 md:px-6 md:py-8">
      <div className="md:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="h-auto w-full justify-between px-3 py-2.5"
              aria-label="Open Settings navigation"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <ActiveIcon className="size-4 shrink-0 text-primary" />
                <span className="truncate">{activeSection?.label ?? "Settings"}</span>
              </span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-[var(--radix-dropdown-menu-trigger-width)]"
          >
            {hasUserContext && (
              <>
                <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Personal
                </DropdownMenuLabel>
                {USER_SECTIONS.map(renderMobileItem)}
              </>
            )}
            {isAdmin && (
              <>
                {hasUserContext && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Administration
                </DropdownMenuLabel>
                {ADMIN_SECTIONS.map(renderMobileItem)}
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
              {username}
            </DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <nav className="hidden w-full shrink-0 md:block md:w-52">
        <div className="space-y-1 md:sticky md:top-20">
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
