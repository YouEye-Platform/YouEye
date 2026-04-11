/**
 * Navbar — Top navigation bar
 */

import { Home } from "lucide-react";
import { UserMenu } from "./user-menu";
import { NotificationBell } from "./notification-bell";
import { AppDrawer } from "./app-drawer";
import { SiteName } from "./site-name";
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
}

export function Navbar({
  username,
  email,
  isAdmin,
  siteName = "YouEye",
  siteNameStyle = null,
  logoUrl = null,
}: NavbarProps) {
  return (
    <header className="sticky top-0 z-50 flex h-14 items-center justify-between border-b border-border/40 bg-background/95 px-4 backdrop-blur-md">
      <div className="flex items-center gap-3">
        <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          {logoUrl && (
            <img src={logoUrl} alt="" className="w-6 h-6 object-contain" />
          )}
          <SiteName name={siteName} style={siteNameStyle} />
        </Link>
      </div>

      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-9 w-9" asChild>
          <Link href="/" title="Home">
            <Home className="h-4 w-4" />
          </Link>
        </Button>
        <AppDrawer />
        <NotificationBell />
        <UserMenu username={username} email={email} isAdmin={isAdmin} />
      </div>
    </header>
  );
}
