/**
 * Web App Manifest — CP PWA
 *
 * Minimal PWA manifest for the Control Panel. Reads site name from
 * Spine config so the installed app matches the user's chosen branding.
 */

import type { MetadataRoute } from "next";
import { getSiteConfig } from "@/lib/site-config";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  let siteName = "YouEye";

  try {
    const config = await getSiteConfig();
    siteName = config.site_name || "YouEye";
  } catch {
    // Spine may not be ready — use defaults
  }

  return {
    name: `${siteName} Control Panel`,
    short_name: `${siteName} Control`,
    description: "Manage your self-hosted infrastructure",
    start_url: "/",
    display: "standalone",
    background_color: "#f9fafb",
    theme_color: "#2563eb",
    orientation: "any",
    icons: [
      {
        src: "/api/branding/favicon?size=192",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/api/branding/favicon?size=512",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/api/branding/favicon?size=512&maskable=1",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
