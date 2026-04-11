/**
 * YouEye Setup Wizard - Playwright Automation
 *
 * This script:
 * 1. Logs in via PAM auth (root / tester123)
 * 2. Completes the 3-step setup wizard
 * 3. Takes screenshots as evidence
 */

import { chromium } from '/workspace/YE-ControlPanel/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.mjs';

const BASE_URL = 'http://192.168.31.40:3000';
const SCREENSHOTS_DIR = '/workspace/YE-ControlPanel/screenshots';

// Setup config
const INSTANCE_NAME = 'Alpha Test';
const DOMAIN = 'alpha.youeye.test';
const ADMIN_USERNAME = 'admin';
const ADMIN_EMAIL = 'admin@alpha.youeye.test';
const ADMIN_PASSWORD = 'AlphaTest2026!';

// PAM credentials
const PAM_USERNAME = 'root';
const PAM_PASSWORD = 'tester123';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== YouEye Setup Wizard Automation ===\n');

  // Create screenshots directory
  const { mkdirSync } = await import('fs');
  try { mkdirSync(SCREENSHOTS_DIR, { recursive: true }); } catch {}

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  // Enable console log forwarding
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log(`[BROWSER ERROR] ${msg.text()}`);
    }
  });

  try {
    // ====== STEP 1: LOGIN ======
    console.log('[1/4] Navigating to login page...');

    // First check if we need to login - go to setup page
    await page.goto(`${BASE_URL}/setup`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/01-initial-page.png` });

    const currentUrl = page.url();
    console.log(`  Current URL: ${currentUrl}`);

    if (currentUrl.includes('/login')) {
      console.log('[1/4] On login page - performing PAM login...');

      // Wait for the form to be ready (auth mode detection)
      await page.waitForSelector('input[name="username"]', { timeout: 15000 });
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/02-login-form.png` });

      // Fill credentials
      await page.fill('input[name="username"]', PAM_USERNAME);
      await page.fill('input[name="password"]', PAM_PASSWORD);
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/03-login-filled.png` });

      // Submit
      console.log('  Submitting login...');
      await page.click('button[type="submit"]');

      // Wait for navigation or error
      try {
        await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15000 });
        console.log(`  Login successful! Redirected to: ${page.url()}`);
      } catch {
        // Check for error
        const errorEl = await page.$('[role="alert"]');
        if (errorEl) {
          const errorText = await errorEl.textContent();
          console.log(`  Login error: ${errorText}`);

          if (errorText.includes('Too many') || errorText.includes('rate')) {
            console.log('  Rate limited! Waiting 2 minutes...');
            await sleep(120000);

            // Retry
            await page.fill('input[name="username"]', PAM_USERNAME);
            await page.fill('input[name="password"]', PAM_PASSWORD);
            await page.click('button[type="submit"]');
            await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15000 });
            console.log(`  Login successful after retry! Redirected to: ${page.url()}`);
          } else {
            throw new Error(`Login failed: ${errorText}`);
          }
        }
      }

      await page.screenshot({ path: `${SCREENSHOTS_DIR}/04-after-login.png` });
    }

    // Navigate to setup page if not already there
    if (!page.url().includes('/setup')) {
      console.log('  Navigating to setup page...');
      await page.goto(`${BASE_URL}/setup`, { waitUntil: 'networkidle', timeout: 30000 });
    }

    console.log(`  On setup page: ${page.url()}`);
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/05-setup-page.png` });

    // Check if setup is already completed (page might redirect to /)
    if (!page.url().includes('/setup')) {
      console.log('  Setup appears to already be completed (redirected away from /setup).');
      console.log(`  Current URL: ${page.url()}`);
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/05-setup-already-done.png` });

      // Still proceed to HTTPS verification
      console.log('\n=== Setup already completed, skipping to HTTPS verification ===\n');
      await browser.close();
      return { setupCompleted: true, alreadyDone: true };
    }

    // ====== STEP 2: WIZARD STEP 0 - Server Setup ======
    console.log('\n[2/4] Wizard Step 0: Server Setup...');

    // Wait for the setup form to load
    await page.waitForSelector('#siteName', { timeout: 15000 });

    // Clear and fill instance name
    await page.fill('#siteName', '');
    await page.fill('#siteName', INSTANCE_NAME);
    console.log(`  Instance name set to: ${INSTANCE_NAME}`);

    // Fill domain
    await page.fill('#domain', DOMAIN);
    console.log(`  Domain set to: ${DOMAIN}`);

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/06-step0-filled.png` });

    // Click "Next" button
    console.log('  Clicking Next...');
    await page.click('button:has-text("Next")');

    // Wait for step 1 to appear
    await page.waitForSelector('#adminUsername', { timeout: 10000 });
    console.log('  Moved to Step 1!');
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/07-step1-admin.png` });

    // ====== STEP 3: WIZARD STEP 1 - Admin Account ======
    console.log('\n[3/4] Wizard Step 1: Admin Account...');

    await page.fill('#adminUsername', ADMIN_USERNAME);
    await page.fill('#adminEmail', ADMIN_EMAIL);
    await page.fill('#adminPassword', ADMIN_PASSWORD);
    console.log(`  Admin: ${ADMIN_USERNAME} / ${ADMIN_EMAIL}`);

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/08-step1-filled.png` });

    // Click "Start Setup" button
    console.log('  Clicking Start Setup...');
    await page.click('button:has-text("Start Setup")');

    // ====== STEP 4: WIZARD STEP 2 - Installation Progress ======
    console.log('\n[4/4] Wizard Step 2: Installation Progress...');

    // Wait for setup steps to appear
    await page.waitForSelector('text=Saving configuration', { timeout: 10000 });
    console.log('  Setup is running...');

    // Monitor progress - wait for completion or error
    // The setup has 7 steps and uses SSE streaming
    const maxWaitTime = 300000; // 5 minutes max
    const startTime = Date.now();
    let lastScreenshot = 0;

    while (Date.now() - startTime < maxWaitTime) {
      // Check for "Setup Complete!" text
      const completeEl = await page.$('text=Setup Complete!');
      if (completeEl) {
        console.log('  Setup Complete!');
        break;
      }

      // Check for error
      const errorAlert = await page.$('[role="alert"]');
      if (errorAlert) {
        const alertText = await errorAlert.textContent();
        // Only flag as error if it's not just a regular alert
        if (alertText && (alertText.includes('failed') || alertText.includes('error') || alertText.includes('Error'))) {
          console.log(`  Setup error detected: ${alertText}`);
          await page.screenshot({ path: `${SCREENSHOTS_DIR}/09-setup-error.png` });
          // Don't throw - let's keep waiting in case it recovers
        }
      }

      // Take periodic screenshots
      const elapsed = Date.now() - startTime;
      if (elapsed - lastScreenshot > 15000) {
        const stepNum = Math.floor(elapsed / 15000);
        await page.screenshot({ path: `${SCREENSHOTS_DIR}/09-progress-${stepNum}.png` });

        // Log current step statuses
        const steps = await page.$$eval('.flex.items-start.gap-3', els =>
          els.map(el => {
            const label = el.querySelector('.text-sm')?.textContent || '';
            const svg = el.querySelector('svg');
            const classes = svg?.className?.baseVal || svg?.getAttribute('class') || '';
            let status = 'pending';
            if (classes.includes('animate-spin')) status = 'running';
            else if (classes.includes('text-green')) status = 'done';
            else if (classes.includes('text-red')) status = 'error';
            return `${status}: ${label}`;
          })
        );
        if (steps.length > 0) {
          console.log('  Current progress:');
          steps.forEach(s => console.log(`    ${s}`));
        }

        lastScreenshot = elapsed;
      }

      await sleep(2000);
    }

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/10-setup-final.png` });

    // Verify completion
    const isComplete = await page.$('text=Setup Complete!');
    if (isComplete) {
      console.log('\n=== Setup Wizard Completed Successfully! ===\n');
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/11-setup-complete.png` });
    } else {
      console.log('\n=== Setup may not have completed within timeout ===');
      // Get final state of page
      const pageContent = await page.textContent('body');
      console.log('  Page content (excerpt):', pageContent?.substring(0, 500));
    }

    await browser.close();
    return { setupCompleted: !!isComplete, alreadyDone: false };

  } catch (error) {
    console.error('\nError during setup:', error.message);
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/error-screenshot.png` });
    await browser.close();
    throw error;
  }
}

main()
  .then(result => {
    console.log('\nResult:', JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
