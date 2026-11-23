"use client";

import { useTranslations as useInterfaceTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
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
import { cn } from "@/lib/utils";
import { AI_SECTIONS, isAISectionActive } from "./ai-navigation";

// You: what only affects the person signed in. This server: what affects everyone (admins).
const USER_SECTIONS = [
  { id: "profile", icon: User, href: "/settings/profile" },
  { id: "appearance", icon: Palette, href: "/settings/appearance" },
  { id: "language", icon: Languages, href: "/settings/language" },
  { id: "privacy", icon: Shield, href: "/settings/privacy" },
  { id: "apps", icon: LayoutGrid, href: "/settings/apps" },
  { id: "ai", icon: Sparkles, href: "/settings/ai" },
] as const;

// Market intentionally NOT in Settings (Plan 1 D9 — it's a launcher app with its own Sources page).
const ADMIN_SECTIONS = [
  { id: "general", icon: Info, href: "/settings/general" },
  { id: "users", icon: Users, href: "/settings/users" },
  { id: "network", icon: Globe, href: "/settings/network" },
  { id: "backup", icon: ArchiveRestore, href: "/settings/backup" },
  { id: "system", icon: Server, href: "/settings/system" },
] as const;

type Section = (typeof USER_SECTIONS)[number] | (typeof ADMIN_SECTIONS)[number];

interface SettingsShellProps {
  children: React.ReactNode;
  isAdmin: boolean;
  username: string;
  hasUserContext?: boolean;
}

/**
 * Settings: a sidebar beside the page from tablet width up; on a phone a list of sections at /settings, and each
 * section as its own page with a way back to that list (a navigation stack, like a phone's own settings).
 */
export function SettingsShell({ children, isAdmin, username, hasUserContext = true }: SettingsShellProps) {
  const translateInterface = useInterfaceTranslations("interface");
  const navigation = useInterfaceTranslations("settingsNavigation");
  const aiNavigation = useInterfaceTranslations("aiNavigation");

  const pathname = usePathname();
  const searchParams = useSearchParams();
  const atRoot = pathname === "/settings";
  // A page inside a section (/settings/system/health, /settings/apps/notes) leads back to its section, on every
  // screen; a section's own page leads back to the list of sections, on a phone (the sidebar does it elsewhere).
  // AI's pages are siblings with their own navigation, not a hierarchy.
  const segments = pathname.split("/").filter(Boolean);
  const parentId = segments.length > 2 && segments[1] !== "ai"
    ? (segments[1] === "apps" && searchParams.get("from") === "system" ? "system" : segments[1])
    : null;
  const appPage = segments[1] === "apps" && segments.length > 3 ? `/settings/apps/${segments[2]}` : null;
  const parent = parentId ? [...USER_SECTIONS, ...ADMIN_SECTIONS].find((section) => section.href === `/settings/${parentId}`) : undefined;
  const inAI = pathname === "/settings/ai" || pathname.startsWith("/settings/ai/");
  const aiSections = [
    ...AI_SECTIONS,
    ...(isAdmin ? [{ href: "/admin", labelKey: "admin" }] : []),
  ];

  const isActive = (href: string) => {
    if (href === "/settings/profile") return pathname === "/settings" || pathname === "/settings/profile";
    if (href === "/settings/apps") {
      return pathname === "/settings/apps" || (pathname.startsWith("/settings/apps/") && !pathname.startsWith("/settings/apps-list"));
    }
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  const userSections: Section[] = hasUserContext ? [...USER_SECTIONS] : [];
  const adminSections: Section[] = isAdmin ? [...ADMIN_SECTIONS] : [];

  const renderItem = (section: Section) => {
    const Icon = section.icon;
    const active = isActive(section.href);
    return (
      <div key={section.id}>
        <Link
          href={section.href}
          aria-current={active && !(section.id === "ai" && inAI) ? "page" : undefined}
          className={cn(
            "settings-nav-item flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
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
                className={cn("settings-nav-item flex min-h-9 items-center rounded-md px-2.5 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  selected ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
                {aiNavigation(item.labelKey)}
              </Link>;
            })}
          </nav>
        )}
      </div>
    );
  };

  // Phone: one row per section, grouped like a phone's own settings; a short hint says what is inside.
  const renderRow = (section: Section) => {
    const Icon = section.icon;
    return (
      <li key={section.id}>
        <Link href={section.href} className="settings-row">
          <span className="settings-row-icon" aria-hidden="true"><Icon className="size-[18px]" /></span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-foreground">{navigation(section.id)}</span>
            <span className="block truncate text-[13px] text-muted-foreground">{navigation(`hint.${section.id}`)}</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Link>
      </li>
    );
  };

  const group = (labelKey: "you" | "thisServer", sections: Section[]) => sections.length > 0 && (
    <section aria-labelledby={`settings-group-${labelKey}`} className="space-y-2">
      <h2 id={`settings-group-${labelKey}`} className="px-1 text-[13px] font-medium text-muted-foreground">{navigation(labelKey)}</h2>
      <ul className="settings-group">{sections.map(renderRow)}</ul>
    </section>
  );

  return (
    <div className="settings-workspace mx-auto flex w-full max-w-[120rem] flex-col gap-4 px-4 py-4 md:flex-row md:gap-8 md:px-6 md:py-8 xl:gap-12 xl:px-10">
      {atRoot ? (
        <nav aria-label={translateInterface("m74a883a037bc")} className="space-y-6 md:hidden">
          <h1 className="px-1 text-[1.75rem] font-semibold leading-tight tracking-tight">{navigation("title")}</h1>
          {group("you", userSections)}
          {group("thisServer", adminSections)}
          <p className="px-1 text-[13px] text-muted-foreground">{navigation("signedInAs", { username })}</p>
        </nav>
      ) : parent ? null : (
        <div className="md:hidden">
          <Link href="/settings" className="settings-back">
            <ChevronLeft className="size-5" aria-hidden="true" />
            {navigation("title")}
          </Link>
        </div>
      )}

      <nav aria-label={translateInterface("m74a883a037bc")} className="hidden w-full shrink-0 md:block md:w-52">
        <div className="space-y-1 md:sticky md:top-20 md:max-h-[calc(100dvh-6rem)] md:overflow-y-auto md:px-1 md:pb-4">
          <p className="px-3 pb-5 text-lg font-semibold tracking-tight text-foreground">{translateInterface("m74a883a037bc")}</p>
          {userSections.length > 0 && (
            <>
              <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">{navigation("you")}</p>
              {userSections.map(renderItem)}
            </>
          )}

          {adminSections.length > 0 && (
            <>
              {userSections.length > 0 && <div className="my-3 border-t" />}
              <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">{navigation("thisServer")}</p>
              {adminSections.map(renderItem)}
            </>
          )}

          <div className="mt-4 border-t pt-3">
            <p className="truncate px-3 text-xs text-muted-foreground">{username}</p>
          </div>
        </div>
      </nav>

      <main className={cn("settings-main min-w-0 flex-1 pb-8", atRoot && "hidden md:block")} data-settings-page={pathname}>
        {appPage ? (
          // An app's own sub-page (its title studio) leads back to that app's page.
          <Link href={appPage} className="settings-back mb-2">
            <ChevronLeft className="size-5" aria-hidden="true" />
            {navigation("back")}
          </Link>
        ) : parent && (
          <Link href={parent.href} className="settings-back mb-2">
            <ChevronLeft className="size-5" aria-hidden="true" />
            {navigation(parent.id)}
          </Link>
        )}
        {children}
      </main>
    </div>
  );
}
