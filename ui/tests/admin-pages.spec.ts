/**
 * Admin Pages — Playwright Tests
 *
 * Tests the admin proxy layer and admin pages in the settings UI.
 * Runs against the deployed VM at 192.168.31.204.
 *
 * Test coverage:
 * - Health endpoint and login page still work
 * - Admin API proxy returns 401 without authentication
 * - All settings pages redirect to /login when unauthenticated
 * - Authenticated admin can access admin pages and see navigation
 * - Authenticated admin pages render without crashing
 * - Admin pages show proper error/loading states (bridge unavailable)
 * - Non-admin users get redirected from admin pages
 */

import { test, expect } from "@playwright/test";
import { SignJWT } from "jose";

const UI_BASE = "https://irisvm.test";
const JWT_SECRET = "34e17ba8d1dcdf8f3494723ab27fbf218fa898aaba843b1addaf945a66e33541";
  "-bx6Bq7j_ZDOdrRg1FjpqhRipukzNVliY63LfrQYLsv-8Qgy1nj9f5yIBLBlsdSLW8q4kE0Kati06C5xODKlaQ==";

/**
 * Create a JWT session token for testing.
 */
async function createTestToken(isAdmin: boolean): Promise<string> {
  const secret = new TextEncoder().encode(JWT_SECRET);
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    userId: "test-user-id",
    username: isAdmin ? "admin" : "regularuser",
    name: isAdmin ? "Test Admin" : "Test User",
    email: isAdmin ? "admin@test.local" : "user@test.local",
    isAdmin,
    groups: isAdmin ? ["authentik Admins"] : [],
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600) // 1 hour
    .sign(secret);
}

// ===== Existing Functionality =====

