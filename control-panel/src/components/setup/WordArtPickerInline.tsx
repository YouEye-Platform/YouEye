"use client";

import { TitleStudio, initialDesign } from "@youeye/branding/studio";
import type { ComponentProps } from "react";
import type { SiteNameStyle } from "@/lib/wordart-presets";

/** Compatibility entrypoint: every old picker now opens the canonical studio. */
export default function WordArtPickerInline({ siteName, style, setStyle, subject }: {
  siteName: string; style: SiteNameStyle; setStyle: (style: SiteNameStyle) => void;
  subject?: ComponentProps<typeof TitleStudio>["subject"];
}) {
  return <TitleStudio subject={subject} design={style.mytitle || initialDesign(siteName)} onChange={(mytitle) => setStyle({ ...style, mytitle })} />;
}
