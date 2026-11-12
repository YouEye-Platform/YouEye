import { defineConfig } from '@playwright/test';

// One project, serial: each app test signs in an admin and a standard user from saved sessions.
// Only apps that are installed on the box are run (others are skipped by the spec's install check).
export default defineConfig({
  testDir: '.',
  testMatch: 'apps.spec.ts',
  timeout: 180_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results/artifacts',
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
