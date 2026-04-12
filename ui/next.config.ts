import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
};

// @ts-expect-error next-intl returns types from monorepo root next package
export default withNextIntl(nextConfig);
