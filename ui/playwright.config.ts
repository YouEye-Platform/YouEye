import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  retries: 1,
  use: {
    ignoreHTTPSErrors: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        // Launch with host resolver for mapping domains to VM IP
        launchOptions: {
          args: [
            "--host-resolver-rules=MAP *.byka.wtf 192.168.31.204",
            "--ignore-certificate-errors",
          ],
        },
      },
    },
  ],
});
