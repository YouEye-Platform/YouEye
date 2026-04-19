/**
 * Color Theme Provider
 *
 * React context that manages the user's color theme selection.
 * On mount: fetches the active theme from /api/v1/themes/active
 * and injects CSS custom properties into the <html> element.
 *
 * This is separate from next-themes (which handles dark/light mode).
 * The color theme defines WHICH colors to use; dark/light mode defines
 * which variant of those colors is active.
 */

"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
} from "react";
import { useTheme } from "next-themes";
import type { ThemeColors } from "@/db/schema";

interface ActiveTheme {
  id: string;
  name: string;
  colors: ThemeColors;
  isPreset: boolean;
  cssVariables: string;
}

interface ColorThemeContextValue {
  /** Currently active color theme */
  activeTheme: ActiveTheme | null;
  /** Whether the theme is still loading */
  isLoading: boolean;
  /** Switch to a different color theme by ID */
  setColorTheme: (themeId: string) => Promise<void>;
  /** Force refresh the theme from the API */
  refreshTheme: () => Promise<void>;
}

const ColorThemeContext = createContext<ColorThemeContextValue>({
  activeTheme: null,
  isLoading: true,
  setColorTheme: async () => {},
  refreshTheme: async () => {},
});

/**
 * Apply theme colors as CSS custom properties on the <html> element.
 * We inject a <style> element with both :root and .dark selectors
 * so the theme works with next-themes' class-based dark mode.
 */
function applyThemeCSS(cssVariables: string) {
  const STYLE_ID = "ye-color-theme";
  let styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null;

  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = STYLE_ID;
    document.head.appendChild(styleEl);
  }

  styleEl.textContent = cssVariables;
}

export function ColorThemeProvider({ children }: { children: React.ReactNode }) {
  const [activeTheme, setActiveTheme] = useState<ActiveTheme | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const mountedRef = useRef(true);
  const { setTheme: setNextTheme } = useTheme();

  const fetchActiveTheme = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/themes/active");
      if (!res.ok) return;
      const data = await res.json();
      if (!mountedRef.current) return;
      setActiveTheme(data as ActiveTheme);
      applyThemeCSS(data.cssVariables);

      // Sync dark/light/system mode from DB to next-themes
      if (data.mode && ["dark", "light", "system"].includes(data.mode)) {
        setNextTheme(data.mode);
      }

    } catch (err) {
      console.warn("[ColorTheme] Failed to fetch active theme:", err);
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [setNextTheme]);

  const setColorTheme = useCallback(
    async (themeId: string) => {
      try {
        // Optimistic: if we have the theme data already, apply immediately
        const res = await fetch("/api/v1/themes/active", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ themeId }),
        });

        if (!res.ok) {
          console.error("[ColorTheme] Failed to set theme");
          return;
        }

        const data: ActiveTheme = await res.json();
        if (!mountedRef.current) return;
        setActiveTheme(data);
        applyThemeCSS(data.cssVariables);

      } catch (err) {
        console.error("[ColorTheme] Failed to set theme:", err);
      }
    },
    []
  );

  const refreshTheme = useCallback(async () => {
    await fetchActiveTheme();
  }, [fetchActiveTheme]);

  useEffect(() => {
    mountedRef.current = true;
    fetchActiveTheme();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchActiveTheme]);

  return (
    <ColorThemeContext.Provider
      value={{ activeTheme, isLoading, setColorTheme, refreshTheme }}
    >
      {children}
    </ColorThemeContext.Provider>
  );
}

/**
 * Hook to access the current color theme and switch themes.
 */
export function useColorTheme() {
  return useContext(ColorThemeContext);
}

