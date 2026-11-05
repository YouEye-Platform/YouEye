import type { Design } from "./lib/design";
import type { BrandingMessageKey, BrandingTranslator } from "./messages";

// Values remain renderer/document identifiers. Only their display names change.
// Exhaustive catalog tests bind these dynamic keys to the actual option lists.
export const paletteLabel = (t: BrandingTranslator, name: string) =>
  t(`palette.${name}` as BrandingMessageKey);
export const symbolLabel = (t: BrandingTranslator, id: string) =>
  t(`symbol.${id}` as BrandingMessageKey);
export const categoryLabel = (t: BrandingTranslator, id: string) =>
  t(`mark.category.${id}` as BrandingMessageKey);
export const iconFinishLabel = (t: BrandingTranslator, id: Design["icon"]["finish"]) =>
  t(`iconFinish.${id}`);
export const iconShapeLabel = (t: BrandingTranslator, id: Design["icon"]["shape"]) =>
  t(`iconShape.${id}`);
