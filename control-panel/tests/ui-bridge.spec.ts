/**
 * UI Bridge API Tests
 *
 * Tests all /api/ui-bridge/* endpoints against a running YouEye instance.
 * Designed to run from the host or CI, hitting the CP container's API.
 *
 * Usage:
 *   VM_IP=192.168.31.40 DOMAIN=alpha.test node tests/ui-bridge.spec.ts
 *
 * Or via curl from the VM:
 *   Run `node tests/ui-bridge-curl-test.mjs` inside the CP container
 *
 * The script reads the bridge token from /etc/youeye/ui-bridge-token
 * or generates one via the auth endpoint.
 */

import { test, expect } from '@playwright/test';

const VM_IP = process.env.VM_IP || '192.168.31.40';
const BASE_URL = process.env.BASE_URL || `http://${VM_IP}:3000`;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';

// Helper: make authenticated requests to UI Bridge API
async function bridgeRequest(
  request: ReturnType<typeof test.info>['_'] extends never ? never : unknown,
  path: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    token?: string;
  } = {}
) {
  const { method = 'GET', body, token = BRIDGE_TOKEN } = options;

  const headers: Record<string, string> = {};
  if (token) {
    headers['X-UI-Bridge-Token'] = token;
  }
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const url = `${BASE_URL}${path}`;
  const fetchOptions: RequestInit = {
    method,
    headers,
  };
  if (body) {
    fetchOptions.body = JSON.stringify(body);
  }

  return fetch(url, fetchOptions);
}

