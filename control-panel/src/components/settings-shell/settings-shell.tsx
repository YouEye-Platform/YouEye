"use client";

import { useTranslations as useInterfaceTranslations } from "next-intl";
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
  Shield,
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
import { AI_SECTIONS, isAISectionActive } from "./ai-navigation";

const USER_SECTIONS = [
  { id: "profile", icon: User, href: "/settings" },
  { id: "appearance", icon: Palette, href: "/settings/appearance" },
  { id: "privacy", icon: Shield, href: "/settings/privacy" },
  { id: "apps", icon: LayoutGrid, href: "/settings/apps" },
  { id: "ai", icon: Sparkles, href: "/settings/ai" },
  { id: "language", icon: Languages, href: "/settings/language" },
];

// Market intentionally NOT in Settings (Plan 1 D9 — it's a launcher app with its own Sources page).
const ADMIN_SECTIONS = [
  { id: "users", icon: Users, href: "/settings/users" },
  { id: "system", icon: Server, href: "/settings/system" },
  { id: "network", icon: Globe, href: "/settings/network" },
  { id: "backup", icon: ArchiveRestore, href: "/settings/backup" },
  { id: "about", icon: Info, href: "/settings/about" },
];

interface SettingsShellProps {
  children: React.ReactNode;
  isAdmin: boolean;
  username: string;
  hasUserContext?: boolean;
}

export function SettingsShell({ children, isAdmin, username, hasUserContext = true }: SettingsShellProps) {
  const translateInterface = useInterfaceTranslations("interface");

  const pathname = usePathname();
  const inAI = pathname === "/settings/ai" || pathname.startsWith("/settings/ai/");
  const aiNavigation = useInterfaceTranslations("aiNavigation");
  const aiSections = [
    ...AI_SECTIONS,
    ...(isAdmin ? [{ href: "/admin", labelKey: "admin" }] : []),
  ];
  const navigation = useInterfaceTranslations("settingsNavigation");

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
      <div key={section.id}>
      <Link
        href={section.href}
        aria-current={active && !(section.id === "ai" && inAI) ? "page" : undefined}
        className={cn(
          "flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          active
            ? "bg-muted text-foreground font-medium"
            : "text-muted-foreground hover:bg-muted hover:text-foreground"
        )}
      >
        <Icon className="h-4 w-4" />
        <span>{navigation(section.id)}</span>
      </Link>
      {section.id === "ai" && inAI && (
        <nav aria-label={aiNavigation("settings")} className="my-1 ml-5 space-y-0.5 border-l pl-3">
          {aiSections.map(item => {
            const selected = isAISectionActive(pathname, item.href);
            return <Link key={item.href} href={"/settings/ai" + item.href}
              aria-current={selected ? "page" : undefined}
              className={cn("flex min-h-9 items-center rounded-md px-2.5 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                selected ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
              {aiNavigation(item.labelKey)}
            </Link>;
          })}
        </nav>
      )}
      </div>
    );
  };

  const visibleSections = [
    ...(hasUserContext ? USER_SECTIONS : []),
    ...(isAdmin ? ADMIN_SECTIONS : []),
  ];
  const activeSection = visibleSections.find((section) => isActive(section.href)) ?? visibleSections[0];
  const ActiveIcon = activeSection?.icon ?? User;
  const activeAISection = inAI ? aiSections.find(item => isAISectionActive(pathname, item.href)) : undefined;

  const renderMobileItem = (section: (typeof USER_SECTIONS)[number]) => {
    const Icon = section.icon;
    const active = isActive(section.href);
    return (
      <DropdownMenuItem
        key={section.id}
        asChild
        className={cn(active && "bg-primary/5 text-primary focus:bg-primary/5 focus:text-primary")}
      >
        <Link href={section.href} aria-current={active && !inAI ? "page" : undefined}>
          <Icon className="size-4" />
          <span>{navigation(section.id)}</span>
        </Link>
      </DropdownMenuItem>
    );
  };

  return (
    <div className="settings-workspace mx-auto flex w-full max-w-[120rem] flex-col gap-6 px-4 py-5 md:flex-row md:gap-8 md:px-6 md:py-8 xl:gap-12 xl:px-10">
      <div className="md:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="h-auto w-full justify-between px-3 py-2.5"
              aria-label={navigation("open")}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <ActiveIcon className="size-4 shrink-0 text-primary" />
                <span className="truncate">{activeAISection ? aiNavigation("currentSection", { section: aiNavigation(activeAISection.labelKey) }) : activeSection ? navigation(activeSection.id) : navigation("title")}</span>
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
                  {navigation("personal")}
                </DropdownMenuLabel>
                {USER_SECTIONS.map(renderMobileItem)}
                {inAI && <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{translateInterface("m377c481d3c31")}</DropdownMenuLabel>
                  {aiSections.map(item => <DropdownMenuItem key={item.href} asChild>
                    <Link href={"/settings/ai" + item.href} aria-current={isAISectionActive(pathname, item.href) ? "page" : undefined}>
                      {aiNavigation(item.labelKey)}
                    </Link>
                  </DropdownMenuItem>)}
                </>}
              </>
            )}
            {isAdmin && (
              <>
                {hasUserContext && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  {navigation("administration")}
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

      <nav aria-label={translateInterface("m74a883a037bc")} className="hidden w-full shrink-0 md:block md:w-52">
        <div className="space-y-1 md:sticky md:top-20 md:max-h-[calc(100dvh-6rem)] md:overflow-y-auto md:px-1 md:pb-4">
          <p className="px-3 pb-5 text-lg font-semibold tracking-tight text-foreground">{translateInterface("m74a883a037bc")}</p>
          {hasUserContext && (
            <>
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {navigation("personal")}
              </p>
              {USER_SECTIONS.map(renderItem)}
            </>
          )}

          {isAdmin && (
            <>
              {hasUserContext && <div className="my-3 border-t" />}
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {navigation("administration")}
              </p>
              {ADMIN_SECTIONS.map(renderItem)}
            </>
          )}

          <div className="mt-4 border-t pt-3">
            <p className="truncate px-3 text-xs text-muted-foreground">{username}</p>
          </div>
        </div>
      </nav>

      <main className="settings-main min-w-0 flex-1 pb-8" data-settings-page={pathname}>{children}</main>
    </div>
  );
}
