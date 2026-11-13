import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(repoRoot, p), 'utf8');
const has = (p) => existsSync(join(repoRoot, p));

test('TLS storage encrypts private material with the deploy secret', () => {
  const s = read('src/lib/acme/storage.ts');
  const crypto = read('src/lib/acme/secret-crypto.ts');
  assert.match(s, /YOUEYE_TLS_SECRET_DIR \|\| '\/var\/lib\/youeye\/config\/tls'/);
  assert.match(s, /YOUEYE_DEPLOY_SECRET_FILE \|\| '\/var\/lib\/youeye\/control\/\.deploy_secret'/);
  assert.match(s, /acme-account-key\.enc/);
  assert.match(s, /external-key\.enc/);
  assert.match(s, /mkdirSync\(dirname\(path\), \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(s, /encryptTLSSecret\(value\.trim\(\), readDeploySecret\(\)\)/);
  assert.match(crypto, /createCipheriv\(ALGORITHM, deriveKey\(deploySecret\), iv\)/);
  assert.match(crypto, /aes-256-gcm/);
  assert.match(s, /encrypted TLS key readback failed/);
  assert.doesNotMatch(s, /tls_cert_pem|tls_key_pem|tls_acme_account_key:/);
});

test('TLS storage reads certificates and keys only from their files', () => {
  const s = read('src/lib/acme/storage.ts');
  assert.match(s, /readPemFile\(asString\(raw\.tls_cert_file\) \|\| DEFAULT_CERT_FILE, 'CERTIFICATE'\)/);
  assert.match(s, /readPrivateKeyFile\(asString\(raw\.tls_key_file\) \|\| DEFAULT_KEY_FILE\)/);
  assert.match(s, /if \(!isEncryptedTLSSecret\(stored\)\)/);
});

test('reconcile repairs security posture even when no containers are missing', () => {
  assert.ok(has('src/lib/infrastructure/security-posture.ts'));
  const posture = read('src/lib/infrastructure/security-posture.ts');
  const d = read('src/lib/infrastructure/deployer.ts');
  assert.match(posture, /destination_port: '3000,3001'/);
  assert.match(d, /repairControlPanelProxy/);
  assert.match(d, /repairUIEgressAcl/);
  assert.match(d, /System security posture repaired and verified/);
  assert.match(d, /Verifying credentialed PostgreSQL health/);
  assert.match(d, /Verifying Pi-Hole web and DNS health/);
  assert.match(d, /Control Panel proxy repaired; UI ACL will be applied after UI redeploy/);
  assert.match(d, /YouEye UI container deployed and egress ACL applied/);
});

test('CP telemetry defaults disabled and middleware record endpoint no-ops while disabled', () => {
  const t = read('src/lib/telemetry/tracker.ts');
  const r = read('src/app/api/telemetry/record/route.ts');
  assert.match(t, /enabled: false/);
  assert.match(t, /explicit_opt_in_at\?: string/);
  assert.match(t, /parsed\.enabled =\s*parsed\.enabled === true &&/);
  assert.match(t, /parsed\.explicit_opt_in_at === "string"/);
  assert.match(t, /this\.data\.explicit_opt_in_at = this\.data\.explicit_opt_in_at \|\| new Date\(\)\.toISOString\(\)/);
  assert.match(r, /if \(!isTelemetryEnabled\(\)\)/);
});

test('direct LAN port 3000 recovery copy was removed', () => {
  const users = read('src/components/settings-shell/users-client.tsx');
  const en = read('messages/en.json');
  assert.doesNotMatch(users, /http:\/\/\$\{serverIp\}:3000/);
  assert.doesNotMatch(users, /127\.0\.0\.1:3000/);
  assert.doesNotMatch(en, /Control Panel on port 3000/);
  assert.match(en, /localhost:3000 is reserved/);
});
