/**
 * Client Providers
 *
 * Wraps the app with:
 * 1. ThemeProvider (next-themes) — dark/light/system mode
 * 2. ColorThemeProvider — color theme selection (Zinc, Violet, Ocean, etc.)
 *
 * next-themes handles SSR hydration, system preference detection,
 * and localStorage persistence automatically.
 * ColorThemeProvider injects CSS custom properties for the selected color palette.
 */

"use client";

import { ThemeProvider } from "next-themes";
import { ColorThemeProvider } from "@/components/color-theme-provider";
import { Toaster } from "@/components/ui/sonner";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      <ColorThemeProvider>
        {children}
        <Toaster />
      </ColorThemeProvider>
    </ThemeProvider>
  );
}
