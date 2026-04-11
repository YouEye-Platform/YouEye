/**
 * YouEye HTTPS Verification - Playwright Automation
 *
 * Verifies HTTPS access to alpha.youeye.test using:
 * - host-resolver-rules to map the domain to 192.168.31.40
 * - ignoreHTTPSErrors for self-signed certs
 */

import { chromium } from '/workspace/YE-ControlPanel/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.mjs';

const DOMAIN = 'alpha.youeye.test';
const TARGET_IP = '192.168.31.40';
const HTTPS_URL = `https://${DOMAIN}`;
const SCREENSHOTS_DIR = '/workspace/YE-ControlPanel/screenshots';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== YouEye HTTPS Verification ===\n');

  const { mkdirSync } = await import('fs');
  try { mkdirSync(SCREENSHOTS_DIR, { recursive: true }); } catch {}

  console.log(`[1] Launching browser with host resolver rules...`);
  console.log(`    MAP ${DOMAIN} ${TARGET_IP}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--host-resolver-rules=MAP ${DOMAIN} ${TARGET_IP}`,
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  // Log network errors
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log(`[BROWSER ERROR] ${msg.text()}`);
    }
  });

  page.on('requestfailed', request => {
    console.log(`[REQUEST FAILED] ${request.url()} - ${request.failure()?.errorText}`);
  });

  try {
    // ====== Test 1: Navigate to HTTPS URL ======
    console.log(`\n[2] Navigating to ${HTTPS_URL} ...`);

    let response;
    try {
      response = await page.goto(HTTPS_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
    } catch (err) {
      console.error(`  HTTPS navigation failed: ${err.message}`);
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/https-error.png` });

      // Try with networkidle instead
      console.log('  Retrying with longer timeout...');
      try {
        response = await page.goto(HTTPS_URL, {
          waitUntil: 'load',
          timeout: 60000
        });
      } catch (err2) {
        console.error(`  Second attempt also failed: ${err2.message}`);
        await page.screenshot({ path: `${SCREENSHOTS_DIR}/https-error-retry.png` });
        throw err2;
      }
    }

    const status = response?.status();
    const url = page.url();
    console.log(`  Response status: ${status}`);
    console.log(`  Final URL: ${url}`);

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/https-01-landing.png` });

    // ====== Test 2: Verify page content ======
    console.log(`\n[3] Verifying page content...`);

    // Wait for any content to appear
    await sleep(2000);

    const title = await page.title();
    console.log(`  Page title: "${title}"`);

    // Try to get page heading or key content
    const bodyText = await page.textContent('body').catch(() => '');
    const excerpt = bodyText?.substring(0, 300)?.trim();
    console.log(`  Body excerpt: "${excerpt}"`);

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/https-02-content.png`, fullPage: true });

    // ====== Test 3: Check if we got redirected to login (SSO) ======
    const finalUrl = page.url();
    console.log(`\n[4] Final URL analysis:`);
    console.log(`  URL: ${finalUrl}`);

    const isHTTPS = finalUrl.startsWith('https://');
    const hasValidDomain = finalUrl.includes(DOMAIN) || finalUrl.includes('auth.' + DOMAIN.replace('alpha.', ''));
    const isNotConnectionError = status !== undefined && status !== 0;
    const isSuccessOrRedirect = status >= 200 && status < 400;

    console.log(`  Is HTTPS: ${isHTTPS}`);
    console.log(`  Has valid domain: ${hasValidDomain}`);
    console.log(`  Got response (not connection error): ${isNotConnectionError}`);
    console.log(`  Status is success/redirect: ${isSuccessOrRedirect}`);

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/https-03-final.png` });

    // ====== Test 4: Try the control panel subdomain ======
    console.log(`\n[5] Testing control panel subdomain...`);
    const controlUrl = `https://control.${DOMAIN}`;
    console.log(`  Navigating to ${controlUrl}`);

    try {
      const controlResponse = await page.goto(controlUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      const controlStatus = controlResponse?.status();
      const controlFinalUrl = page.url();
      console.log(`  Control panel status: ${controlStatus}`);
      console.log(`  Control panel URL: ${controlFinalUrl}`);

      await page.screenshot({ path: `${SCREENSHOTS_DIR}/https-04-control-panel.png` });
    } catch (err) {
      console.log(`  Control panel access error: ${err.message}`);
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/https-04-control-error.png` });
    }

    // Summary
    console.log('\n========== HTTPS VERIFICATION SUMMARY ==========');
    console.log(`Target: ${HTTPS_URL}`);
    console.log(`Status: ${status}`);
    console.log(`HTTPS Working: ${isHTTPS && isNotConnectionError ? 'YES' : 'PARTIAL/NO'}`);
    console.log(`Valid Response: ${isSuccessOrRedirect ? 'YES' : 'NO (status: ' + status + ')'}`);
    console.log('================================================\n');

    await browser.close();

    return {
      httpsWorking: isHTTPS && isNotConnectionError,
      status: status,
      finalUrl: finalUrl,
      title: title,
      isSuccessOrRedirect: isSuccessOrRedirect,
    };

  } catch (error) {
    console.error('\nHTTPS verification error:', error.message);
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/https-fatal-error.png` }).catch(() => {});
    await browser.close();
    return {
      httpsWorking: false,
      error: error.message,
    };
  }
}

main()
  .then(result => {
    console.log('Result:', JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
