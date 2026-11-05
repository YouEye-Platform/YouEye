"use client";
import { TitleStudio, initialDesign } from "@youeye/branding/studio";
import type { SiteNameStyle } from "@/lib/wordart-presets";
export default function SetupWordArt({ siteName, style, setStyle, onNext, onBack }: {
  siteName: string; style: SiteNameStyle; setStyle: (style: SiteNameStyle) => void; onNext: () => void; onBack: () => void;
}) { return <TitleStudio design={style.mytitle || initialDesign(siteName)} onChange={(mytitle) => setStyle({ ...style, mytitle })} onContinue={onNext} onBack={onBack} />; }
