/**
 * Service Worker - YouEye UI PWA
 */
/// <reference lib="webworker" />

export {};

type PrecacheEntry = string | { url: string; revision?: string | null; integrity?: string };
type Strategy = "cache-first" | "network-first" | "stale-while-revalidate";

interface RuntimeRule {
  cacheName: string;
  maxEntries: number;
  strategy: Strategy;
  match: (url: URL, request: Request) => boolean;
}

declare const self: ServiceWorkerGlobalScope & {
  __SW_MANIFEST?: PrecacheEntry[];
};

const CACHE_PREFIX = "youeye-ui";
const PRECACHE_CACHE = `${CACHE_PREFIX}-precache-v1`;
const PAGE_CACHE = `${CACHE_PREFIX}-pages`;
const OFFLINE_URL = "/offline";
const PRECACHE_ENTRIES = self.__SW_MANIFEST || [];

const runtimeRules: RuntimeRule[] = [
  {
    cacheName: "ui-static-assets",
    maxEntries: 200,
    strategy: "cache-first",
    match: (url) => url.origin === self.location.origin && url.pathname.startsWith("/_next/static/"),
  },
  {
    cacheName: "ui-fonts",
    maxEntries: 30,
    strategy: "cache-first",
    match: (url) => url.origin === self.location.origin && url.pathname.startsWith("/fonts/"),
  },
  {
    cacheName: "ui-branding-icons",
    maxEntries: 10,
    strategy: "stale-while-revalidate",
    match: (url) => url.origin === self.location.origin && url.pathname.startsWith("/api/v1/branding/icon"),
  },
  {
    cacheName: "ui-api-cache",
    maxEntries: 50,
    strategy: "network-first",
    match: (url) => url.origin === self.location.origin && url.pathname.startsWith("/api/"),
  },
];

const cachesToKeep = new Set([
  PRECACHE_CACHE,
  PAGE_CACHE,
  ...runtimeRules.map((rule) => rule.cacheName),
]);

function getEntryUrl(entry: PrecacheEntry): string {
  return typeof entry === "string" ? entry : entry.url;
}

function createPrecacheRequest(entry: PrecacheEntry): Request {
  return new Request(new URL(getEntryUrl(entry), self.location.origin).href, {
    cache: "reload",
    credentials: "same-origin",
    integrity: typeof entry === "string" ? undefined : entry.integrity || undefined,
  });
}

async function trimCache(cacheName: string, maxEntries: number): Promise<void> {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const extra = keys.length - maxEntries;
  if (extra > 0) {
    await Promise.all(keys.slice(0, extra).map((request) => cache.delete(request)));
  }
}

async function cacheResponse(
  cacheName: string,
  request: Request,
  response: Response,
  maxEntries: number,
): Promise<void> {
  if (!response || (!response.ok && response.type !== "opaque")) return;
  const cache = await caches.open(cacheName);
  await cache.put(request, response.clone());
  await trimCache(cacheName, maxEntries);
}

async function matchPrecache(request: Request): Promise<Response | undefined> {
  const requestUrl = new URL(request.url, self.location.origin);
  requestUrl.hash = "";

  const entry = PRECACHE_ENTRIES.find((candidate) => {
    const candidateUrl = new URL(getEntryUrl(candidate), self.location.origin);
    candidateUrl.hash = "";
    return candidateUrl.href === requestUrl.href;
  });

  const cache = await caches.open(PRECACHE_CACHE);
  return entry ? cache.match(createPrecacheRequest(entry)) : cache.match(request);
}

async function cacheFirst(request: Request, rule: RuntimeRule): Promise<Response> {
  const cache = await caches.open(rule.cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  await cacheResponse(rule.cacheName, request, response, rule.maxEntries);
  return response;
}

async function networkFirst(
  request: Request,
  cacheName: string,
  maxEntries: number,
  fallbackUrl?: string,
): Promise<Response> {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);
    await cacheResponse(cacheName, request, response, maxEntries);
    return response;
  } catch (error) {
    console.warn("[sw] Network request failed, using cache if available", error);
    const cached = await cache.match(request);
    if (cached) return cached;

    if (fallbackUrl) {
      const fallback = await matchPrecache(new Request(fallbackUrl, { credentials: "same-origin" }));
      if (fallback) return fallback;
    }

    return new Response("Offline", { status: 503, statusText: "Service Unavailable" });
  }
}

async function staleWhileRevalidate(request: Request, rule: RuntimeRule): Promise<Response> {
  const cache = await caches.open(rule.cacheName);
  const cached = await cache.match(request);
  const fresh = fetch(request)
    .then(async (response) => {
      await cacheResponse(rule.cacheName, request, response, rule.maxEntries);
      return response;
    })
    .catch((error) => {
      console.warn("[sw] Background refresh failed", error);
      return undefined;
    });

  if (cached) {
    void fresh;
    return cached;
  }

  return (await fresh) || new Response("Offline", { status: 503, statusText: "Service Unavailable" });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await caches.delete(PRECACHE_CACHE);
      const cache = await caches.open(PRECACHE_CACHE);
      await Promise.all(
        PRECACHE_ENTRIES.map(async (entry) => {
          const request = createPrecacheRequest(entry);
          const response = await fetch(request);
          if (response.ok) await cache.put(request, response);
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((cacheName) => cacheName.startsWith(`${CACHE_PREFIX}-`) && !cachesToKeep.has(cacheName))
          .map((cacheName) => caches.delete(cacheName)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (!url.protocol.startsWith("http")) return;

  event.respondWith(
    (async () => {
      const precached = await matchPrecache(request);
      if (precached) return precached;

      if (request.mode === "navigate") {
        return networkFirst(request, PAGE_CACHE, 25, OFFLINE_URL);
      }

      const rule = runtimeRules.find((candidate) => candidate.match(url, request));
      if (!rule) return fetch(request);

      if (rule.strategy === "cache-first") return cacheFirst(request, rule);
      if (rule.strategy === "network-first") return networkFirst(request, rule.cacheName, rule.maxEntries);
      return staleWhileRevalidate(request, rule);
    })(),
  );
});
