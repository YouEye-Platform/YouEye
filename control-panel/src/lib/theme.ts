/**
 * Shared light/dark/system mode helpers for the Control Panel.
 *
 * Background: the user's mode preference is owned by the UI (DB column
 * `userSettings.settings.themeMode`) and delivered to CP via the CP→UI bridge
 * (`header/config` → `theme.mode`). The dashboard applies it with `next-themes`,
 * which mirrors the value to `localStorage["theme"]`. Because `/settings` is
 * served from the SAME origin as the dashboard, CP can read that same key for a
 * flash-free first paint (see the inline boot script in `app/layout.tsx`) and
 * then reconcile against the bridge value on mount.
 *
 * CP does not depend on `next-themes`; these helpers reproduce just the parts it
 * needs (resolve + apply the class, mirror the storage key) without adding a
 * dependency to the release bundle.
 */

export type ThemeMode = "light" | "dark" | "system";

/** The localStorage key next-themes uses by default — shared with the dashboard. */
export const THEME_STORAGE_KEY = "theme";

/** Custom event CP uses to sync a mode change from the Appearance page to the header. */
export const THEME_MODE_EVENT = "youeye-theme-mode";

export function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** Whether the given mode should render dark right now. */
export function resolveDark(mode: ThemeMode, systemDark: boolean = systemPrefersDark()): boolean {
  return mode === "dark" || (mode === "system" && systemDark);
}

/**
 * Apply the resolved mode to <html> and mirror the choice to the shared
 * localStorage key so the next full-page load paints correctly before React runs.
 */
export function applyThemeMode(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolveDark(mode));
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // localStorage can be unavailable (private mode / storage disabled). The
    // class is already applied above, so theming still works for this load —
    // only the cross-load flash-prevention cache is skipped. Non-critical.
  }
}

/** Broadcast a mode change so the header (which owns the source-of-truth state) can sync. */
export function broadcastThemeMode(mode: ThemeMode): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(THEME_MODE_EVENT, { detail: { mode } }));
}
