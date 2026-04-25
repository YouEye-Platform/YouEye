# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: settings-apps.spec.ts >> Settings Apps Restructure >> sidebar shows Apps instead of Connectors
- Location: tests/settings-apps.spec.ts:50:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('nav a[href="/settings/apps"]')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for locator('nav a[href="/settings/apps"]')

```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic:
    - region "Status messages"
  - generic [ref=e7]:
    - generic [ref=e8] [cursor=pointer]:
      - generic "Select language":
        - img
      - combobox "Select language" [ref=e9]:
        - option "English" [selected]
        - option "čeština (Czech)"
        - option "Nederlands (Dutch)"
        - option "suomi (Finnish)"
        - option "français (French)"
        - option "Deutsch (German)"
        - option "italiano (Italian)"
        - option "polski (Polish)"
        - option "português (Portuguese)"
        - option "русский (Russian)"
        - option "español (Spanish)"
        - option "Türkçe (Turkish)"
        - option "简体中文 (Simplified Chinese)"
        - option "繁體中文 (Traditional Chinese)"
        - option "日本語 (Japanese)"
        - option "한국어 (Korean)"
      - text: ⋯
    - banner
    - main "Authentication form" [ref=e10]:
      - text: DevVM
      - generic [ref=e11]:
        - heading "Welcome home!" [level=1] [ref=e13]
        - generic [ref=e15]:
          - paragraph [ref=e16]: Login to continue to DevVM.
          - generic [ref=e17]:
            - generic [ref=e19]: Email or Username
            - textbox "Email or Username" [ref=e20]
          - button "Log in" [ref=e22] [cursor=pointer]
    - contentinfo "Site footer" [ref=e23]:
      - list "Site links" [ref=e24]:
        - listitem [ref=e25]:
          - generic [ref=e26]: Powered by authentik
```

# Test source

