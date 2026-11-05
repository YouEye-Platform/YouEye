import { useTranslations as useInterfaceTranslations } from "next-intl";
/**
 * Navbar — Top navigation bar
 */

import { Clock, Home, LayoutDashboard } from "lucide-react";
import { UserMenu } from "./user-menu";
import { NotificationBell } from "./notification-bell";
import { DrawerAndLauncher } from "./drawer-and-launcher";
import { HeaderBrand } from "./header-brand";
import { MobileAccountSheet } from "./mobile-account-sheet";
import { Button } from "@/components/ui/button";
import type { SiteNameStyle } from "@/lib/db/queries/branding";
import Link from "next/link";

interface NavbarProps {
  username: string;
  email: string;
  isAdmin: boolean;
  siteName?: string;
  siteNameStyle?: SiteNameStyle | null;
  logoUrl?: string | null;
  showLogo?: boolean;
}

export function Navbar({
  username,
  email,
  isAdmin,
  siteName = "YouEye",
  siteNameStyle = null,
  logoUrl = null,
  showLogo = false,
}: NavbarProps) {
  const translateInterface = useInterfaceTranslations("interface");

  return (
    <>
      <header className="sticky top-0 z-50 flex h-14 items-center justify-between border-b border-border/40 bg-background/95 px-4 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
            <HeaderBrand initial={{ site_name: siteName, site_name_style: siteNameStyle, logo_url: showLogo ? logoUrl : null }} />
          </Link>
        </div>

        <div className="ye-mobile-shell-desktop flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-9 w-9" asChild>
            <Link href="/" title={translateInterface("m3a78695388b3")}>
              <Home className="h-4 w-4" />
            </Link>
          </Button>
          <DrawerAndLauncher isAdmin={isAdmin} />
          <NotificationBell />
          <UserMenu username={username} email={email} isAdmin={isAdmin} />
        </div>
      </header>

      <div className="ye-mobile-shell-only fixed inset-x-0 bottom-0 z-50 items-center gap-2 border-t border-border/60 bg-background/95 px-2 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur-xl">
        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <Link
            href="/"
            className="inline-flex h-12 min-w-12 items-center justify-center gap-2 rounded-2xl px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={translateInterface("m67b696468610")}
          >
            <LayoutDashboard className="size-4" />
            <span className="max-[420px]:hidden">{translateInterface("m67b696468610")}</span>
          </Link>
          <Link
            href="/timeline"
            className="inline-flex h-12 min-w-12 items-center justify-center gap-2 rounded-2xl px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={translateInterface("m9dcff98e275f")}
          >
            <Clock className="size-4" />
            <span className="max-[420px]:hidden">{translateInterface("m9dcff98e275f")}</span>
          </Link>
        </nav>
        <MobileAccountSheet username={username} email={email} isAdmin={isAdmin} />
      </div>
      <div className="ye-mobile-shell-spacer" aria-hidden="true" />
    </>
  );
}
