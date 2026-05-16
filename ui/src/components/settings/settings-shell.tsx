/**
 * Settings Shell
 *
 * Sidebar + content layout for the settings page.
 * The sticky top bar is removed — replaced by the persistent Navbar
 * rendered in the settings layout.
 * Sidebar sections change based on admin status.
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  User,
  Palette,
  LayoutGrid,
  Users,
  Server,
  Store,
  ArrowLeft,
  Globe,
  Languages,
  ExternalLink,
  Info,
} from "lucide-react";

/** Section definitions use labelKey to look up translations at render time */
const USER_SECTIONS = [
  { id: "profile", labelKey: "profile" as const, icon: User, href: "/settings" },
  { id: "appearance", labelKey: "appearance" as const, icon: Palette, href: "/settings/appearance" },
  { id: "apps", labelKey: "apps" as const, icon: LayoutGrid, href: "/settings/apps" },
  { id: "language", labelKey: "language" as const, icon: Languages, href: "/settings/language" },
];

const ADMIN_SECTIONS = [
  { id: "users", labelKey: "users" as const, icon: Users, href: "/settings/users" },
  { id: "system", labelKey: "system" as const, icon: Server, href: "/settings/system" },
  { id: "network", labelKey: "network" as const, icon: Globe, href: "/settings/network" },
  { id: "about", labelKey: "about" as const, icon: Info, href: "/settings/about" },
  { id: "market", labelKey: "appMarket" as const, icon: Store, href: "/app-market" },
];

interface SettingsShellProps {
  children: React.ReactNode;
  isAdmin: boolean;
  username: string;
}

export function SettingsShell({ children, isAdmin }: SettingsShellProps) {
  const pathname = usePathname();
  const ts = useTranslations("settings.sections");
  const ta = useTranslations("settings.admin");
  const tn = useTranslations("nav");
  const cpUrl = isAdmin
    ? (process.env.NEXT_PUBLIC_CP_ORIGIN || null)
    : null;

  const isActive = (href: string) => {
    if (href === "/settings") return pathname === "/settings";
    if (href === "/settings/apps") {
      return pathname === "/settings/apps" || pathname.startsWith("/settings/apps/");
    }
    return pathname.startsWith(href);
  };

  return (
    <div className="max-w-7xl mx-auto flex gap-8 px-6 py-8">
      {/* Sidebar */}
      <nav className="w-52 shrink-0">
        <div className="sticky top-20 space-y-1">
          {/* Back to Dashboard */}
          <Link
            href="/"
            className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors mb-3"
          >
            <ArrowLeft className="w-4 h-4" />
            {tn("backToDashboard")}
          </Link>

          <div className="border-t mb-3" />

          {USER_SECTIONS.map((section) => {
            const Icon = section.icon;
            const active = isActive(section.href);
            return (
              <Link
                key={section.id}
                href={section.href}
                className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                  active
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                }`}
              >
                <Icon className="w-4 h-4" />
                {ts(section.labelKey)}
              </Link>
            );
          })}

          {isAdmin && (
            <>
              <div className="my-3 border-t" />
              <p className="px-3 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {ts("admin")}
              </p>
              {ADMIN_SECTIONS.map((section) => {
                const Icon = section.icon;
                const active = isActive(section.href);
                return (
                  <Link
                    key={section.id}
                    href={section.href}
                    className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                      active
                        ? "bg-accent text-accent-foreground font-medium"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {ta(section.labelKey)}
                  </Link>
                );
              })}

              {/* Control Panel external link */}
              {cpUrl && (
                <>
                  <div className="my-3 border-t" />
                  <a
                    href={cpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" />
                    {tn("controlPanel")}
                  </a>
                </>
              )}
            </>
          )}
        </div>
      </nav>

      {/* Content */}
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
