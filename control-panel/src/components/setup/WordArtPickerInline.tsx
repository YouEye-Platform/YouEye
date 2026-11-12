"use client";

import { TitleStudio, initialDesign } from "@youeye/branding/studio";
import type { SiteNameStyle } from "@/lib/wordart-presets";

/** Compatibility entrypoint: every old picker now opens the canonical studio. */
export default function WordArtPickerInline({ siteName, style, setStyle }: {
  siteName: string; style: SiteNameStyle; setStyle: (style: SiteNameStyle) => void;
}) {
  return <TitleStudio design={style.mytitle || initialDesign(siteName)} onChange={(mytitle) => setStyle({ ...style, mytitle })} />;
}
