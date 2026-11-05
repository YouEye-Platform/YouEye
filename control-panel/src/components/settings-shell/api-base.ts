"use client";

export function uiSettingsApi(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (typeof window !== "undefined" && window.location.pathname.startsWith("/settings")) {
    return `/settings/api/ui-settings${normalized}`;
  }
  return `/api/ui-settings${normalized}`;
}
