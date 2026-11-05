"use client";

import { useEffect, useState } from "react";
import { TitleStudio, initialDesign } from "@youeye/branding/studio";
import { designSchema, type Design } from "@youeye/branding";
import { Button } from "@/components/ui/button";
import { DEFAULT_STYLE, type SiteNameStyle } from "@/lib/wordart-presets";
import { notifyAppearanceSaved } from "@youeye/branding/appearance-events";
import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useRef as useInterfaceTranslationRef } from "react";

type Branding = { site_name: string; site_name_style: SiteNameStyle | null; accent_color: string };

export function BrandingEmbedClient() {
  const translateInterface = useInterfaceTranslations("interface");
  const interfaceTranslationRef = useInterfaceTranslationRef(translateInterface);
  interfaceTranslationRef.current = translateInterface;

  const [branding, setBranding] = useState<Branding | null>(null);
  const [design, setDesign] = useState<Design | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  useEffect(() => {
    let active = true;
    fetch("/api/ui/branding", { cache: "no-store" }).then(async (res) => {
      if (!res.ok) throw new Error(interfaceTranslationRef.current("m1de8bddcc9e8"));
      const data: Branding = await res.json();
      const saved = designSchema.safeParse(data.site_name_style?.mytitle);
      if (active) { setBranding(data); setDesign(saved.success ? saved.data : initialDesign(data.site_name)); }
    }).catch((error) => { if (active) setStatus(error.message); });
    return () => { active = false; };
  }, []);
  async function save() {
    if (!branding || !design || saving) return;
    setSaving(true); setStatus("");
    try {
      const res = await fetch("/api/ui/branding", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          site_name: design.name,
          site_name_style: { ...(branding.site_name_style || DEFAULT_STYLE), mytitle: design },
          expected_revision: branding.site_name_style?.mytitleRevision ?? null,
          accent_color: branding.accent_color,
        }),
      });
      if (!res.ok) throw new Error(res.status === 409 ? translateInterface("m17101f149928") : translateInterface("m1256d1e0b264"));
      setBranding(await res.json()); setStatus(translateInterface("mb5c120b316c2"));
      notifyAppearanceSaved();
    } catch (error) { setStatus(error instanceof Error ? error.message : translateInterface("m53ad6f999b1f")); }
    finally { setSaving(false); }
  }
  return <main className="p-4 sm:p-6">
    {design ? <TitleStudio design={design} onChange={setDesign} /> : <p role="status">{status || translateInterface("m46d225580e5b")}</p>}
    <div className="studio-save-bar mt-4 flex items-center gap-3">
      <Button onClick={() => void save()} disabled={!design || saving}>{saving ? translateInterface("m23e39291d613") : translateInterface("mdec2db9309ac")}</Button>
      {design && <p role="status">{status}</p>}
    </div>
  </main>;
}
