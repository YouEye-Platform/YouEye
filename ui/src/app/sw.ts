/// <reference lib="webworker" />
/** Public assets work offline; authenticated data and pages always require the server. */
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { CacheFirst, ExpirationPlugin, NetworkOnly, Serwist } from "serwist";
import { isPublicAsset, isPublicPrecache, privateNetworkRequest } from "../lib/pwa-cache-policy";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}
declare const self: ServiceWorkerGlobalScope & typeof globalThis;

const CACHE_PREFIX = "youeye-ui-public-v2";
const STATIC_CACHE = `${CACHE_PREFIX}-assets`;
const legacyPrefixes = ["youeye-ui-", "ui-"];
// Names used by the former Serwist defaultCache, including private RSC/HTML/API data.
const legacyNames = new Set([
  "start-url", "apis", "pages", "pages-rsc", "pages-rsc-prefetch", "pages-rsc-prefetches", "pages-html",
  "next-data", "static-data-assets", "others", "cross-origin", "next-image",
  "static-font-assets", "static-image-assets", "next-static-js-assets",
  "static-audio-assets", "static-video-assets", "static-js-assets", "static-style-assets",
  "google-fonts-webfonts", "google-fonts-stylesheets",
]);

const serwist = new Serwist({
  cacheId: CACHE_PREFIX,
  precacheOptions: { cacheName: `${CACHE_PREFIX}-precache` },
  precacheEntries: (self.__SW_MANIFEST ?? []).filter((entry) =>
    isPublicPrecache(new URL(typeof entry === "string" ? entry : entry.url, self.location.origin), self.location.origin)),
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: false,
  runtimeCaching: [
    {
      matcher: ({ url, request }) => isPublicAsset(url, self.location.origin) && !request.headers.has("RSC"),
      handler: new CacheFirst({
        cacheName: STATIC_CACHE,
        plugins: [new ExpirationPlugin({ maxEntries: 250, maxAgeSeconds: 60 * 60 * 24 * 30 })],
      }),
    },
    {
      matcher: () => true,
      // Also bypass the HTTP cache: revocation must not resurrect a previously successful response.
      handler: new NetworkOnly({
        plugins: [{ requestWillFetch: ({ request }) => privateNetworkRequest(request) }],
      }),
    },
  ],
  fallbacks: {
    entries: [{ url: "/offline.html", matcher: ({ request }) => request.destination === "document" }],
  },
});

self.addEventListener("activate", (event) => {
  const activate = event as Event & { waitUntil(promise: Promise<unknown>): void };
  activate.waitUntil(caches.keys().then((names) => Promise.all(names
    .filter((name) => name !== STATIC_CACHE && name !== serwist.precacheStrategy.cacheName)
    .filter((name) => legacyPrefixes.some((prefix) => name.startsWith(prefix)) || legacyNames.has(name) ||
      (name.startsWith("serwist-precache-") && name.endsWith(self.registration.scope)))
    .map((name) => caches.delete(name)))));
});
serwist.addEventListeners();
