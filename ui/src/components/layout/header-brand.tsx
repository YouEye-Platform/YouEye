"use client";

import { useEffect, useState } from "react";
import type { SiteNameStyle } from "@/lib/db/queries/branding";
import { SiteName } from "./site-name";
import { subscribeAppearanceChanges } from "@youeye/branding/appearance-events";

export interface HeaderBranding {
  site_name: string;
  site_name_style: SiteNameStyle | null;
  logo_url: string | null;
}

/** Re-read the acting user's title after saves and when returning to an open tab. */
export function HeaderBrand({ initial }: { initial: HeaderBranding }) {
  const [branding, setBranding] = useState(initial);
  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = async () => {
      const current = ++request;
      try {
        const res = await fetch("/api/v1/header/config", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (active && current === request) setBranding(data.branding);
      } catch { /* Retain the last confirmed appearance until readback succeeds. */ }
    };
    void refresh();
    const unsubscribe = subscribeAppearanceChanges(() => { void refresh(); });
    return () => { active = false; unsubscribe(); };
  }, [initial]);
  return <>
    {branding.logo_url && <img src={branding.logo_url} alt="" className="w-6 h-6 object-contain" />}
    <SiteName name={branding.site_name} style={branding.site_name_style} />
  </>;
}
