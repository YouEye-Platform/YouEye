import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: 'standalone',
  reactCompiler: true,

  // Allow remote images from Gitea (App Market icons)
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'git.byka.wtf',
      },
    ],
  },
  
  // Security headers
  async headers() {
    const parentOrigin = process.env.PLATFORM_ORIGIN || 'https://devvm.test';
    const commonHeaders = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-XSS-Protection', value: '1; mode=block' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ];

    return [
      {
        // /api/ping?verify=1 — embeddable iframe for setup-complete
        // connectivity check.  Must allow framing from any origin.
        source: '/api/ping',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "default-src 'none'; script-src 'unsafe-inline'; frame-ancestors *",
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
        ],
      },
      {
        // Embed routes — allow framing from YE-UI origin
        source: '/embed/:path*',
        headers: [
          ...commonHeaders,
          {
            key: 'Content-Security-Policy',
            value: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://git.byka.wtf; font-src 'self' data:; connect-src 'self'; frame-ancestors ${parentOrigin};`,
          },
        ],
      },
      {
        // All other routes — deny framing (excludes /api/ping and /embed/)
        source: '/((?!api/ping|embed/).*)',
        headers: [
          ...commonHeaders,
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Content-Security-Policy',
            value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://git.byka.wtf; font-src 'self' data:; connect-src 'self'; frame-src https:; frame-ancestors 'none';",
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
