/**
 * Service Worker — Control Panel PWA
 *
 * Minimal SW for the admin panel. Lighter caching than the UI since
 * CP pages are mostly dynamic admin views.
 *
 * Strategies:
 * - Static assets (/_next/static/): CacheFirst (30d)
 * - API routes: NetworkFirst (5s timeout)
 * - Pages: NetworkFirst with /offline fallback
 */

import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope & typeof globalThis;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // Static assets — cache-first, long TTL
    {
      urlPattern: /\/_next\/static\/.*/i,
      handler: "CacheFirst",
      options: {
        cacheName: "control-static-assets",
        expiration: {
          maxEntries: 200,
          maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
        },
      },
    },
    // Favicon/branding — stale-while-revalidate
    {
      urlPattern: /\/api\/branding\/favicon.*/i,
      handler: "StaleWhileRevalidate",
      options: {
        cacheName: "control-branding",
        expiration: {
          maxEntries: 10,
          maxAgeSeconds: 60 * 60 * 24, // 1 day
        },
      },
    },
    // API routes — network-first with timeout
    {
      urlPattern: /\/api\/.*/i,
      handler: "NetworkFirst",
      options: {
        cacheName: "control-api-cache",
        networkTimeoutSeconds: 5,
        expiration: {
          maxEntries: 50,
          maxAgeSeconds: 60 * 60, // 1 hour
        },
      },
    },
    // Default for all other requests
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

serwist.addEventListeners();
