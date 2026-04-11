/**
 * Playwright test: Verify HTTPS works on port 443 after setup wizard.
 *
 * Usage:
 *   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
 *   VM_IP=192.168.31.40 DOMAIN=alpha.test \
 *   node test-https.mjs
 *
 * Requires:
 *   - Playwright chromium installed
 *   - VM with YouEye deployed and setup wizard completed
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Resolve playwright from pnpm's .pnpm directory
const playwrightPath = './node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.mjs';
const { chromium } = await import(playwrightPath);

const VM_IP = process.env.VM_IP || '192.168.31.40';
const DOMAIN = process.env.DOMAIN || 'alpha.test';
const CP_SUB = process.env.CP_SUB || 'cp';

async function main() {
  console.log(`\n=== HTTPS Test Suite ===`);
  console.log(`VM IP: ${VM_IP}`);
  console.log(`Domain: ${DOMAIN}`);
  console.log(`CP Subdomain: ${CP_SUB}\n`);

  const browser = await chromium.launch({
    args: [
      `--host-resolver-rules=MAP *.${DOMAIN} ${VM_IP}, MAP ${DOMAIN} ${VM_IP}`,
      '--ignore-certificate-errors',
      '--no-sandbox',
    ],
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
  });

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    process.stdout.write(`  [TEST] ${name}... `);
    try {
      await fn();
      console.log('✅ PASS');
      passed++;
    } catch (err) {
      console.log(`❌ FAIL: ${err.message || String(err)}`);
      failed++;
    }
  }

  // Test 1: HTTPS loads on root domain
  await test('HTTPS loads on root domain', async () => {
    const page = await context.newPage();
    try {
      const response = await page.goto(`https://${DOMAIN}`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      if (!response) throw new Error('No response received');
      const status = response.status();
      if (status >= 500) throw new Error(`Server error: ${status}`);
      process.stdout.write(`(status ${status}) `);
    } finally {
      await page.close();
    }
  });

  // Test 2: HTTPS loads on CP subdomain
  await test(`HTTPS loads on ${CP_SUB}.${DOMAIN}`, async () => {
    const page = await context.newPage();
    try {
      const response = await page.goto(`https://${CP_SUB}.${DOMAIN}`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      if (!response) throw new Error('No response received');
      const status = response.status();
      if (status >= 500) throw new Error(`Server error: ${status}`);
      process.stdout.write(`(status ${status}) `);
    } finally {
      await page.close();
    }
  });

  // Test 3: TLS certificate is present (not connection reset)
  await test('TLS certificate is present on port 443', async () => {
    const page = await context.newPage();
    try {
      const response = await page.goto(`https://${DOMAIN}:443`, {
        waitUntil: 'commit',
        timeout: 10000,
      });
      if (!response) throw new Error('No response - TLS handshake may have failed');
    } finally {
      await page.close();
    }
  });

  // Test 4: HTTP port 80 should NOT show "Caddy works!" (should redirect to HTTPS or serve content)
  await test('HTTP port 80 does not show default Caddy page', async () => {
    const page = await context.newPage();
    try {
      const response = await page.goto(`http://${DOMAIN}`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      if (!response) throw new Error('No response received');
      const title = await page.title();
      const content = await page.textContent('body').catch(() => '');
      if (title.includes('Caddy') || (content && content.includes('Caddy'))) {
        throw new Error('Port 80 is showing default "Caddy works!" page - HTTPS not configured');
      }
      process.stdout.write(`(status ${response.status()}, title="${title}") `);
    } finally {
      await page.close();
    }
  });

  await browser.close();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
