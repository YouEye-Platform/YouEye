import { designSchema } from "@youeye/branding";
import type { SiteNameStyle } from "@/lib/db/queries/branding";

/** Keep CSS-only styles as they are; validate every MyTitle design. */
export function validateStudioStyle(style: SiteNameStyle): SiteNameStyle {
  if (!style || typeof style !== "object" || Array.isArray(style)) throw new Error("Invalid appearance");
  if (style.mytitle === undefined) return style;
  return { ...style, mytitle: designSchema.parse(style.mytitle) };
}