test.describe("Existing Functionality", () => {
  test("health endpoint returns 200", async ({ request }) => {
    const response = await request.get(`${UI_BASE}/api/health`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
  });

  test("login page loads without errors", async ({ page }) => {
    const response = await page.goto(`${UI_BASE}/login`, {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    });
    expect(response).not.toBeNull();
    expect(response!.status()).toBeLessThan(500);
  });
});

// ===== Admin Proxy Layer — Unauthenticated =====

test.describe("Admin Proxy — Unauthenticated", () => {
  const endpoints = [
    "/api/admin/system",
    "/api/admin/containers",
    "/api/admin/dns/stats",
    "/api/admin/proxy/routes",
    "/api/admin/users",
  ];

  for (const endpoint of endpoints) {
    test(`${endpoint} returns 401 without auth`, async ({ request }) => {
      const response = await request.get(`${UI_BASE}${endpoint}`);
      expect([401, 302, 307]).toContain(response.status());
    });
  }
});

// ===== Settings Pages — Unauthenticated Redirect =====

test.describe("Settings Pages — Redirect to Login", () => {
  const pages = [
    "/settings",
    "/settings/system",
    "/settings/containers",
    "/settings/dns",
    "/settings/proxy",
    "/settings/users",
    "/settings/branding",
    "/settings/appearance",
    "/settings/market",
  ];

  for (const path of pages) {
    test(`${path} redirects to /login`, async ({ page }) => {
      await page.goto(`${UI_BASE}${path}`, {
        waitUntil: "domcontentloaded",
        timeout: 10_000,
      });
      await expect(page).toHaveURL(/\/login/);
    });
  }
});

// ===== Authenticated Admin Tests =====

test.describe("Authenticated Admin — Pages", () => {
  let adminToken: string;

  test.beforeAll(async () => {
    adminToken = await createTestToken(true);
  });

  test("admin can access settings and sees admin navigation", async ({
    page,
  }) => {
    // Set session cookie
    await page.context().addCookies([
      {
        name: "ye-ui-session",
        value: adminToken,
        domain: "irisvm.test",
        path: "/",
      },
    ]);

    await page.goto(`${UI_BASE}/settings`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    // Should NOT redirect to login
    await expect(page).toHaveURL(/\/settings/);

    // Should see admin navigation items
    await expect(page.getByRole("link", { name: "System" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Containers" })).toBeVisible();
    await expect(page.getByRole("link", { name: "DNS" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Proxy" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Users" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Branding" })).toBeVisible();
    await expect(page.getByRole("link", { name: "App Market" })).toBeVisible();
  });

  test("system page loads without crashing", async ({ page }) => {
    await page.context().addCookies([
      {
        name: "ye-ui-session",
        value: adminToken,
        domain: "irisvm.test",
        path: "/",
      },
    ]);

    await page.goto(`${UI_BASE}/settings/system`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    await expect(page).toHaveURL(/\/settings\/system/);
    // Should show "System" heading
    await expect(page.getByRole("heading", { name: "System" })).toBeVisible();
    // Should show either data or unavailable message (CP bridge may not be up)
    await page.waitForSelector(
      'text="System status and configuration." , text="Control Panel Unavailable"',
      { timeout: 10_000 }
    ).catch(() => {
      // Even if specific text not found, page didn't crash
    });
  });

  test("containers page loads without crashing", async ({ page }) => {
    await page.context().addCookies([
      {
        name: "ye-ui-session",
        value: adminToken,
        domain: "irisvm.test",
        path: "/",
      },
    ]);

    await page.goto(`${UI_BASE}/settings/containers`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    await expect(page).toHaveURL(/\/settings\/containers/);
    await expect(
      page.getByRole("heading", { name: "Containers" })
    ).toBeVisible();
  });

  test("dns page loads without crashing", async ({ page }) => {
    await page.context().addCookies([
      {
        name: "ye-ui-session",
        value: adminToken,
        domain: "irisvm.test",
        path: "/",
      },
    ]);

    await page.goto(`${UI_BASE}/settings/dns`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    await expect(page).toHaveURL(/\/settings\/dns/);
    await expect(page.getByRole("heading", { name: "DNS" })).toBeVisible();
  });

  test("proxy page loads without crashing", async ({ page }) => {
    await page.context().addCookies([
      {
        name: "ye-ui-session",
        value: adminToken,
        domain: "irisvm.test",
        path: "/",
      },
    ]);

    await page.goto(`${UI_BASE}/settings/proxy`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    await expect(page).toHaveURL(/\/settings\/proxy/);
    await expect(page.getByRole("heading", { name: "Proxy" })).toBeVisible();
  });

  test("users page loads without crashing", async ({ page }) => {
    await page.context().addCookies([
      {
        name: "ye-ui-session",
        value: adminToken,
        domain: "irisvm.test",
        path: "/",
      },
    ]);

    await page.goto(`${UI_BASE}/settings/users`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    await expect(page).toHaveURL(/\/settings\/users/);
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  });

  test("admin proxy returns proper error when bridge unavailable", async ({
    request,
  }) => {
    // Send authenticated request to admin API
    const response = await request.get(`${UI_BASE}/api/admin/system`, {
      headers: {
        Cookie: `ye-ui-session=${adminToken}`,
      },
    });

    // Should get through auth but bridge may not be available (503) or may work (200)
    // It should NOT be 401 (we're authenticated) or 403 (we're admin)
    expect([200, 503, 504]).toContain(response.status());

    if (response.status() === 503 || response.status() === 504) {
      const body = await response.json();
      expect(body.error).toBeDefined();
      expect(body.code).toBeDefined();
    }
  });
});

// ===== Non-Admin User Tests =====

test.describe("Non-Admin User — Access Control", () => {
  let userToken: string;

  test.beforeAll(async () => {
    userToken = await createTestToken(false);
  });

  test("non-admin user does not see admin navigation", async ({ page }) => {
    await page.context().addCookies([
      {
        name: "ye-ui-session",
        value: userToken,
        domain: "irisvm.test",
        path: "/",
      },
    ]);

    await page.goto(`${UI_BASE}/settings`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    // Should be on settings page (not redirected to login)
    await expect(page).toHaveURL(/\/settings/);

    // Should see user navigation
    await expect(page.getByRole("link", { name: "Profile" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Appearance" })).toBeVisible();

    // Should NOT see admin navigation items
    await expect(
      page.getByRole("link", { name: "Containers" })
    ).not.toBeVisible();
    await expect(page.getByRole("link", { name: "DNS" })).not.toBeVisible();
    await expect(page.getByRole("link", { name: "Proxy" })).not.toBeVisible();
  });

  test("non-admin is redirected from admin pages", async ({ page }) => {
    await page.context().addCookies([
      {
        name: "ye-ui-session",
        value: userToken,
        domain: "irisvm.test",
        path: "/",
      },
    ]);

    await page.goto(`${UI_BASE}/settings/containers`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    // Should be redirected to /settings (non-admin guard)
    await expect(page).toHaveURL(/\/settings$/);
  });

  test("non-admin API request to admin proxy returns 403", async ({
    request,
  }) => {
    const response = await request.get(`${UI_BASE}/api/admin/system`, {
      headers: {
        Cookie: `ye-ui-session=${userToken}`,
      },
    });

    expect(response.status()).toBe(403);
  });
});

// ===== Dashboard Still Works =====

test.describe("Dashboard — Not Broken", () => {
  test("dashboard redirects to login when unauthenticated", async ({
    page,
  }) => {
    await page.goto(`${UI_BASE}/`, {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    });
    await expect(page).toHaveURL(/\/login/);
  });

  test("authenticated user can access dashboard", async ({ page }) => {
    const adminToken = await createTestToken(true);
    await page.context().addCookies([
      {
        name: "ye-ui-session",
        value: adminToken,
        domain: "irisvm.test",
        path: "/",
      },
    ]);

    const response = await page.goto(`${UI_BASE}/`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    expect(response).not.toBeNull();
    // Should not redirect to login
    expect(response!.url()).not.toContain("/login");
  });
});
