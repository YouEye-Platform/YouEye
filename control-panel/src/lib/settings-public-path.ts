export const SETTINGS_BASE_PATH = "/settings";

export function isSettingsPath(pathname: string): boolean {
  return pathname === SETTINGS_BASE_PATH || pathname.startsWith(`${SETTINGS_BASE_PATH}/`);
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
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}${SETTINGS_BASE_PATH}`;
  }

  const control = getControlPublicUrl();
  return control ? `${control}${SETTINGS_BASE_PATH}` : SETTINGS_BASE_PATH;
}
