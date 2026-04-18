"use client";

import { useState } from "react";
import type { SiteNameStyle } from "@/lib/db/queries/branding";
import { UserWordartSettings } from "./user-wordart-settings";
import { AdminEmbed } from "./admin-embed";

interface BrandingTabsProps {
  siteName: string;
  serverDefault: SiteNameStyle;
  isAdmin: boolean;
  serverBrandingUrl: string | null;
}

export function BrandingTabs({ siteName, serverDefault, isAdmin, serverBrandingUrl }: BrandingTabsProps) {
  const [tab, setTab] = useState<"my-wordart" | "server-branding">("my-wordart");

  return (
    <div className="space-y-6">
      <div className="flex gap-1 border-b">
        <button
          onClick={() => setTab("my-wordart")}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "my-wordart"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          My WordArt
        </button>
        {isAdmin && serverBrandingUrl && (
          <button
            onClick={() => setTab("server-branding")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === "server-branding"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Server Branding
          </button>
        )}
      </div>

      {tab === "my-wordart" && (
        <UserWordartSettings siteName={siteName} serverDefault={serverDefault} />
      )}

      {tab === "server-branding" && isAdmin && serverBrandingUrl && (
        <AdminEmbed signedUrl={serverBrandingUrl} title="Server Branding" minHeight={500} />
      )}
    </div>
  );
}
