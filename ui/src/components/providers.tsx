/**
 * Client Providers
 *
 * Wraps the app with:
 * 1. ThemeProvider (next-themes) — dark/light/system mode
 * 2. ColorThemeProvider — color theme selection (Zinc, Violet, Ocean, etc.)
 * 3. TelemetryProvider — usage tracking for private beta (temporary)
 *
 * next-themes handles SSR hydration, system preference detection,
 * and localStorage persistence automatically.
 * ColorThemeProvider injects CSS custom properties for the selected color palette.
 */

"use client";

import { ThemeProvider } from "next-themes";
import { ColorThemeProvider } from "@/components/color-theme-provider";
import { InstallBanner } from "@/components/pwa/install-banner";
import { TelemetryProvider } from "@/components/telemetry/telemetry-provider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <ColorThemeProvider>
        <TelemetryProvider>
          {children}
          <InstallBanner />
        </TelemetryProvider>
      </ColorThemeProvider>
    </ThemeProvider>
  );
}
