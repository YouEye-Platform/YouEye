/**
 * F1: Manifest Validation / Dry-Run — API Tests
 *
 * Tests the /api/market/validate endpoint and the ui-bridge validate action.
 * Requires a running CP instance with the App Market catalog available.
 *
 * Session 13 — Andrew
 */

import { test, expect, chromium } from '@playwright/test';

const CP_URL = 'https://localhost';

// Cached session cookie — login once, reuse across tests
let cachedSession: string | null = null;

// Login helper — authenticates via PAM and returns session cookie (cached)
async function getSessionCookie(): Promise<string> {
  if (cachedSession) return cachedSession;

  // First get CSRF token
  const csrfRes = await fetch(`${CP_URL}/api/auth/csrf`, {
    method: 'GET',
    headers: { Host: 'localhost' },
  });
  const csrfData = await csrfRes.json() as { csrfToken: string };
  const csrfToken = csrfData.csrfToken;
  const csrfCookie = csrfRes.headers.getSetCookie?.()?.find(c => c.startsWith('ye-csrf='));

  // Login via PAM
  const loginRes = await fetch(`${CP_URL}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Host: 'localhost',
      Cookie: csrfCookie || '',
    },
    body: JSON.stringify({
      username: 'root',
      password: 'tester123',
      csrfToken,
    }),
    redirect: 'manual',
  });

  const cookies = loginRes.headers.getSetCookie?.() || [];
  const session = cookies.find(c => c.startsWith('ye-session='));
  if (!session) throw new Error('Login failed — no ye-session cookie');
  cachedSession = session.split(';')[0]; // just "ye-session=<token>"
  return cachedSession;
}

// Authenticated fetch helper
async function authedFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const cookie = await getSessionCookie();
  return fetch(`${CP_URL}${path}`, {
    ...options,
    headers: {
      ...options.headers as Record<string, string>,
      Cookie: cookie,
      Host: 'localhost',
    },
  });
}

test.describe('F1: Manifest Validation API', () => {
  test('POST /api/market/validate returns valid report for catalog app', async () => {
    const res = await authedFetch('/api/market/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'jellyfin' }),
    });

    expect(res.status).toBe(200);
    const report = await res.json() as {
      valid: boolean;
      errors: Array<{ check: string; severity: string; message: string }>;
      warnings: Array<{ check: string; severity: string; message: string }>;
      info: Array<{ check: string; severity: string; message: string }>;
    };

    // Report structure
    expect(report).toHaveProperty('valid');
    expect(report).toHaveProperty('errors');
    expect(report).toHaveProperty('warnings');
    expect(report).toHaveProperty('info');
    expect(Array.isArray(report.errors)).toBe(true);
    expect(Array.isArray(report.warnings)).toBe(true);
    expect(Array.isArray(report.info)).toBe(true);

    // Jellyfin should pass validation (valid manifest)
    expect(report.valid).toBe(true);
    expect(report.errors.length).toBe(0);
  });

  test('POST /api/market/validate rejects invalid manifest', async () => {
    const res = await authedFetch('/api/market/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manifest: { invalid: true }, // garbage data
      }),
    });

    expect(res.status).toBe(200);
    const report = await res.json() as {
      valid: boolean;
      errors: Array<{ check: string; severity: string; message: string }>;
    };
    expect(report.valid).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
    // Schema errors should be flagged
    expect(report.errors.some(e => e.check === 'schema')).toBe(true);
  });

  test('POST /api/market/validate returns 400 without appId or manifest', async () => {
    const res = await authedFetch('/api/market/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('appId');
  });

  test('validation items have correct severity and check fields', async () => {
    const res = await authedFetch('/api/market/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'jellyfin' }),
    });

    const report = await res.json() as {
      errors: Array<{ check: string; severity: string; message: string }>;
      warnings: Array<{ check: string; severity: string; message: string }>;
      info: Array<{ check: string; severity: string; message: string }>;
    };

    // All items must have check, severity, message
    const allItems = [...report.errors, ...report.warnings, ...report.info];
    for (const item of allItems) {
      expect(item).toHaveProperty('check');
      expect(item).toHaveProperty('severity');
      expect(item).toHaveProperty('message');
      expect(['error', 'warning', 'info']).toContain(item.severity);
    }
  });

  test('subdomain collision check works', async () => {
    // Use a subdomain that doesn't exist — should pass
    const res = await authedFetch('/api/market/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: 'jellyfin',
        subdomain: 'nonexistent-test-subdomain-xyz',
      }),
    });

    expect(res.status).toBe(200);
    const report = await res.json() as {
      valid: boolean;
      errors: Array<{ check: string; severity: string; message: string }>;
    };
    // Should not have a subdomain collision error for a non-existent subdomain
    expect(report.errors.some(e => e.check === 'subdomain')).toBe(false);
  });
});

test.describe('F1: UI Bridge Validate Action', () => {
  test('ui-bridge validate action returns report via embed referer', async () => {
    const cookie = await getSessionCookie();

    // The ui-bridge validate action requires Referer from /embed/
    const res = await fetch(`${CP_URL}/api/ui-bridge/market?action=validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Referer: `${CP_URL}/embed/market/`,
        Host: 'localhost',
      },
      body: JSON.stringify({ appId: 'jellyfin' }),
    });

    expect(res.status).toBe(200);
    const report = await res.json() as {
      valid: boolean;
      errors: Array<{ check: string; severity: string; message: string }>;
    };
    expect(report).toHaveProperty('valid');
    expect(report).toHaveProperty('errors');
  });
});
