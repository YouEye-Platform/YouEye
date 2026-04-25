# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: server-name-widget-drawer.spec.ts >> Server Name Widget & App Drawer >> empty state shows marketplace link for admin
- Location: tests/server-name-widget-drawer.spec.ts:132:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('text=No apps installed')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for locator('text=No apps installed')

```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]:
    - banner [ref=e3]:
      - link "DevVM" [ref=e5] [cursor=pointer]:
        - /url: /
        - generic [ref=e6]: DevVM
      - generic [ref=e7]:
        - link "Home" [ref=e8] [cursor=pointer]:
          - /url: /
          - img
        - button "Apps" [expanded] [ref=e9] [cursor=pointer]:
          - img
        - button "Notifications" [ref=e11]:
          - img [ref=e12]
        - button "DT" [ref=e15]:
          - generic [ref=e17]: DT
    - main [ref=e18]:
      - generic [ref=e19]:
        - generic [ref=e22]:
          - heading "DevVM" [level=1] [ref=e26]
          - generic [ref=e30]:
            - img [ref=e31]
            - textbox "Search the web..." [ref=e34]
          - generic [ref=e37]:
            - generic [ref=e38]: 04:33:32
            - generic [ref=e39]: Thursday, April 23
        - button "Edit layout" [ref=e41] [cursor=pointer]:
          - img
  - region "Notifications alt+T"
  - alert [ref=e42]
  - dialog [ref=e44]:
    - generic [ref=e45]:
      - button "Edit drawer" [ref=e47] [cursor=pointer]:
        - img
      - generic [ref=e52]:
        - generic "Cinema" [ref=e53] [cursor=pointer]:
          - img [ref=e55]
          - generic [ref=e57]: Cinema
        - generic "Notes" [ref=e58] [cursor=pointer]:
          - img [ref=e60]
          - generic [ref=e63]: Notes
        - generic "Search" [ref=e64] [cursor=pointer]:
          - img [ref=e66]
          - generic [ref=e69]: Search
        - generic "SearXNG" [ref=e70] [cursor=pointer]:
          - img "SearXNG" [ref=e72]
          - generic [ref=e73]: SearXNG
        - generic "Translate" [ref=e74] [cursor=pointer]:
          - img [ref=e76]
          - generic [ref=e80]: Translate
        - generic "Weather" [ref=e81] [cursor=pointer]:
          - img [ref=e83]
          - generic [ref=e88]: Weather
        - generic "Wiki" [ref=e89] [cursor=pointer]:
          - img [ref=e91]
          - generic [ref=e93]: Wiki
```

# Test source

