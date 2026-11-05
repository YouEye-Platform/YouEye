import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { designSchema, type Design } from "./lib/design";
import { fontForText, supportsText } from "./lib/coverage";
import { registerFont, getFont } from "./lib/fonts";
export { renderSvg } from "./lib/render";

/** Load only pinned local font bytes, for the same renderer used in the browser. */
export async function prepareDesign(input: unknown, fontDirectory: string): Promise<Design> {
  const d = designSchema.parse(input);
  if (!supportsText(d.font, d.uppercase ? d.name.toUpperCase() : d.name)) throw new Error("This font cannot display the full title");
  const monogram = d.icon.mode === "monogram" ? fontForText(d.font, d.icon.letters || Array.from(d.name)[0]) : undefined;
  if (d.icon.mode === "monogram" && !monogram) throw new Error("These initials are not supported by the font catalogue");
  for (const font of new Set([d.font, "spacegrotesk", "oswald", ...(monogram ? [monogram] : [])])) {
    if (getFont(font)) continue;
    const bytes = await readFile(join(fontDirectory, `${font}.ttf`));
    registerFont(font, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }
  return d;
}
