/**
 * Web App Manifest — Dynamic PWA manifest generated from branding config.
 *
 * Next.js automatically serves this at /manifest.webmanifest and links it
 * in the document head. The manifest is dynamic because branding (name,
 * accent color, icon) is user-configurable via the setup wizard and settings.
 */

import type { MetadataRoute } from "next";
import { getBranding } from "@/lib/db/queries/branding";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  let siteName = "YouEye";
  let accentColor = "#8B5CF6";

  try {
    const branding = await getBranding();
    siteName = branding.site_name || "YouEye";
    accentColor = branding.accent_color || "#8B5CF6";
  } catch {
    // DB may not be ready (fresh deploy) — use defaults
  }

  return {
    name: siteName,
    short_name: siteName,
    description: "Your self-hosted personal dashboard",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0f",
    theme_color: accentColor,
    orientation: "any",
    icons: [
      {
        src: "/api/v1/branding/icon?size=192",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/api/v1/branding/icon?size=512",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/api/v1/branding/icon?size=512&maskable=1",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
