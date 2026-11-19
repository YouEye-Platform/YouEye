import createNextIntlPlugin from "next-intl/plugin";
import withSerwistInit from "@serwist/next";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  cacheOnNavigation: false,
  disable: process.env.NODE_ENV === "development",
});

const nextConfig = {
  // Distinct from the Control Panel's (same commit, "control-panel-…"): both apps share the box's address, and Next
  // loads a page in full only when the other app's page data comes from a different build ID. With the same ID a
  // client-side navigation between them (Home, Settings) applied the other app's data and crashed.
  generateBuildId: async () => (process.env.YOUEYE_BUILD_ID ? `ui-${process.env.YOUEYE_BUILD_ID}` : null),
  output: "standalone" as const,
  transpilePackages: ["@youeye/branding"],
  // Never write rendered routes into the installed tree (.next/server/...):
  // the update check verifies that tree against what was shipped. Build seeds
  // are still read; regenerated responses stay in memory.
  experimental: { isrFlushToDisk: false },
  async headers() {
    return [
      {
        // Allow native apps on subdomains to load fonts cross-origin
        source: "/fonts/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET" },
        ],
      },
    ];
  },
};

export default withSerwist(withNextIntl(nextConfig));
