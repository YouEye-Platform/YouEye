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
  generateBuildId: async () => process.env.YOUEYE_BUILD_ID || null,
  output: "standalone" as const,
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
