import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import withSerwistInit from "@serwist/next";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
});

const nextConfig: NextConfig = {
  output: 'standalone',
  reactCompiler: true,
  typescript: {
    // Serwist WorkerGlobalScope types conflict with DOM types —
    // the SW is compiled by its own webpack plugin, not TS.
    ignoreBuildErrors: true,
  },

  // Allow remote images from GitHub (App Market icons)
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'raw.githubusercontent.com',
      },
      {
        protocol: 'https',
        hostname: 'github.com',
      },
    ],
  },

  // Static security headers only — dynamic CSP (frame-ancestors) is set in middleware
  // because next.config headers are baked at build time and can't read runtime env vars.
  async headers() {
    const commonHeaders = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-XSS-Protection', value: '1; mode=block' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ];

    return [
      {
        source: '/:path*',
        headers: commonHeaders,
      },
    ];
  },
};

export default withSerwist(withNextIntl(nextConfig));