```ts
  1   | /**
  2   |  * Settings Apps — Playwright test suite
  3   |  *
  4   |  * Tests the Settings restructure (Session A):
  5   |  * - Sidebar shows "Apps" and "Accounts" instead of "Connectors"
  6   |  * - Admin sidebar shows "App Management" instead of "Apps"
  7   |  * - /settings/connectors redirects to /settings/apps
  8   |  * - Apps list page loads and shows installed apps
  9   |  * - Per-app detail page has 3 tabs: Data Sources, Link Handling, Permissions
  10  |  * - Accounts page loads with Connected Accounts and API Keys sections
  11  |  */
  12  | 
  13  | import { test, expect, chromium } from '@playwright/test';
  14  | 
  15  | const BASE = 'https://devvm.test';
  16  | 
  17  | test.describe('Settings Apps Restructure', () => {
  18  |   let browser: any;
  19  |   let context: any;
  20  |   let page: any;
  21  | 
  22  |   test.beforeAll(async () => {
  23  |     browser = await chromium.connectOverCDP('http://localhost:9222');
  24  |     context = await browser.newContext({ ignoreHTTPSErrors: true });
  25  |     page = await context.newPage();
  26  |   });
  27  | 
  28  |   test.afterAll(async () => {
  29  |     await context?.close();
  30  |   });
  31  | 
  32  |   test('login and navigate to settings', async () => {
  33  |     await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  34  | 
  35  |     // Handle SSO login if needed
  36  |     if (page.url().includes('authentik') || page.url().includes('/if/flow/')) {
  37  |       await page.locator('input[name="uidField"]').fill('tester');
  38  |       await page.locator('button[type="submit"]').click();
  39  |       await page.waitForTimeout(1000);
  40  |       await page.locator('input[name="password"]').fill('tester123');
  41  |       await page.locator('button[type="submit"]').click();
  42  |       await page.waitForURL(`${BASE}/**`, { timeout: 30000 });
  43  |     }
  44  | 
  45  |     // Navigate to settings via avatar menu
  46  |     await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle', timeout: 15000 });
  47  |     await expect(page.locator('text=Profile')).toBeVisible({ timeout: 10000 });
  48  |   });
  49  | 
  50  |   test('sidebar shows Apps instead of Connectors', async () => {
  51  |     // "Apps" should be visible in sidebar
  52  |     const appsLink = page.locator('nav a[href="/settings/apps"]');
> 53  |     await expect(appsLink).toBeVisible();
      |                            ^ Error: expect(locator).toBeVisible() failed
  54  |     await expect(appsLink).toContainText('Apps');
  55  | 
  56  |     // Old "Connectors" link should NOT exist
  57  |     const connectorsLink = page.locator('nav a[href="/settings/connectors"]');
  58  |     await expect(connectorsLink).toHaveCount(0);
  59  |   });
  60  | 
  61  |   test('sidebar shows Accounts section', async () => {
  62  |     const accountsLink = page.locator('nav a[href="/settings/accounts"]');
  63  |     await expect(accountsLink).toBeVisible();
  64  |     await expect(accountsLink).toContainText('Accounts');
  65  |   });
  66  | 
  67  |   test('admin sidebar shows App Management', async () => {
  68  |     const appMgmtLink = page.locator('nav a[href="/settings/apps-list"]');
  69  |     await expect(appMgmtLink).toBeVisible();
  70  |     await expect(appMgmtLink).toContainText('App Management');
  71  |   });
  72  | 
  73  |   test('/settings/connectors redirects to /settings/apps', async () => {
  74  |     await page.goto(`${BASE}/settings/connectors`, { waitUntil: 'networkidle', timeout: 15000 });
  75  |     await page.waitForTimeout(1000);
  76  |     expect(page.url()).toContain('/settings/apps');
  77  |     expect(page.url()).not.toContain('/settings/connectors');
  78  |   });
  79  | 
  80  |   test('Apps list page shows installed apps', async () => {
  81  |     await page.goto(`${BASE}/settings/apps`, { waitUntil: 'networkidle', timeout: 15000 });
  82  | 
  83  |     // Page title
  84  |     await expect(page.locator('h2:has-text("Apps")')).toBeVisible({ timeout: 10000 });
  85  | 
  86  |     // Wait for app list to load
  87  |     await page.waitForTimeout(2000);
  88  | 
  89  |     // Should show at least Search app
  90  |     await expect(page.locator('text=Search')).toBeVisible({ timeout: 10000 });
  91  | 
  92  |     // Should show multiple native apps
  93  |     const appNames = ['Weather', 'Wiki', 'Notes', 'Translate', 'Cinema'];
  94  |     for (const name of appNames) {
  95  |       await expect(page.locator(`button:has-text("${name}")`).first()).toBeVisible({ timeout: 5000 });
  96  |     }
  97  |   });
  98  | 
  99  |   test('clicking an app navigates to per-app detail page', async () => {
  100 |     // Click on Search app
  101 |     await page.locator('button:has-text("Search")').first().click();
  102 |     await page.waitForTimeout(2000);
  103 | 
  104 |     // Should show app header
  105 |     await expect(page.locator('h2:has-text("Search")')).toBeVisible({ timeout: 10000 });
  106 | 
  107 |     // Should show "Back to Apps" link
  108 |     await expect(page.locator('text=Back to Apps')).toBeVisible();
  109 |   });
  110 | 
  111 |   test('per-app page has 3 tabs', async () => {
  112 |     // Data Sources tab should be visible and active
  113 |     const dsTab = page.locator('button:has-text("Data Sources")');
  114 |     await expect(dsTab).toBeVisible();
  115 | 
  116 |     // Link Handling tab
  117 |     const lhTab = page.locator('button:has-text("Link Handling")');
  118 |     await expect(lhTab).toBeVisible();
  119 | 
  120 |     // Permissions tab
  121 |     const permTab = page.locator('button:has-text("Permissions")');
  122 |     await expect(permTab).toBeVisible();
  123 |   });
  124 | 
  125 |   test('Data Sources tab shows connector capabilities', async () => {
  126 |     // Should show connections section on Data Sources tab
  127 |     await expect(page.locator('text=CONNECTIONS').first()).toBeVisible({ timeout: 5000 });
  128 |   });
  129 | 
  130 |   test('Link Handling tab shows placeholder', async () => {
  131 |     await page.locator('button:has-text("Link Handling")').click();
  132 |     await page.waitForTimeout(500);
  133 | 
  134 |     await expect(page.locator('text=No link handlers configured')).toBeVisible({ timeout: 5000 });
  135 |   });
  136 | 
  137 |   test('Permissions tab shows permission state', async () => {
  138 |     await page.locator('button:has-text("Permissions")').click();
  139 |     await page.waitForTimeout(1000);
  140 | 
  141 |     // Should show either permissions or "No permissions granted" message
  142 |     const hasPermissions = await page.locator('text=No permissions granted').isVisible().catch(() => false);
  143 |     const hasGranted = await page.locator('text=granted').isVisible().catch(() => false);
  144 |     expect(hasPermissions || hasGranted).toBeTruthy();
  145 |   });
  146 | 
  147 |   test('Back to Apps link works', async () => {
  148 |     await page.locator('text=Back to Apps').click();
  149 |     await page.waitForTimeout(1000);
  150 |     expect(page.url()).toContain('/settings/apps');
  151 |     expect(page.url()).not.toContain('/settings/apps/');
  152 |   });
  153 | 
```