/** Shared public cookie name; the cookie value remains browser/server-only. */
export const TIMELINE_SESSION_COOKIE = "ye-pin-session";
const sessionPaths = new Set(["pin/create", "pin/status", "pin/session"]);

export function timelineSessionRequestCookie(path: string, value?: string): string | undefined {
  if (!sessionPaths.has(path) || !value ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:[A-Za-z0-9+/=]+$/i.test(value)) return undefined;
  return `${TIMELINE_SESSION_COOKIE}=${value}`;
}

export function timelineSessionResponseCookies(path: string, cookies: string[]): string[] {
  if (!sessionPaths.has(path)) return [];
  return cookies.filter((cookie) => cookie.startsWith(`${TIMELINE_SESSION_COOKIE}=`));
}