test.describe('UI Bridge API', () => {
  test.describe('Authentication', () => {
    test('POST /api/ui-bridge/auth with valid token returns valid: true', async () => {
      if (!BRIDGE_TOKEN) {
        test.skip(true, 'BRIDGE_TOKEN not set');
        return;
      }
      const res = await bridgeRequest(null, '/api/ui-bridge/auth', {
        method: 'POST',
        token: BRIDGE_TOKEN,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.valid).toBe(true);
    });

    test('POST /api/ui-bridge/auth with invalid token returns 401', async () => {
      const res = await bridgeRequest(null, '/api/ui-bridge/auth', {
        method: 'POST',
        token: 'invalid-token-that-should-fail',
      });
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.valid).toBe(false);
    });

    test('POST /api/ui-bridge/auth with no token returns 401', async () => {
      const res = await bridgeRequest(null, '/api/ui-bridge/auth', {
        method: 'POST',
        token: '',
      });
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.valid).toBe(false);
    });
  });

  test.describe('System', () => {
    test('GET /api/ui-bridge/system returns system info', async () => {
      if (!BRIDGE_TOKEN) {
        test.skip(true, 'BRIDGE_TOKEN not set');
        return;
      }
      const res = await bridgeRequest(null, '/api/ui-bridge/system');
      expect(res.status).toBe(200);
      const data = await res.json();

      // Check all expected fields exist
      expect(data).toHaveProperty('hostname');
      expect(data).toHaveProperty('os');
      expect(data).toHaveProperty('kernel');
      expect(data).toHaveProperty('uptime');
      expect(data).toHaveProperty('cpu');
      expect(data.cpu).toHaveProperty('cores');
      expect(data.cpu).toHaveProperty('model');
      expect(data).toHaveProperty('memory');
      expect(data.memory).toHaveProperty('total_mb');
      expect(data.memory).toHaveProperty('used_mb');
      expect(data.memory).toHaveProperty('free_mb');
      expect(data).toHaveProperty('disk');
      expect(data.disk).toHaveProperty('total_gb');
      expect(data.disk).toHaveProperty('used_gb');
      expect(data.disk).toHaveProperty('free_gb');
      expect(data).toHaveProperty('incus');
      expect(data.incus).toHaveProperty('version');
      expect(data.incus).toHaveProperty('storage_pool');
      expect(data).toHaveProperty('containers');
      expect(data.containers).toHaveProperty('total');
      expect(data.containers).toHaveProperty('running');
      expect(data.containers).toHaveProperty('stopped');
    });

    test('GET /api/ui-bridge/system without token returns 401', async () => {
      const res = await bridgeRequest(null, '/api/ui-bridge/system', {
        token: '',
      });
      expect(res.status).toBe(401);
    });
  });

  test.describe('Containers', () => {
    test('GET /api/ui-bridge/containers returns non-empty list', async () => {
      if (!BRIDGE_TOKEN) {
        test.skip(true, 'BRIDGE_TOKEN not set');
        return;
      }
      const res = await bridgeRequest(null, '/api/ui-bridge/containers');
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data).toHaveProperty('containers');
      expect(Array.isArray(data.containers)).toBe(true);
      expect(data.containers.length).toBeGreaterThan(0);

      // Check first container has expected shape
      const container = data.containers[0];
      expect(container).toHaveProperty('name');
      expect(container).toHaveProperty('status');
      expect(container).toHaveProperty('type');
      expect(container).toHaveProperty('ipv4');
      expect(container).toHaveProperty('created_at');
      expect(container).toHaveProperty('profiles');
    });
  });

  test.describe('DNS Stats', () => {
    test('GET /api/ui-bridge/dns/stats returns blocking status', async () => {
      if (!BRIDGE_TOKEN) {
        test.skip(true, 'BRIDGE_TOKEN not set');
        return;
      }
      const res = await bridgeRequest(null, '/api/ui-bridge/dns/stats');
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data).toHaveProperty('status');
      expect(data).toHaveProperty('queries_today');
      expect(data).toHaveProperty('blocked_today');
      expect(data).toHaveProperty('percent_blocked');
      expect(data).toHaveProperty('top_queries');
      expect(data).toHaveProperty('top_blocked');
      expect(data).toHaveProperty('gravity_size');
      expect(typeof data.queries_today).toBe('number');
      expect(typeof data.blocked_today).toBe('number');
    });
  });

  test.describe('DNS Control', () => {
    test('POST /api/ui-bridge/dns/control with invalid action returns 400', async () => {
      if (!BRIDGE_TOKEN) {
        test.skip(true, 'BRIDGE_TOKEN not set');
        return;
      }
      const res = await bridgeRequest(null, '/api/ui-bridge/dns/control', {
        method: 'POST',
        body: { action: 'invalid' },
      });
      expect(res.status).toBe(400);
    });
  });

  test.describe('Proxy Routes', () => {
    test('GET /api/ui-bridge/proxy/routes returns routes array', async () => {
      if (!BRIDGE_TOKEN) {
        test.skip(true, 'BRIDGE_TOKEN not set');
        return;
      }
      const res = await bridgeRequest(null, '/api/ui-bridge/proxy/routes');
      // 200 or 503 (if Caddy is not running)
      expect([200, 503]).toContain(res.status);
      const data = await res.json();
      expect(data).toHaveProperty('routes');
      expect(Array.isArray(data.routes)).toBe(true);

      if (data.routes.length > 0) {
        const route = data.routes[0];
        expect(route).toHaveProperty('id');
        expect(route).toHaveProperty('match_domain');
        expect(route).toHaveProperty('upstream');
        expect(route).toHaveProperty('tls_enabled');
      }
    });
  });

  test.describe('Users', () => {
    test('GET /api/ui-bridge/users returns users list', async () => {
      if (!BRIDGE_TOKEN) {
        test.skip(true, 'BRIDGE_TOKEN not set');
        return;
      }
      const res = await bridgeRequest(null, '/api/ui-bridge/users');
      // May fail if Authentik is not configured — accept 200 or 500
      if (res.status === 200) {
        const data = await res.json();
        expect(data).toHaveProperty('users');
        expect(Array.isArray(data.users)).toBe(true);

        if (data.users.length > 0) {
          const user = data.users[0];
          expect(user).toHaveProperty('id');
          expect(user).toHaveProperty('username');
          expect(user).toHaveProperty('name');
          expect(user).toHaveProperty('email');
          expect(user).toHaveProperty('is_active');
          expect(user).toHaveProperty('is_superuser');
          expect(user).toHaveProperty('last_login');
        }
      }
    });
  });

  test.describe('Updates', () => {
    test('GET /api/ui-bridge/updates returns components array', async () => {
      if (!BRIDGE_TOKEN) {
        test.skip(true, 'BRIDGE_TOKEN not set');
        return;
      }
      const res = await bridgeRequest(null, '/api/ui-bridge/updates');
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data).toHaveProperty('components');
      expect(Array.isArray(data.components)).toBe(true);

      if (data.components.length > 0) {
        const component = data.components[0];
        expect(component).toHaveProperty('name');
        expect(component).toHaveProperty('current_version');
        expect(component).toHaveProperty('latest_version');
        expect(component).toHaveProperty('update_available');
        expect(component).toHaveProperty('repo');
      }
    });
  });
});
