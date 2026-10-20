/** Only identity-independent assets may enter a persistent browser cache. */
export function isPublicAsset(url: URL, origin: string): boolean {
  return url.origin === origin && !url.search &&
    (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/fonts/") ||
      url.pathname.startsWith("/icons/"));
}

export function isPublicPrecache(url: URL, origin: string): boolean {
  return isPublicAsset(url, origin) ||
    (url.origin === origin && url.pathname === "/offline.html" && !url.search);
}

/** Bypass HTTP caching without replacing the page referrer with the worker context. */
export function privateNetworkRequest(request: Request): Request {
  return new Request(request, {
    cache: "no-store",
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
  });
}
