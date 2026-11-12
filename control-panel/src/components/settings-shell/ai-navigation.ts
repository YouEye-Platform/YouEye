// Pointer's embedded routes use the Settings shell for navigation. Keep this
// list aligned with Pointer's public embedded screens; access stays server-side.
export const AI_SECTIONS = [
  { href: "/models", labelKey: "models" },
  { href: "/providers", labelKey: "providers" },
  { href: "/instances", labelKey: "instances" },
  { href: "/groups", labelKey: "groups" },
  { href: "/routing", labelKey: "routing" },
  { href: "/dashboard", labelKey: "dashboard" },
  { href: "/test-model", labelKey: "testModel" },
] as const;

export function isAISectionActive(pathname: string, href: string) {
  const relative = pathname.replace(/^\/settings\/ai(?=\/|$)/, "") || "/models";
  const canonical = relative === "/keys" || relative.startsWith("/keys/") ? "/instances"
    : ["/playground", "/compare", "/chat"].includes(relative) ? "/test-model"
    : ["/usage", "/diagnostics"].includes(relative) ? "/dashboard"
    : relative.startsWith("/connections") ? relative.replace("/connections", "/providers") : relative;
  return canonical === href || canonical.startsWith(href + "/");
}
