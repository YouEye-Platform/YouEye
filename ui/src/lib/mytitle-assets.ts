import "server-only";
import { createHash } from "node:crypto";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { type Design } from "@youeye/branding";
import { prepareDesign, renderSvg } from "@youeye/branding/server";
import { BRANDING_DIR } from "./persistent-assets";
import { ICON_SIZES } from "./icon-config";

// Bump when renderer or asset catalogue changes; prevents stale derived output.
const RENDERER_REVISION = "mytitle-23cb46f6ff839622-v1";
export async function prepareMyTitleAssets(input: Design): Promise<string> {
  const d = await prepareDesign(input, join(process.cwd(), "public/mytitle/fonts"));
  const revision = createHash("sha256").update(RENDERER_REVISION + JSON.stringify(d)).digest("hex");
  const sharp = (await import("sharp")).default;
  if (d.icon.mode === "upload") {
    const bytes = Buffer.from(d.icon.image.split(",")[1] || "", "base64");
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error("Choose a raster image no larger than 2 MB");
    const metadata = await sharp(bytes, { limitInputPixels: 4096 * 4096 }).metadata();
    if (!metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096 ||
        !["png", "jpeg", "webp"].includes(metadata.format || "")) throw new Error("Choose a PNG, JPEG or WebP no larger than 4096 pixels");
  }
  const outputs: [string, Buffer][] = [];
  for (const theme of ["light", "dark"] as const) {
    outputs.push([`mytitle-${revision}-title-${theme}.svg`, Buffer.from(renderSvg(d, theme, "title", "saved", false))]);
  }
  const svg = Buffer.from(renderSvg(d, "light", "icon", "saved", false));
  for (const size of ICON_SIZES) outputs.push([`mytitle-${revision}-${size}.png`, await sharp(svg).resize(size, size).png().toBuffer()]);
  await mkdir(BRANDING_DIR, { recursive: true });
  // Immutable names mean a failed save never changes the previously active look.
  for (const [name, bytes] of outputs) {
    const target = join(BRANDING_DIR, name);
    const staging = `${target}.${crypto.randomUUID()}.tmp`;
    await writeFile(staging, bytes);
    await rename(staging, target);
  }
  return revision;
}
