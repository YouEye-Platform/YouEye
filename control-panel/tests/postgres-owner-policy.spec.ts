import assert from 'node:assert/strict';
import test from 'node:test';
import { restoredAppOwnerSessionPolicy } from '../src/lib/backup/postgres-owner-policy';

test('archive role identities cannot retarget privacy policy to platform or PostgreSQL administrators', () => {
  for (const role of ['postgres', 'Postgres', 'youeye', 'YOUEYE', 'youeye_ui', 'pointer', 'pg_read_all_data', 'PG_monitor']) {
    assert.throws(() => restoredAppOwnerSessionPolicy(role), /scoped app database owner/);
  }
});

test('archive role identities cannot inject SQL, extra settings, or identifier truncation aliases', () => {
  for (const role of ['', 'a'.repeat(64), 'owner;RESET ALL', 'owner";ALTER ROLE postgres SUPERUSER;--', 'owner\n', 'owner\\', 'owner\0', 'owner.name']) {
    assert.throws(() => restoredAppOwnerSessionPolicy(role), /scoped app database owner/);
  }
});

test('scoped quoted role names preserve case without changing administrator or preload policy', () => {
  const sql = restoredAppOwnerSessionPolicy('Household_App_owner');
  assert.ok(sql.split('\n').filter(Boolean).every(line => line.startsWith('ALTER ROLE "Household_App_owner" SET log_')));
  assert.doesNotMatch(sql, /PASSWORD|SUPERUSER|GRANT|preload|RESET/);
});
