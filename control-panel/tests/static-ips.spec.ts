/**
 * Static IP Assignment — System Container Verification
 *
 * Verifies that all 7 system containers have deterministic static IPs
 * assigned as device overrides on eth0, and that the DHCP range on
 * incusbr0 is correctly restricted to .100-.254.
 *
 * Run with: npx playwright test tests/static-ips.spec.ts
 * Requires: sudo access (tests run incus commands via exec)
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

const SYSTEM_CONTAINERS = [
  { name: 'youeye-postgres', offset: 10 },
  { name: 'youeye-authentik', offset: 11 },
  { name: 'youeye-authentik-worker', offset: 12 },
  { name: 'youeye-caddy', offset: 13 },
  { name: 'youeye-pihole', offset: 14 },
  { name: 'youeye-ui', offset: 15 },
  { name: 'youeye-control', offset: 16 },
];

function run(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8' }).trim();
}

function getSubnetBase(): string {
  const raw = run('sudo incus network get incusbr0 ipv4.address');
  // "10.75.26.1/24" → "10.75.26"
  const ip = raw.split('/')[0];
  return ip.split('.').slice(0, 3).join('.');
}

test.describe('Static IP Assignment', () => {
  let subnetBase: string;

  test.beforeAll(() => {
    subnetBase = getSubnetBase();
  });

  test('incusbr0 DHCP range is restricted to .100-.254', () => {
    const dhcpRanges = run('sudo incus network get incusbr0 ipv4.dhcp.ranges');
    const expected = `${subnetBase}.100-${subnetBase}.254`;
    expect(dhcpRanges).toBe(expected);
  });

  for (const container of SYSTEM_CONTAINERS) {
    test(`${container.name} has static IP at .${container.offset}`, () => {
      const expectedIP = `${subnetBase}.${container.offset}`;

      // Use exact name match via incus info (avoids youeye-authentik matching youeye-authentik-worker)
      const infoRaw = run(`sudo incus info ${container.name} 2>&1`);
      expect(infoRaw).toContain('Status: RUNNING');

      // Get eth0 IP from incus info (handles multi-NIC containers like caddy)
      const stateRaw = run(
        `sudo incus query /1.0/instances/${container.name}/state 2>&1`
      );
      const state = JSON.parse(stateRaw);
      const eth0 = state.network?.eth0;
      expect(eth0, `${container.name} should have eth0 NIC`).toBeDefined();
      const ipv4Addr = eth0.addresses.find(
        (a: { family: string; address: string }) => a.family === 'inet'
      );
      expect(ipv4Addr, `${container.name} should have IPv4 on eth0`).toBeDefined();
      expect(ipv4Addr.address).toBe(expectedIP);
    });
  }

  test('platform API responds ok through static IP chain', async () => {
    // Caddy (.13) → CP (.16) — both on static IPs
    const resp = run('curl -sk https://localhost/api/ping');
    const body = JSON.parse(resp);
    expect(body.status).toBe('ok');
  });

  test('all system containers are running', () => {
    const output = run('sudo incus list -c ns --format csv');
    const lines = output.split('\n');
    for (const container of SYSTEM_CONTAINERS) {
      const line = lines.find((l: string) => l.startsWith(container.name + ','));
      expect(line, `${container.name} should be in container list`).toBeDefined();
      expect(line).toContain('RUNNING');
    }
  });
});
