/** Only resume a login at an appliance-owned origin. Never trust a form's return URL. */
export function safeLoginReturnTo(value: string | null, fallback: string, allowedOrigins: Iterable<string>): string {
  if (!value) return fallback;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !Array.from(allowedOrigins).includes(url.origin)) {
      return fallback;
    }
    return url.toString();
  } catch {
    return fallback;
  }
}
