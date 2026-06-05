export const SETTINGS_BASE_PATH = "/settings";
export const MARKET_BASE_PATH = "/market";

export function isSettingsPath(pathname: string): boolean {
  return (
    pathname === SETTINGS_BASE_PATH ||
    pathname.startsWith(`${SETTINGS_BASE_PATH}/`) ||
    pathname === MARKET_BASE_PATH ||
    pathname.startsWith(`${MARKET_BASE_PATH}/`)
  );
}

export function withSettingsBase(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${SETTINGS_BASE_PATH}${normalized === "/" ? "" : normalized}`;
}

export function getControlPublicUrl(request?: Request): string {
  const configured =
    process.env.CONTROL_PUBLIC_URL ||
    process.env.CONTROL_EXTERNAL_URL ||
    "";

  if (configured) {
    return configured.replace(/\/$/, "");
  }

  if (request) {
    const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
    if (host && !host.startsWith("0.0.0.0")) {
      const proto = request.headers.get("x-forwarded-proto") || "https";
      return `${proto}://${host}`;
    }

    const url = new URL(request.url);
    return `${url.protocol}//${url.host}`;
  }

  return "";
}

export function getSettingsPublicUrl(request?: Request): string {
  const configured = process.env.CONTROL_PUBLIC_URL;
  if (configured) {
    const trimmed = configured.replace(/\/$/, "");
    return trimmed.endsWith(SETTINGS_BASE_PATH)
      ? trimmed
      : `${trimmed}${SETTINGS_BASE_PATH}`;
  }

  if (request) {
    const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
    if (host && !host.startsWith("0.0.0.0")) {
      const proto = request.headers.get("x-forwarded-proto") || "https";
      return `${proto}://${host}${SETTINGS_BASE_PATH}`;
    }

    const url = new URL(request.url);
    return `${url.protocol}//${url.host}${SETTINGS_BASE_PATH}`;
  }

  const control = getControlPublicUrl();
  return control ? `${control}${SETTINGS_BASE_PATH}` : SETTINGS_BASE_PATH;
}
