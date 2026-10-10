import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ADMISSION_SCHEMA_SQL } from '../src/lib/admission/schema';

const sshTarget = process.env.YOUEYE_ADMISSION_TEST_SSH_TARGET;
test('PostgreSQL migration, membership revocation, ownership guards and tombstones', { skip: !sshTarget }, () => {
  // One rolled-back isolated schema, no reads/writes of the appliance's live
  // identities. Explicit opt-in selects an authorized test database host.
  const schema = `admission_test_${randomUUID().replaceAll('-', '')}`;
  const sql = `
    BEGIN;
    CREATE SCHEMA ${schema};
    SET LOCAL search_path = ${schema}, pg_catalog;
    CREATE TABLE identity_users (id uuid PRIMARY KEY, groups jsonb NOT NULL DEFAULT '[]', is_active boolean NOT NULL,
      is_admin boolean NOT NULL DEFAULT false);
    CREATE TABLE identity_appliance_claim (owner_user_id uuid);
    CREATE TABLE identity_clients (client_id text PRIMARY KEY);
    CREATE TABLE identity_session_clients (session_id uuid, client_id text, user_id uuid);
    CREATE TABLE identity_auth_codes (code text PRIMARY KEY, client_id text, user_id uuid);
    CREATE TABLE identity_refresh_tokens (client_id text, user_id uuid, revoked_at timestamptz);
    INSERT INTO identity_users (id, groups, is_active) VALUES
      ('10000000-0000-4000-8000-000000000001','["family","admin"]',true),
      ('10000000-0000-4000-8000-000000000002','["family"]',true),
      ('10000000-0000-4000-8000-000000000003','["other"]',true);
    INSERT INTO identity_clients VALUES ('youeye-control'), ('youeye-ui'), ('client-a'), ('client-b');
    UPDATE identity_users SET is_admin=true WHERE id='10000000-0000-4000-8000-000000000001';
    INSERT INTO identity_appliance_claim VALUES ('10000000-0000-4000-8000-000000000001');
    ${ADMISSION_SCHEMA_SQL}
    ${ADMISSION_SCHEMA_SQL}
    INSERT INTO admission_policies (app_id, owner_id, state) VALUES
      ('app-a','10000000-0000-4000-8000-000000000001','ready'),
      ('app-b','10000000-0000-4000-8000-000000000001','ready');
    INSERT INTO identity_refresh_tokens VALUES ('client-a','10000000-0000-4000-8000-000000000003',NULL);
    INSERT INTO identity_auth_codes VALUES ('unbound-code','client-a','10000000-0000-4000-8000-000000000003');
    INSERT INTO identity_session_clients VALUES
      ('40000000-0000-4000-8000-000000000003','client-a','10000000-0000-4000-8000-000000000003');
    INSERT INTO admission_clients (client_id, installation_id)
      SELECT 'client-a', installation_id FROM admission_policies WHERE app_id='app-a';
    INSERT INTO admission_clients (client_id, installation_id)
      SELECT 'client-b', installation_id FROM admission_policies WHERE app_id='app-b';
    DO $assertions$
    BEGIN
      IF EXISTS (SELECT 1 FROM identity_auth_codes WHERE code='unbound-code')
        OR EXISTS (SELECT 1 FROM identity_refresh_tokens WHERE user_id='10000000-0000-4000-8000-000000000003'
          AND revoked_at IS NULL) THEN RAISE EXCEPTION 'Initial client binding retained denied grants'; END IF;
      IF NOT EXISTS (SELECT 1 FROM admission_logout_outbox WHERE user_id='10000000-0000-4000-8000-000000000003')
        THEN RAISE EXCEPTION 'Initial binding omitted participating logout'; END IF;
    END $assertions$;
    DO $assertions$
    DECLARE p admission_policies; uid uuid := '10000000-0000-4000-8000-000000000002';
    BEGIN
      SELECT * INTO p FROM admission_policies WHERE app_id='app-a';
      IF admission_granted(p, uid) THEN RAISE EXCEPTION 'Owner-only admitted household user'; END IF;
      p.mode := 'users'; p.user_ids := jsonb_build_array(uid::text);
      IF NOT admission_granted(p, uid) THEN RAISE EXCEPTION 'Selected user denied'; END IF;
      p.mode := 'all_users';
      IF NOT admission_granted(p, uid) THEN RAISE EXCEPTION 'Active user denied'; END IF;
      p.mode := 'groups'; p.group_ids := (SELECT jsonb_agg(id::text) FROM admission_groups WHERE group_key='family');
      IF NOT admission_granted(p, uid) THEN RAISE EXCEPTION 'Group user denied'; END IF;
      p.group_ids := '[]';
      IF admission_granted(p, uid) THEN RAISE EXCEPTION 'Empty group selection admitted user'; END IF;
      p.state := 'quarantined';
      IF admission_granted(p, p.owner_id) THEN RAISE EXCEPTION 'Quarantined owner admitted'; END IF;
    END $assertions$;
    UPDATE admission_policies SET mode='groups',
      group_ids=(SELECT jsonb_agg(id::text) FROM admission_groups WHERE group_key='family'), revision=revision+1
      WHERE app_id='app-a';
    INSERT INTO identity_refresh_tokens VALUES
      ('client-a','10000000-0000-4000-8000-000000000002',NULL),
      ('client-a','10000000-0000-4000-8000-000000000001',NULL),
      ('client-b','10000000-0000-4000-8000-000000000001',NULL);
    INSERT INTO identity_auth_codes VALUES ('issued-before-revocation','client-a','10000000-0000-4000-8000-000000000002');
    INSERT INTO identity_session_clients VALUES
      ('40000000-0000-4000-8000-000000000001','client-a','10000000-0000-4000-8000-000000000002');
    UPDATE identity_users SET groups='["other"]' WHERE id='10000000-0000-4000-8000-000000000002';
    DO $assertions$
    BEGIN
      IF EXISTS (SELECT 1 FROM identity_auth_codes) THEN RAISE EXCEPTION 'Revoked code remained redeemable'; END IF;
      IF EXISTS (SELECT 1 FROM identity_refresh_tokens WHERE user_id='10000000-0000-4000-8000-000000000002' AND revoked_at IS NULL)
        THEN RAISE EXCEPTION 'Refresh grant survived membership removal'; END IF;
      IF EXISTS (SELECT 1 FROM identity_refresh_tokens WHERE user_id='10000000-0000-4000-8000-000000000001' AND revoked_at IS NOT NULL)
        THEN RAISE EXCEPTION 'Other users/apps were revoked'; END IF;
      IF NOT EXISTS (SELECT 1 FROM admission_outbox o JOIN admission_policies p USING(installation_id)
        WHERE p.app_id='app-a' AND o.revision=3 AND o.acknowledged_revision=0) THEN RAISE EXCEPTION 'Revocation not pending'; END IF;
      IF (SELECT revision FROM admission_policies WHERE app_id='app-b') <> 1 THEN RAISE EXCEPTION 'Unaffected app revision changed'; END IF;
      IF NOT EXISTS (SELECT 1 FROM admission_logout_outbox WHERE client_id='client-a' AND NOT queued)
        THEN RAISE EXCEPTION 'Participating logout was not durably queued'; END IF;
      BEGIN
        DELETE FROM identity_users WHERE id='10000000-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'Owner deletion succeeded';
      EXCEPTION WHEN raise_exception THEN
        IF SQLERRM='Owner deletion succeeded' THEN RAISE; END IF;
      END;
    END $assertions$;
    INSERT INTO admission_resources (installation_id,resource_id,declaration,owner_id,private_user_id,state)
      SELECT installation_id,'private-rows','{}',owner_id,'10000000-0000-4000-8000-000000000002','active'
      FROM admission_policies WHERE app_id='app-a';
    DO $assertions$
    BEGIN
      BEGIN
        DELETE FROM identity_users WHERE id='10000000-0000-4000-8000-000000000002';
        RAISE EXCEPTION 'Private resource deletion succeeded';
      EXCEPTION WHEN raise_exception THEN
        IF SQLERRM='Private resource deletion succeeded' THEN RAISE; END IF;
      END;
    END $assertions$;
    UPDATE admission_resources SET state='quarantined' WHERE resource_id='private-rows';
    DELETE FROM identity_users WHERE id='10000000-0000-4000-8000-000000000002';
    DO $assertions$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM admission_principals WHERE id='10000000-0000-4000-8000-000000000002'
        AND deleted_at IS NOT NULL AND NOT active) THEN RAISE EXCEPTION 'Missing deletion tombstone'; END IF;
      IF (SELECT revision FROM admission_policies WHERE app_id='app-b') <> 1
        THEN RAISE EXCEPTION 'Deletion changed an unrelated app lease'; END IF;
      BEGIN
        INSERT INTO identity_users (id,groups,is_active) VALUES ('10000000-0000-4000-8000-000000000002','[]',true);
        RAISE EXCEPTION 'Deleted UUID reused';
      EXCEPTION WHEN raise_exception THEN IF SQLERRM='Deleted UUID reused' THEN RAISE; END IF; END;
      BEGIN
        UPDATE admission_policies SET schema_version=2, revision=revision+1 WHERE app_id='app-a';
        RAISE EXCEPTION 'Unsupported policy schema accepted';
      EXCEPTION WHEN check_violation THEN NULL; END;
    END $assertions$;
    ROLLBACK;
  `;
  const result = spawnSync('ssh', [sshTarget!, 'incus', 'exec', 'youeye-postgres', '--', 'psql',
    '-U', 'youeye', '-d', 'youeye', '-v', 'ON_ERROR_STOP=1', '-q'], { input: sql, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'PostgreSQL test failed');
});
