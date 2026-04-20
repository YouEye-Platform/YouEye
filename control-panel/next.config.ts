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

export default withNextIntl(nextConfig);