```ts
  33  |       } catch {
  34  |         // Already logged in or different auth flow
  35  |       }
  36  |     }
  37  |     // Wait for homepage to settle
  38  |     await page.waitForTimeout(1000);
  39  |   });
  40  | 
  41  |   test.afterAll(async () => {
  42  |     await context?.close();
  43  |   });
  44  | 
  45  |   test('homepage loads with navbar', async () => {
  46  |     await expect(page.locator('header')).toBeVisible({ timeout: 10000 });
  47  |     await page.screenshot({ path: 'test-results/01-homepage.png' });
  48  |   });
  49  | 
  50  |   test('server name widget in add widget dialog', async () => {
  51  |     // Enter edit mode via paintbrush button
  52  |     await page.locator('button[title="Edit layout"]').click();
  53  |     await page.waitForTimeout(500);
  54  | 
  55  |     // Click "+ Add"
  56  |     await page.locator('button:has-text("Add")').first().click();
  57  |     await page.waitForTimeout(500);
  58  | 
  59  |     // Server Name should be in the catalog
  60  |     await expect(page.locator('text=Server Name')).toBeVisible({ timeout: 5000 });
  61  |     await page.screenshot({ path: 'test-results/02-add-widget-menu.png' });
  62  | 
  63  |     // Close dialog
  64  |     await page.keyboard.press('Escape');
  65  |     await page.waitForTimeout(300);
  66  |   });
  67  | 
  68  |   test('reset defaults shows server name widget', async () => {
  69  |     // Dismiss the add-widget dialog overlay by clicking backdrop
  70  |     const backdrop = page.locator('.bg-black\\/60, [class*="backdrop"]').first();
  71  |     if (await backdrop.isVisible({ timeout: 1000 }).catch(() => false)) {
  72  |       await backdrop.click({ force: true });
  73  |       await page.waitForTimeout(500);
  74  |     }
  75  | 
  76  |     // Still in edit mode — click Reset (force to bypass any remaining overlay)
  77  |     await page.locator('button:has-text("Reset")').click({ force: true });
  78  |     await page.waitForTimeout(3000);
  79  |     await page.screenshot({ path: 'test-results/03-reset-defaults.png' });
  80  | 
  81  |     // Click Done
  82  |     await page.locator('button:has-text("Done")').click();
  83  |     await page.waitForTimeout(1000);
  84  |     await page.screenshot({ path: 'test-results/04-homepage-server-name.png' });
  85  |   });
  86  | 
  87  |   test('app drawer opens as popover with pencil icon', async () => {
  88  |     await page.locator('button[aria-label="Apps"]').click();
  89  |     await page.waitForTimeout(500);
  90  | 
  91  |     // Pencil icon in top-left, no "Manage Apps" text
  92  |     await expect(page.locator('[title="Edit drawer"]')).toBeVisible();
  93  |     await page.screenshot({ path: 'test-results/05-drawer-open.png' });
  94  |   });
  95  | 
  96  |   test('drawer edit mode shows two-panel layout with controls', async () => {
  97  |     await page.locator('[title="Edit drawer"]').click();
  98  |     await page.waitForTimeout(500);
  99  | 
  100 |     // Edit mode header with Done button
  101 |     await expect(page.locator('button:has-text("Done editing")')).toBeVisible();
  102 |     // Hidden panel on left
  103 |     await expect(page.locator('text=HIDDEN')).toBeVisible();
  104 |     // Controls at bottom
  105 |     await expect(page.locator('text=Columns')).toBeVisible();
  106 |     await expect(page.locator('text=Icon size')).toBeVisible();
  107 |     await expect(page.locator('text=Max height')).toBeVisible();
  108 |     await page.screenshot({ path: 'test-results/06-drawer-edit.png' });
  109 |   });
  110 | 
  111 |   test('column selector toggles', async () => {
  112 |     // Click column 5
  113 |     const buttons = page.locator('button:has-text("5")');
  114 |     const col5 = buttons.last();
  115 |     await col5.click();
  116 |     await page.waitForTimeout(300);
  117 |     await page.screenshot({ path: 'test-results/07-columns-5.png' });
  118 | 
  119 |     // Click back to 4
  120 |     await page.locator('button:has-text("4")').last().click();
  121 |     await page.waitForTimeout(300);
  122 |   });
  123 | 
  124 |   test('exit edit mode', async () => {
  125 |     await page.locator('button:has-text("Done editing")').click();
  126 |     await page.waitForTimeout(500);
  127 |     // Back to normal mode — pencil icon visible
  128 |     await expect(page.locator('[title="Edit drawer"]')).toBeVisible();
  129 |     await page.screenshot({ path: 'test-results/08-drawer-normal.png' });
  130 |   });
  131 | 
  132 |   test('empty state shows marketplace link for admin', async () => {
> 133 |     await expect(page.locator('text=No apps installed')).toBeVisible();
      |                                                          ^ Error: expect(locator).toBeVisible() failed
  134 |     await expect(page.locator('text=Visit Marketplace')).toBeVisible();
  135 |     await page.screenshot({ path: 'test-results/09-empty-admin.png' });
  136 | 
  137 |     // Close drawer
  138 |     await page.keyboard.press('Escape');
  139 |     await page.waitForTimeout(300);
  140 |   });
  141 | 
  142 |   test('drawer prefs API persists', async () => {
  143 |     const getRes = await page.evaluate(async () => {
  144 |       const r = await fetch('/api/v1/apps/drawer/prefs');
  145 |       return r.json();
  146 |     });
  147 |     expect(getRes).toHaveProperty('columns');
  148 |     expect(getRes).toHaveProperty('iconScale');
  149 |     expect(getRes).toHaveProperty('maxHeight');
  150 | 
  151 |     const putRes = await page.evaluate(async () => {
  152 |       const r = await fetch('/api/v1/apps/drawer/prefs', {
  153 |         method: 'PUT',
  154 |         headers: { 'Content-Type': 'application/json' },
  155 |         body: JSON.stringify({ columns: 4 }),
  156 |       });
  157 |       return r.json();
  158 |     });
  159 |     expect(putRes.columns).toBe(4);
  160 | 
  161 |     // Reset
  162 |     await page.evaluate(async () => {
  163 |       await fetch('/api/v1/apps/drawer/prefs', {
  164 |         method: 'PUT',
  165 |         headers: { 'Content-Type': 'application/json' },
  166 |         body: JSON.stringify({ columns: 3 }),
  167 |       });
  168 |     });
  169 |   });
  170 | 
  171 |   test('clock widget is compact', async () => {
  172 |     await expect(page.locator('text=/\\d{2}:\\d{2}/')).toBeVisible();
  173 |     await page.screenshot({ path: 'test-results/10-compact-clock.png' });
  174 |   });
  175 | });
  176 | 
```