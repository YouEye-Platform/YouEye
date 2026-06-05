"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeftRight,
  Box,
  Clock,
  Globe,
  HardDrive,
  KeyRound,
  Languages,
  LayoutGrid,
  Lock,
  PackageOpen,
  Paintbrush,
  Palette,
  Server,
  Shield,
  Store,
  User,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

const USER_SECTIONS = [
  { id: "profile", label: "Profile", icon: User, href: "/settings" },
  { id: "appearance", label: "Appearance", icon: Palette, href: "/settings/appearance" },
  { id: "apps", label: "Apps", icon: LayoutGrid, href: "/settings/apps" },
  { id: "accounts", label: "Accounts", icon: KeyRound, href: "/settings/accounts" },
  { id: "timeline", label: "Timeline", icon: Clock, href: "/timeline", external: true },
  { id: "privacy", label: "Privacy", icon: Shield, href: "/settings/privacy" },
  { id: "language", label: "Language", icon: Languages, href: "/settings/language" },
  { id: "branding", label: "Branding", icon: Paintbrush, href: "/settings/branding" },
];

const ADMIN_SECTIONS = [
  { id: "users", label: "Users", icon: Users, href: "/settings/users" },
  { id: "system", label: "System", icon: Server, href: "/settings/system" },
  { id: "containers", label: "Containers", icon: Box, href: "/settings/containers" },
  { id: "dns", label: "DNS", icon: Globe, href: "/settings/dns" },
  { id: "proxy", label: "Proxy", icon: ArrowLeftRight, href: "/settings/proxy" },
  { id: "tls", label: "TLS", icon: Lock, href: "/settings/tls" },
  { id: "backup", label: "Backup", icon: HardDrive, href: "/settings/backup" },
  { id: "app-management", label: "App Management", icon: PackageOpen, href: "/settings/app-management" },
  { id: "market", label: "App Market", icon: Store, href: "/market" },
];

interface SettingsShellProps {
  children: React.ReactNode;
  isAdmin: boolean;
  username: string;
}

export function SettingsShell({ children, isAdmin, username }: SettingsShellProps) {
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
            ? "bg-accent text-accent-foreground font-medium"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
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
          {USER_SECTIONS.map(renderItem)}

          {isAdmin && (
            <>
              <div className="my-3 border-t" />
              <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Admin
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
