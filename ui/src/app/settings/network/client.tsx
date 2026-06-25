"use client";

import { useState } from "react";
import { Globe, Lock } from "lucide-react";
import { AdminEmbed } from "@/components/settings/admin-embed";

interface NetworkTabsProps {
  dnsUrl: string;
  tlsUrl: string;
}

const TABS = [
  { id: "dns" as const, label: "DNS", icon: Globe },
  { id: "tls" as const, label: "TLS", icon: Lock },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function NetworkTabs({ dnsUrl, tlsUrl }: NetworkTabsProps) {
  const [active, setActive] = useState<TabId>("dns");

  return (
    <div>
      <div className="flex items-center gap-1 border-b mb-6">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                isActive
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30"
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className={active === "dns" ? "" : "hidden"}>
        <AdminEmbed signedUrl={dnsUrl} title="DNS" />
      </div>
      <div className={active === "tls" ? "" : "hidden"}>
        <AdminEmbed signedUrl={tlsUrl} title="TLS Certificates" />
      </div>
    </div>
  );
}
