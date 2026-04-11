/**
 * YouEye HTTPS Verification (Full) - Playwright Automation
 *
 * Verifies HTTPS access to all subdomains using:
 * - host-resolver-rules to map domains to 192.168.31.40
 * - ignoreHTTPSErrors for self-signed certs
 */

import { chromium } from '/workspace/YE-ControlPanel/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.mjs';

const DOMAIN = 'alpha.youeye.test';
const TARGET_IP = '192.168.31.40';
const SCREENSHOTS_DIR = '/workspace/YE-ControlPanel/screenshots';

const URLS_TO_TEST = [
  { name: 'Main', url: `https://${DOMAIN}` },
  { name: 'Control', url: `https://control.${DOMAIN}` },
  { name: 'Auth', url: `https://auth.${DOMAIN}` },
  { name: 'DNS', url: `https://dns.${DOMAIN}` },
];

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testUrl(browser, name, url) {
  console.log(`\n--- Testing ${name}: ${url} ---`);

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();
  let result = { name, url, success: false };

  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    const status = response?.status();
    const finalUrl = page.url();
    const title = await page.title();

    console.log(`  Status: ${status}`);
    console.log(`  Final URL: ${finalUrl}`);
    console.log(`  Title: "${title}"`);

    await sleep(1000);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/https-full-${name.toLowerCase()}.png`,
    });

    result = {
      name,
      url,
      status,
      finalUrl,
      title,
      success: status >= 200 && status < 400,
      isHTTPS: finalUrl.startsWith('https://'),
    };

    console.log(`  HTTPS: ${result.isHTTPS ? 'YES' : 'NO'}`);
    console.log(`  Success: ${result.success ? 'YES' : 'NO'}`);
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
    result.error = err.message;
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/https-full-${name.toLowerCase()}-error.png`,
    }).catch(() => {});
  }

  await context.close();
  return result;
}

async function main() {
  console.log('=== YouEye Full HTTPS Verification ===\n');

  const { mkdirSync } = await import('fs');
  try { mkdirSync(SCREENSHOTS_DIR, { recursive: true }); } catch {}

  // Build host resolver rules for all subdomains
  const hostRules = [
    `MAP ${DOMAIN} ${TARGET_IP}`,
    `MAP control.${DOMAIN} ${TARGET_IP}`,
    `MAP auth.${DOMAIN} ${TARGET_IP}`,
    `MAP dns.${DOMAIN} ${TARGET_IP}`,
  ].join(',');

  console.log(`Host resolver rules: ${hostRules}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--host-resolver-rules=${hostRules}`,
    ],
  });

  const results = [];

  for (const { name, url } of URLS_TO_TEST) {
    const result = await testUrl(browser, name, url);
    results.push(result);
  }

  await browser.close();

  // Summary
  console.log('\n\n========== HTTPS VERIFICATION SUMMARY ==========');
  for (const r of results) {
    const status = r.success ? 'PASS' : 'FAIL';
    const https = r.isHTTPS ? 'HTTPS' : (r.error ? 'ERROR' : 'HTTP');
    console.log(`  [${status}] [${https}] ${r.name}: ${r.url}`);
    if (r.finalUrl) console.log(`         -> ${r.finalUrl} (${r.status})`);
    if (r.error) console.log(`         ERROR: ${r.error}`);
  }
  console.log('================================================\n');

  return results;
}

main()
  .then(results => {
    const allPassed = results.every(r => r.success);
    console.log(`\nOverall: ${allPassed ? 'ALL PASS' : 'SOME FAILED'}`);
    process.exit(allPassed ? 0 : 1);
  })
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
