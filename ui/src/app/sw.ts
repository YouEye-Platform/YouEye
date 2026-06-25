/**
 * Service Worker - YouEye UI PWA
 *
 * Uses Serwist for Next.js precache/runtime handling. The activate handler only
 * removes stale caches created by the previous hand-rolled worker lineage.
 */

import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { CacheFirst, ExpirationPlugin, NetworkFirst, Serwist, StaleWhileRevalidate } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: WorkerGlobalScope & typeof globalThis;

const CACHE_PREFIX = "youeye-ui";
const LEGACY_CACHE_PREFIXES = ["youeye-ui-", "ui-"];
const ACTIVE_RUNTIME_CACHES = new Set([
  `${CACHE_PREFIX}-static-assets`,
  `${CACHE_PREFIX}-fonts`,
  `${CACHE_PREFIX}-branding-icons`,
  `${CACHE_PREFIX}-pwa-icons`,
  `${CACHE_PREFIX}-api-cache`,
]);

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST ?? [],
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      matcher: /\/_next\/static\/.*/i,
      handler: new CacheFirst({
        cacheName: `${CACHE_PREFIX}-static-assets`,
        plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 })],
      }),
    },
    {
      matcher: /\/fonts\/.*/i,
      handler: new CacheFirst({
        cacheName: `${CACHE_PREFIX}-fonts`,
        plugins: [new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 })],
      }),
    },
    {
      matcher: /\/api\/v1\/branding\/icon.*/i,
      handler: new StaleWhileRevalidate({
        cacheName: `${CACHE_PREFIX}-branding-icons`,
        plugins: [new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 })],
      }),
    },
    {
      matcher: /\/api\/pwa\/icon.*/i,
      handler: new StaleWhileRevalidate({
        cacheName: `${CACHE_PREFIX}-pwa-icons`,
        plugins: [new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 7 })],
      }),
    },
    {
      matcher: /\/api\/.*/i,
      handler: new NetworkFirst({
        cacheName: `${CACHE_PREFIX}-api-cache`,
        networkTimeoutSeconds: 5,
        plugins: [new ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 60 * 60 })],
      }),
    },
    ...defaultCache,
  ],
  fallbacks: {
    entries: [
      {
        url: "/offline",
        matcher({ request }) {
          return request.destination === "document";
        },
      },
    ],
  },
});

type WorkerLifecycleEvent = Event & { waitUntil: (promise: Promise<unknown>) => void };

self.addEventListener("activate", (event) => {
  const activateEvent = event as WorkerLifecycleEvent;
  activateEvent.waitUntil(
    caches.keys().then((cacheNames) => Promise.all(
      cacheNames
        .filter((cacheName) => LEGACY_CACHE_PREFIXES.some((prefix) => cacheName.startsWith(prefix)))
        .filter((cacheName) => !ACTIVE_RUNTIME_CACHES.has(cacheName))
        .map((cacheName) => caches.delete(cacheName)),
    )),
  );
});

serwist.addEventListeners();
