import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto';
import { execShell } from '@/lib/incus/server';
import { POSTGRES_MANIFEST } from '@/lib/apps/manifest';
import { requireIdentityPassword } from './password-policy';
import { ADMISSION_SCHEMA_SQL } from '@/lib/admission/schema';

const CONTAINER = POSTGRES_MANIFEST.containerName;

export interface IdentityUser {
  id: string;
  username: string;
  name: string;
  first_name: string;
  last_name: string;
  email: string;
  groups: string[];
  is_admin: boolean;
  is_active: boolean;
}

export interface IdentityClient {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
  post_logout_redirect_uris: string[];
  backchannel_logout_uri: string | null;
  scopes: string[];
}

export interface IdentityAppConsent {
  user_id: string;
  client_id: string;
  scopes: string[];
  granted_at: string;
  updated_at: string;
}

export interface AuthCode {
  code: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scope: string;
  nonce: string | null;
  code_challenge: string | null;
  session_id: string | null;
}

export interface IdentitySession {
  id: string;
  user_id: string;
  expires_at: string;
  idle_expires_at: string;
  revoked_at: string | null;
}

export interface LogoutDelivery {
  id: string;
  client_id: string;
  uri: string;
  logout_token: string;
  attempts: number;
  session_id: string;
}

export interface ApplianceClaimStatus {
  claimed: boolean;
  ownerUsername: string | null;
  setupCompleted: boolean;
  operationActive: boolean;
}

function sql(value: string | number | boolean | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlJson(value: unknown): string {
  return `${sql(JSON.stringify(value))}::jsonb`;
}

// Shared platform database transport; callers must initialize the identity
// schema and use these quoting helpers for every supplied value.
export { sql as identitySql, sqlJson as identitySqlJson, psql as identityCommand, queryRows as identityRows };
/** Keep data-modifying CTEs at PostgreSQL's required top level. */
export async function identityStatementRows<T>(ctes: string, outputSelect: string): Promise<T[]> {
  return queryCommandRows<T>(`WITH ${ctes},
    identity_result AS (${outputSelect})
    SELECT COALESCE(json_agg(row_to_json(identity_result)), '[]'::json)::text FROM identity_result`);
}

async function psql(command: string): Promise<string> {
  const escaped = command
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/'/g, "'\\''");
  const { exitCode, stdout, stderr } = await execShell(
    CONTAINER,
    `su - postgres -c "psql -v ON_ERROR_STOP=1 -U youeye -d youeye -tA -c '${escaped}'"`,
    { timeout: 15000 }
  );
  if (exitCode !== 0) {
    throw new Error(`YouEye ID database error: ${stderr || stdout}`);
  }
  return stdout.trim();
}

async function queryRows<T>(selectSql: string): Promise<T[]> {
  const out = await psql(`WITH t AS (${selectSql}) SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)::text FROM t`);
  const line = out.split('\n').filter(Boolean).pop() || '[]';
  return JSON.parse(line) as T[];
}

async function queryCommandRows<T>(command: string): Promise<T[]> {
  const out = await psql(command);
  const line = out.split('\n').filter(Boolean).pop() || '[]';
  return JSON.parse(line) as T[];
}

let schemaReady = false;
let schemaSetup: Promise<void> | null = null;

export async function ensureIdentitySchema(): Promise<void> {
  if (schemaReady) return;
  if (schemaSetup) return schemaSetup;
  schemaSetup = initializeIdentitySchema();
  try {
    await schemaSetup;
    schemaReady = true;
  } finally {
    schemaSetup = null;
  }
}

/** A full restore replaces the database while this CP process may survive. */
export async function refreshIdentitySchemaAfterRestore(): Promise<void> {
  if (schemaSetup) await schemaSetup;
  schemaReady = false;
  await ensureIdentitySchema();
}

async function initializeIdentitySchema(): Promise<void> {
  await psql(`
    BEGIN;
    SELECT pg_advisory_xact_lock(hashtext('youeye-identity-schema'));
    CREATE TABLE IF NOT EXISTS identity_users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      username text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      name text NOT NULL DEFAULT '',
      first_name text NOT NULL,
      last_name text NOT NULL DEFAULT '',
      email text NOT NULL DEFAULT '',
      groups jsonb NOT NULL DEFAULT '[]'::jsonb,
      is_admin boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE identity_users
      ADD COLUMN IF NOT EXISTS first_name text;
    ALTER TABLE identity_users
      ADD COLUMN IF NOT EXISTS last_name text;
    ALTER TABLE identity_users
      ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
    UPDATE identity_users
    SET first_name = COALESCE(NULLIF(btrim(first_name), ''), NULLIF(btrim(name), ''), username),
        last_name = COALESCE(last_name, '')
    WHERE first_name IS NULL OR btrim(first_name) = '' OR last_name IS NULL;
    ALTER TABLE identity_users
      ALTER COLUMN first_name SET NOT NULL,
      ALTER COLUMN last_name SET DEFAULT '',
      ALTER COLUMN last_name SET NOT NULL;
    CREATE TABLE IF NOT EXISTS identity_clients (
      client_id text PRIMARY KEY,
      client_secret text NOT NULL,
      name text NOT NULL DEFAULT '',
      redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb,
      post_logout_redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb,
      backchannel_logout_uri text,
      scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE identity_clients ADD COLUMN IF NOT EXISTS post_logout_redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE identity_clients ADD COLUMN IF NOT EXISTS backchannel_logout_uri text;
    CREATE TABLE IF NOT EXISTS identity_auth_codes (
      code text PRIMARY KEY,
      client_id text NOT NULL REFERENCES identity_clients(client_id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
      redirect_uri text NOT NULL,
      scope text NOT NULL,
      nonce text,
      code_challenge text,
      session_id uuid,
      expires_at timestamptz NOT NULL,
      used_at timestamptz
    );
    ALTER TABLE identity_auth_codes ADD COLUMN IF NOT EXISTS code_challenge text;
    ALTER TABLE identity_auth_codes ADD COLUMN IF NOT EXISTS session_id uuid;
    CREATE TABLE IF NOT EXISTS identity_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      idle_expires_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS identity_session_clients (
      session_id uuid NOT NULL REFERENCES identity_sessions(id) ON DELETE CASCADE,
      client_id text NOT NULL REFERENCES identity_clients(client_id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
      PRIMARY KEY (session_id, client_id)
    );
    CREATE INDEX IF NOT EXISTS identity_sessions_user_active_idx ON identity_sessions(user_id, revoked_at);
    CREATE TABLE IF NOT EXISTS identity_logout_deliveries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid,
      client_id text NOT NULL,
      uri text NOT NULL,
      logout_token text NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      delivered_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE identity_logout_deliveries ADD COLUMN IF NOT EXISTS session_id uuid;
    ALTER TABLE identity_logout_deliveries ADD COLUMN IF NOT EXISTS event_key text;
    UPDATE identity_logout_deliveries SET event_key =
      CASE WHEN session_id IS NOT NULL THEN 'session:' || session_id::text || ':' || client_id
        ELSE 'legacy:' || id::text END WHERE event_key IS NULL;
    ALTER TABLE identity_logout_deliveries ALTER COLUMN event_key SET NOT NULL;
    DROP INDEX IF EXISTS identity_logout_session_client_idx;
    CREATE UNIQUE INDEX IF NOT EXISTS identity_logout_event_idx ON identity_logout_deliveries(event_key);
    CREATE INDEX IF NOT EXISTS identity_logout_due_idx ON identity_logout_deliveries(next_attempt_at)
      WHERE delivered_at IS NULL;
    CREATE TABLE IF NOT EXISTS identity_refresh_tokens (
      token_hash text PRIMARY KEY,
      family_id uuid NOT NULL,
      session_id uuid NOT NULL REFERENCES identity_sessions(id) ON DELETE CASCADE,
      client_id text NOT NULL REFERENCES identity_clients(client_id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
      scope text NOT NULL,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      revoked_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS identity_refresh_family_idx ON identity_refresh_tokens(family_id);
    CREATE TABLE IF NOT EXISTS identity_refresh_families (
      id uuid PRIMARY KEY,
      revoked_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS identity_revoked_access_tokens (
      token_id uuid PRIMARY KEY,
      expires_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS identity_revoked_before (
      user_id uuid PRIMARY KEY REFERENCES identity_users(id) ON DELETE CASCADE,
      revoked_before timestamptz NOT NULL
    );
    CREATE OR REPLACE FUNCTION identity_rotate_refresh(
      presented_hash text, requested_client text, replacement_hash text
    ) RETURNS TABLE (user_id text, session_id text, scope text)
    LANGUAGE plpgsql AS $rotation$
    DECLARE
      old_token identity_refresh_tokens%ROWTYPE;
      old_family identity_refresh_families%ROWTYPE;
      active_session identity_sessions%ROWTYPE;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM identity_refresh_tokens t
        WHERE t.token_hash = presented_hash AND t.client_id = requested_client
          AND admission_client_granted(requested_client, t.user_id)) THEN RETURN; END IF;
      SELECT * INTO old_token FROM identity_refresh_tokens
      WHERE token_hash = presented_hash AND client_id = requested_client FOR UPDATE;
      IF NOT FOUND THEN RETURN; END IF;
      SELECT * INTO old_family FROM identity_refresh_families
      WHERE id = old_token.family_id FOR UPDATE;
      IF NOT FOUND OR old_family.revoked_at IS NOT NULL THEN RETURN; END IF;
      IF old_token.used_at IS NOT NULL THEN
        UPDATE identity_refresh_families SET revoked_at = now() WHERE id = old_token.family_id;
        UPDATE identity_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE id = old_token.session_id;
        RETURN;
      END IF;
      SELECT * INTO active_session FROM identity_sessions
      WHERE id = old_token.session_id FOR UPDATE;
      IF NOT FOUND OR active_session.revoked_at IS NOT NULL
        OR active_session.idle_expires_at <= now() OR active_session.expires_at <= now()
        OR old_token.revoked_at IS NOT NULL OR old_token.expires_at <= now()
      THEN RETURN; END IF;
      UPDATE identity_refresh_tokens SET used_at = now() WHERE token_hash = old_token.token_hash;
      INSERT INTO identity_refresh_tokens
        (token_hash, family_id, session_id, client_id, user_id, scope, expires_at)
      VALUES (replacement_hash, old_token.family_id, old_token.session_id,
        old_token.client_id, old_token.user_id, old_token.scope, old_token.expires_at);
      user_id := old_token.user_id::text;
      session_id := old_token.session_id::text;
      scope := old_token.scope;
      RETURN NEXT;
    END;
    $rotation$;
    CREATE TABLE IF NOT EXISTS identity_secrets (
      purpose text PRIMARY KEY,
      secret text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS identity_app_consents (
      user_id uuid NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
      client_id text NOT NULL REFERENCES identity_clients(client_id) ON DELETE CASCADE,
      scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
      granted_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, client_id)
    );
    CREATE TABLE IF NOT EXISTS identity_appliance_claim (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      owner_user_id uuid UNIQUE REFERENCES identity_users(id) ON DELETE RESTRICT,
      claimed_at timestamptz,
      setup_completed_at timestamptz,
      operation_session_id text,
      operation_expires_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS identity_setup_handoffs (
      code_hash text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
      target_origin text NOT NULL,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO identity_appliance_claim (singleton) VALUES (true)
    ON CONFLICT (singleton) DO NOTHING;
    ${ADMISSION_SCHEMA_SQL}
    COMMIT;
  `);
}

export async function getApplianceClaimStatus(): Promise<ApplianceClaimStatus> {
  await ensureIdentitySchema();
  const rows = await queryRows<{
    claimed: boolean;
    owner_username: string | null;
    setup_completed: boolean;
    operation_active: boolean;
  }>(`
    SELECT
      c.owner_user_id IS NOT NULL AS claimed,
      u.username AS owner_username,
      c.setup_completed_at IS NOT NULL AS setup_completed,
      c.operation_session_id IS NOT NULL AND c.operation_expires_at > now() AS operation_active
    FROM identity_appliance_claim c
    LEFT JOIN identity_users u ON u.id = c.owner_user_id
    WHERE c.singleton = true
  `);
  const status = rows[0];
  return {
    claimed: Boolean(status?.claimed),
    ownerUsername: status?.owner_username || null,
    setupCompleted: Boolean(status?.setup_completed),
    operationActive: Boolean(status?.operation_active),
  };
}

export async function claimApplianceOwner(input: {
  username: string;
  password: string;
  firstName: string;
  lastName?: string;
  email: string;
}): Promise<IdentityUser | null> {
  await ensureIdentitySchema();
  requireIdentityPassword(input.password);
  const passwordHash = hashPassword(input.password);
  const firstName = input.firstName.trim();
  const lastName = input.lastName?.trim() || '';
  const name = [firstName, lastName].filter(Boolean).join(' ');
  const rows = await queryCommandRows<IdentityUser>(`
    WITH available AS (
      SELECT singleton
      FROM identity_appliance_claim
      WHERE singleton = true AND owner_user_id IS NULL
      FOR UPDATE
    ), created AS (
      INSERT INTO identity_users (username, password_hash, name, first_name, last_name, email, groups, is_admin)
      SELECT ${sql(input.username)}, ${sql(passwordHash)}, ${sql(name)}, ${sql(firstName)}, ${sql(lastName)}, ${sql(input.email)}, ${sqlJson(['youeye-users', 'admin'])}, true
      FROM available
      ON CONFLICT (username) DO NOTHING
      RETURNING id, username, name, first_name, last_name, email, groups, is_admin, is_active
    ), linked AS (
      UPDATE identity_appliance_claim c
      SET owner_user_id = created.id,
          claimed_at = now()
      FROM created
      WHERE c.singleton = true AND c.owner_user_id IS NULL
      RETURNING created.id::text, created.username, created.name, created.first_name, created.last_name, created.email, created.groups, created.is_admin, created.is_active
    )
    SELECT COALESCE(json_agg(row_to_json(linked)), '[]'::json)::text FROM linked
  `);
  return rows[0] || null;
}

export async function verifyApplianceOwner(username: string, password: string): Promise<IdentityUser | null> {
  const user = await verifyUser(username, password);
  if (!user) return null;
  const rows = await queryRows<{ owner_user_id: string }>(`
    SELECT owner_user_id::text
    FROM identity_appliance_claim
    WHERE singleton = true AND owner_user_id = ${sql(user.id)}
  `);
  return rows[0] ? user : null;
}

export async function acquireSetupOperation(ownerId: string, sessionId: string): Promise<boolean> {
  await ensureIdentitySchema();
  const rows = await queryRows<{ acquired: boolean }>(`
    UPDATE identity_appliance_claim
    SET operation_session_id = ${sql(sessionId)},
        operation_expires_at = now() + interval '5 minutes'
    WHERE singleton = true
      AND owner_user_id = ${sql(ownerId)}
      AND setup_completed_at IS NULL
      AND (
        operation_session_id IS NULL
        OR operation_expires_at <= now()
        OR operation_session_id = ${sql(sessionId)}
      )
    RETURNING true AS acquired
  `);
  return Boolean(rows[0]?.acquired);
}

export async function heartbeatSetupOperation(ownerId: string, sessionId: string): Promise<void> {
  await ensureIdentitySchema();
  const rows = await queryRows<{ renewed: boolean }>(`
    UPDATE identity_appliance_claim
    SET operation_expires_at = now() + interval '5 minutes'
    WHERE singleton = true
      AND owner_user_id = ${sql(ownerId)}
      AND operation_session_id = ${sql(sessionId)}
    RETURNING true AS renewed
  `);
  if (!rows[0]?.renewed) throw new Error('The active setup operation lease was lost. Reload setup before retrying.');
}

export async function releaseSetupOperation(ownerId: string, sessionId: string): Promise<void> {
  await ensureIdentitySchema();
  await psql(`
    UPDATE identity_appliance_claim
    SET operation_session_id = NULL, operation_expires_at = NULL
    WHERE singleton = true
      AND owner_user_id = ${sql(ownerId)}
      AND operation_session_id = ${sql(sessionId)}
  `);
}

export async function markApplianceSetupComplete(ownerId: string, sessionId: string): Promise<void> {
  await ensureIdentitySchema();
  const rows = await queryRows<{ completed: boolean }>(`
    UPDATE identity_appliance_claim
    SET setup_completed_at = COALESCE(setup_completed_at, now()),
        operation_session_id = NULL,
        operation_expires_at = NULL
    WHERE singleton = true
      AND owner_user_id = ${sql(ownerId)}
      AND operation_session_id = ${sql(sessionId)}
    RETURNING true AS completed
  `);
  if (!rows[0]?.completed) throw new Error('Could not finalize the appliance owner claim.');
}

/** Repair the one-way boundary when platform config committed before the claim marker. */
export async function reconcileApplianceSetupComplete(): Promise<void> {
  await ensureIdentitySchema();
  await psql(`
    UPDATE identity_appliance_claim
    SET setup_completed_at = COALESCE(setup_completed_at, now()),
        operation_session_id = NULL,
        operation_expires_at = NULL
    WHERE singleton = true AND owner_user_id IS NOT NULL
  `);
}

export async function createSetupHandoff(userId: string, targetOrigin: string): Promise<string> {
  await ensureIdentitySchema();
  const code = randomBytes(32).toString('base64url');
  const codeHash = createHash('sha256').update(code).digest('hex');
  await psql(`
    DELETE FROM identity_setup_handoffs WHERE expires_at <= now() OR used_at IS NOT NULL;
    INSERT INTO identity_setup_handoffs (code_hash, user_id, target_origin, expires_at)
    SELECT ${sql(codeHash)}, owner_user_id, ${sql(targetOrigin)}, now() + interval '5 minutes'
    FROM identity_appliance_claim
    WHERE singleton = true
      AND owner_user_id = ${sql(userId)}
      AND setup_completed_at IS NOT NULL
  `);
  return code;
}

export async function consumeSetupHandoff(code: string, targetOrigin: string): Promise<IdentityUser | null> {
  await ensureIdentitySchema();
  const codeHash = createHash('sha256').update(code).digest('hex');
  const rows = await queryRows<{ user_id: string }>(`
    UPDATE identity_setup_handoffs
    SET used_at = now()
    WHERE code_hash = ${sql(codeHash)}
      AND target_origin = ${sql(targetOrigin)}
      AND used_at IS NULL
      AND expires_at > now()
    RETURNING user_id::text
  `);
  return rows[0] ? getUserById(rows[0].user_id) : null;
}

export function hashPassword(password: string): string {
  requireIdentityPassword(password);
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const actual = Buffer.from(scryptSync(password, salt, 64).toString('hex'), 'utf8');
  const expected = Buffer.from(hash, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function ensureUser(input: {
  username: string;
  password: string;
  name: string;
  email: string;
  groups: string[];
  isAdmin: boolean;
}): Promise<IdentityUser> {
  return withIdentityAppLifecycle(() => ensureUserUnderLifecycle(input));
}

async function ensureUserUnderLifecycle(input: {
  username: string;
  password: string;
  name: string;
  email: string;
  groups: string[];
  isAdmin: boolean;
}): Promise<IdentityUser> {
  await ensureIdentitySchema();
  requireIdentityPassword(input.password);
  const passwordHash = hashPassword(input.password);
  const firstName = input.name.trim();
  const rows = await queryRows<IdentityUser>(`
    INSERT INTO identity_users (username, password_hash, name, first_name, last_name, email, groups, is_admin, is_active)
    VALUES (${sql(input.username)}, ${sql(passwordHash)}, ${sql(firstName)}, ${sql(firstName)}, '', ${sql(input.email)}, ${sqlJson(input.groups)}, ${sql(input.isAdmin)}, true)
    ON CONFLICT (username) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      name = EXCLUDED.name,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      email = EXCLUDED.email,
      groups = EXCLUDED.groups,
      is_admin = EXCLUDED.is_admin,
      is_active = true,
      updated_at = now()
    RETURNING id::text, username, name, first_name, last_name, email, groups, is_admin, is_active
  `);
  return rows[0];
}

export async function verifyUser(username: string, password: string): Promise<IdentityUser | null> {
  await ensureIdentitySchema();
  const rows = await queryRows<IdentityUser & { password_hash: string }>(`
    SELECT id::text, username, password_hash, name, first_name, last_name, email, groups, is_admin, is_active
    FROM identity_users
    WHERE username = ${sql(username)}
    LIMIT 1
  `);
  const user = rows[0];
  if (!user || !user.is_active || !verifyPassword(password, user.password_hash)) return null;
  const safeUser: IdentityUser = {
    id: user.id,
    username: user.username,
    name: user.name,
    first_name: user.first_name,
    last_name: user.last_name,
    email: user.email,
    groups: user.groups,
    is_admin: user.is_admin,
    is_active: user.is_active,
  };
  return safeUser;
}

export async function getUserById(id: string): Promise<IdentityUser | null> {
  await ensureIdentitySchema();
  const rows = await queryRows<IdentityUser>(`
    SELECT id::text, username, name, first_name, last_name, email, groups, is_admin, is_active
    FROM identity_users
    WHERE id = ${sql(id)}
    LIMIT 1
  `);
  return rows[0] || null;
}

export async function getUserByUsername(username: string): Promise<IdentityUser | null> {
  await ensureIdentitySchema();
  const rows = await queryRows<IdentityUser>(`
    SELECT id::text, username, name, first_name, last_name, email, groups, is_admin, is_active
    FROM identity_users
    WHERE username = ${sql(username)}
    LIMIT 1
  `);
  return rows[0] || null;
}

export async function listIdentityUsers(search?: string): Promise<IdentityUser[]> {
  await ensureIdentitySchema();
  const where = search
    ? `WHERE username ILIKE '%' || ${sql(search)} || '%' OR name ILIKE '%' || ${sql(search)} || '%' OR email ILIKE '%' || ${sql(search)} || '%'`
    : '';
  return queryRows<IdentityUser>(`
    SELECT id::text, username, name, first_name, last_name, email, groups, is_admin, is_active
    FROM identity_users
    ${where}
    ORDER BY username ASC
  `);
}

export async function createIdentityUser(input: {
  username: string;
  password: string;
  firstName: string;
  lastName?: string;
  email?: string;
  groups?: string[];
  isAdmin?: boolean;
  isActive?: boolean;
}): Promise<IdentityUser> {
  return withIdentityAppLifecycle(() => createIdentityUserUnderLifecycle(input));
}

async function createIdentityUserUnderLifecycle(input: {
  username: string;
  password: string;
  firstName: string;
  lastName?: string;
  email?: string;
  groups?: string[];
  isAdmin?: boolean;
  isActive?: boolean;
}): Promise<IdentityUser> {
  await ensureIdentitySchema();
  requireIdentityPassword(input.password);
  const passwordHash = hashPassword(input.password);
  const groups = input.groups || (input.isAdmin ? ['admin'] : ['youeye-users']);
  const firstName = input.firstName.trim();
  const lastName = input.lastName?.trim() || '';
  const name = [firstName, lastName].filter(Boolean).join(' ');
  const rows = await queryRows<IdentityUser>(`
    INSERT INTO identity_users (username, password_hash, name, first_name, last_name, email, groups, is_admin, is_active)
    VALUES (${sql(input.username)}, ${sql(passwordHash)}, ${sql(name)}, ${sql(firstName)}, ${sql(lastName)}, ${sql(input.email || '')}, ${sqlJson(groups)}, ${sql(Boolean(input.isAdmin))}, ${sql(input.isActive !== false)})
    RETURNING id::text, username, name, first_name, last_name, email, groups, is_admin, is_active
  `);
  return rows[0];
}

export type IdentityUserPatch = {
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  groups?: string[];
  isAdmin?: boolean;
  isActive?: boolean;
  password?: string;
};

/** External credential effects and the authoritative identity write share one
 * store-owned admission. A callback cannot accidentally reacquire the same OS
 * gates through a second provider/store transaction. Direct callers stay guarded. */
export async function updateIdentityUser(
  id: string,
  patch: IdentityUserPatch | ((current: IdentityUser) => Promise<IdentityUserPatch>),
  afterCommit?: (updated: IdentityUser) => Promise<void>,
): Promise<IdentityUser> {
  return withIdentityAppLifecycle(async () => {
    let resolved: IdentityUserPatch;
    if (typeof patch === 'function') {
      const current = await getUserById(id);
      if (!current) throw new Error(`Identity user not found: ${id}`);
      resolved = await patch(current);
    } else resolved = patch;
    const updated = await updateIdentityUserUnderLifecycle(id, resolved);
    await afterCommit?.(updated);
    return updated;
  });
}

async function updateIdentityUserUnderLifecycle(id: string, patch: {
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  groups?: string[];
  isAdmin?: boolean;
  isActive?: boolean;
  password?: string;
}): Promise<IdentityUser> {
  await ensureIdentitySchema();
  if (patch.isActive === false || patch.isAdmin === false) await assertIdentityDisposition(id, 'disable');
  const assignments: string[] = ['updated_at = now()'];
  if (typeof patch.firstName === 'string' || typeof patch.lastName === 'string') {
    const current = await getUserById(id);
    if (!current) throw new Error(`Identity user not found: ${id}`);
    const firstName = typeof patch.firstName === 'string' ? patch.firstName.trim() : current.first_name;
    const lastName = typeof patch.lastName === 'string' ? patch.lastName.trim() : current.last_name;
    const name = [firstName, lastName].filter(Boolean).join(' ');
    assignments.push(`name = ${sql(name)}`, `first_name = ${sql(firstName)}`, `last_name = ${sql(lastName)}`);
  } else if (typeof patch.name === 'string') {
    // Compatibility callers may still supply a combined display name. Preserve
    // the existing family name rather than clearing it.
    const current = await getUserById(id);
    if (!current) throw new Error(`Identity user not found: ${id}`);
    const name = patch.name.trim();
    assignments.push(`name = ${sql(name)}`, `first_name = ${sql(name || current.first_name)}`);
  }
  if (typeof patch.email === 'string') assignments.push(`email = ${sql(patch.email)}`);
  if (Array.isArray(patch.groups)) assignments.push(`groups = ${sqlJson(patch.groups)}`);
  if (typeof patch.isAdmin === 'boolean') assignments.push(`is_admin = ${sql(patch.isAdmin)}`);
  if (typeof patch.isActive === 'boolean') assignments.push(`is_active = ${sql(patch.isActive)}`);
  if (typeof patch.password === 'string') {
    requireIdentityPassword(patch.password);
    assignments.push(`password_hash = ${sql(hashPassword(patch.password))}`);
  }

  const rows = await queryRows<IdentityUser>(`
    UPDATE identity_users
    SET ${assignments.join(', ')}
    WHERE id = ${sql(id)}
    RETURNING id::text, username, name, first_name, last_name, email, groups, is_admin, is_active
  `);
  if (!rows[0]) throw new Error(`Identity user not found: ${id}`);
  return rows[0];
}

export async function deleteIdentityUser(id: string, beforeDelete?: (current: IdentityUser) => Promise<void>): Promise<void> {
  return withIdentityAppLifecycle(async () => {
    await assertIdentityDisposition(id, 'delete');
    if (beforeDelete) {
      const current = await getUserById(id);
      if (!current) throw new Error(`Identity user not found: ${id}`);
      await beforeDelete(current);
    }
    await deleteIdentityUserUnderLifecycle(id);
  });
}

async function deleteIdentityUserUnderLifecycle(id: string): Promise<void> {
  await ensureIdentitySchema();
  await assertIdentityDisposition(id, 'delete');
  await psql(`DELETE FROM identity_users WHERE id = ${sql(id)}`);
}

/** Preflight before external credential mutations; database triggers also guard commit. */
export async function assertIdentityDisposition(id: string, action: 'disable' | 'delete'): Promise<void> {
  await ensureIdentitySchema();
  const owner = await queryRows(`SELECT owner_user_id FROM identity_appliance_claim WHERE owner_user_id = ${sql(id)}::uuid`);
  if (owner.length) throw new Error('Appliance owner and management recovery access must remain active');
  if (action === 'delete') {
    const owned = await queryRows(`SELECT installation_id FROM admission_policies
      WHERE owner_id = ${sql(id)}::uuid AND state <> 'deleted'
      UNION SELECT installation_id FROM admission_resources
      WHERE (owner_id = ${sql(id)}::uuid OR private_user_id = ${sql(id)}::uuid) AND state IN ('active','retained')`);
    if (owned.length) throw new Error('Transfer application administration and explicitly retain/quarantine or dispose of private data before deleting this user');
  }
}

export async function ensureClient(input: {
  clientId: string;
  clientSecret: string;
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
  backchannelLogoutUri?: string | null;
  scopes: string[];
}): Promise<IdentityClient> {
  await ensureIdentitySchema();
  const rows = await queryRows<IdentityClient>(`
    INSERT INTO identity_clients (client_id, client_secret, name, redirect_uris, post_logout_redirect_uris, backchannel_logout_uri, scopes)
    VALUES (${sql(input.clientId)}, ${sql(input.clientSecret)}, ${sql(input.name)}, ${sqlJson(input.redirectUris)}, ${sqlJson(input.postLogoutRedirectUris || [])}, ${sql(input.backchannelLogoutUri ?? null)}, ${sqlJson(input.scopes)})
    ON CONFLICT (client_id) DO UPDATE SET
      client_secret = EXCLUDED.client_secret,
      name = EXCLUDED.name,
      redirect_uris = EXCLUDED.redirect_uris,
      post_logout_redirect_uris = EXCLUDED.post_logout_redirect_uris,
      backchannel_logout_uri = ${sql(input.backchannelLogoutUri ?? null)},
      scopes = EXCLUDED.scopes,
      updated_at = now()
    RETURNING client_id, client_secret, name, redirect_uris, post_logout_redirect_uris, backchannel_logout_uri, scopes
  `);
  if (input.clientId === 'youeye-ui' || input.clientId === 'youeye-control') {
    await psql(`INSERT INTO admission_clients (client_id, platform_access)
      VALUES (${sql(input.clientId)}, true) ON CONFLICT (client_id) DO NOTHING`);
  }
  return rows[0];
}

export async function getClient(clientId: string): Promise<IdentityClient | null> {
  await ensureIdentitySchema();
  const rows = await queryRows<IdentityClient>(`
    SELECT client_id, client_secret, name, redirect_uris, post_logout_redirect_uris, backchannel_logout_uri, scopes
    FROM identity_clients
    WHERE client_id = ${sql(clientId)}
    LIMIT 1
  `);
  return rows[0] || null;
}

export async function removeClient(clientId: string): Promise<void> {
  await ensureIdentitySchema();
  await psql(`DELETE FROM identity_clients WHERE client_id = ${sql(clientId)}`);
}

export async function createAuthCode(input: {
  clientId: string;
  userId: string;
  redirectUri: string;
  scope: string;
  nonce?: string | null;
  codeChallenge?: string | null;
  sessionId?: string | null;
}): Promise<string> {
  await ensureIdentitySchema();
  const code = randomBytes(32).toString('hex');
  const issued = await queryCommandRows<{ code: string }>(`
    WITH issued AS (
      INSERT INTO identity_auth_codes (code, client_id, user_id, redirect_uri, scope, nonce, code_challenge, session_id, expires_at)
      SELECT ${sql(code)}, ${sql(input.clientId)}, ${sql(input.userId)}::uuid, ${sql(input.redirectUri)}, ${sql(input.scope)},
        ${sql(input.nonce ?? null)}, ${sql(input.codeChallenge ?? null)}, ${sql(input.sessionId ?? null)}::uuid, now() + interval '10 minutes'
      WHERE admission_client_granted(${sql(input.clientId)}, ${sql(input.userId)}::uuid)
        ${input.sessionId ? `AND EXISTS (SELECT 1 FROM identity_sessions
          WHERE id = ${sql(input.sessionId)}::uuid AND user_id = ${sql(input.userId)}::uuid
            AND revoked_at IS NULL AND idle_expires_at > now() AND expires_at > now() FOR SHARE)` : ''}
      RETURNING code, session_id, client_id, user_id
    ), participants AS (
      INSERT INTO identity_session_clients(session_id, client_id, user_id)
      SELECT session_id, client_id, user_id FROM issued WHERE session_id IS NOT NULL
      ON CONFLICT (session_id, client_id) DO NOTHING
    )
    SELECT COALESCE(json_agg(json_build_object('code',code)), '[]'::json)::text FROM issued
  `);
  if (!issued.length) throw new IdentityGrantInvalidated('Session or application admission changed during code issuance');
  return code;
}

export async function consumeAuthCode(code: string, clientId: string, redirectUri: string): Promise<AuthCode | null> {
  await ensureIdentitySchema();
  const rows = await identityStatementRows<AuthCode>(`
    eligible AS MATERIALIZED (
      SELECT code FROM identity_auth_codes
      WHERE code = ${sql(code)} AND client_id = ${sql(clientId)} AND redirect_uri = ${sql(redirectUri)}
        AND used_at IS NULL AND expires_at > now()
        AND admission_client_granted(${sql(clientId)}, user_id)
    ), consumed AS (
    UPDATE identity_auth_codes
    SET used_at = now()
    WHERE code = ${sql(code)}
      AND client_id = ${sql(clientId)}
      AND redirect_uri = ${sql(redirectUri)}
      AND code IN (SELECT code FROM eligible)
      AND used_at IS NULL
      AND expires_at > now()
    RETURNING code, client_id, user_id::text, redirect_uri, scope, nonce, code_challenge, session_id::text
    )`, 'SELECT * FROM consumed');
  return rows[0] || null;
}

const SESSION_IDLE_DAYS = 7;
const SESSION_MAX_DAYS = 30;

export async function createIdentitySession(userId: string): Promise<IdentitySession> {
  await ensureIdentitySchema();
  const rows = await queryRows<IdentitySession>(`
    INSERT INTO identity_sessions (user_id, idle_expires_at, expires_at)
    VALUES (${sql(userId)}, now() + interval '${SESSION_IDLE_DAYS} days', now() + interval '${SESSION_MAX_DAYS} days')
    RETURNING id::text, user_id::text, expires_at::text, idle_expires_at::text, revoked_at::text
  `);
  return rows[0];
}

export async function getIdentitySessionById(sessionId: string, touch = false): Promise<IdentitySession | null> {
  await ensureIdentitySchema();
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const rows = await queryRows<IdentitySession>(`
    ${touch ? `UPDATE identity_sessions
    SET last_seen_at = now(), idle_expires_at = LEAST(expires_at, now() + interval '${SESSION_IDLE_DAYS} days')
    WHERE id = ${sql(sessionId)}::uuid AND revoked_at IS NULL AND idle_expires_at > now() AND expires_at > now()
    RETURNING id::text, user_id::text, expires_at::text, idle_expires_at::text, revoked_at::text` :
    `SELECT id::text, user_id::text, expires_at::text, idle_expires_at::text, revoked_at::text
    FROM identity_sessions WHERE id = ${sql(sessionId)}::uuid AND revoked_at IS NULL AND idle_expires_at > now() AND expires_at > now()`}
  `);
  return rows[0] || null;
}

export async function revokeIdentitySession(sessionId: string): Promise<void> {
  await ensureIdentitySchema();
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return;
  await psql(`UPDATE identity_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE id = ${sql(sessionId)}::uuid`);
}

export async function listSessionLogoutClients(sessionId: string): Promise<Array<{ client_id: string; uri: string; user_id: string }>> {
  await ensureIdentitySchema();
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return [];
  return queryRows<{ client_id: string; uri: string; user_id: string }>(`
    SELECT DISTINCT participants.client_id, c.backchannel_logout_uri AS uri, participants.user_id::text
    FROM (
      SELECT client_id, user_id FROM identity_session_clients WHERE session_id = ${sql(sessionId)}::uuid
      UNION
      SELECT client_id, user_id FROM identity_refresh_tokens WHERE session_id = ${sql(sessionId)}::uuid
    ) participants JOIN identity_clients c ON c.client_id = participants.client_id
    WHERE c.backchannel_logout_uri IS NOT NULL
  `);
}

export async function listUserLogoutSessions(userId: string): Promise<Array<{ id: string }>> {
  await ensureIdentitySchema();
  return queryRows<{ id: string }>(`
    SELECT id::text FROM identity_sessions
    WHERE user_id = ${sql(userId)}::uuid AND revoked_at IS NULL
  `);
}

export async function enqueueLogoutDelivery(input: { sessionId: string; clientId: string; uri: string; token: string; eventKey?: string }): Promise<void> {
  await ensureIdentitySchema();
  const eventKey = input.eventKey ?? `session:${input.sessionId}:${input.clientId}`;
  await psql(`INSERT INTO identity_logout_deliveries(session_id, client_id, uri, logout_token, event_key)
    VALUES (${sql(input.sessionId)}::uuid, ${sql(input.clientId)}, ${sql(input.uri)}, ${sql(input.token)}, ${sql(eventKey)})
    ON CONFLICT (event_key) DO NOTHING`);
}

export async function getDueLogoutDeliveries(): Promise<LogoutDelivery[]> {
  await ensureIdentitySchema();
  return queryRows<LogoutDelivery>(`
    SELECT id::text, client_id, uri, logout_token, attempts, session_id::text FROM identity_logout_deliveries
    WHERE delivered_at IS NULL AND next_attempt_at <= now() AND attempts < 10
      AND session_id IS NOT NULL
      AND created_at > now() - interval '23 hours'
    ORDER BY next_attempt_at, created_at LIMIT 20
  `);
}

export async function finishLogoutDelivery(id: string, delivered: boolean): Promise<void> {
  await ensureIdentitySchema();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return;
  await psql(`UPDATE identity_logout_deliveries
    SET attempts = attempts + 1,
      delivered_at = CASE WHEN ${sql(delivered)} THEN now() ELSE delivered_at END,
      next_attempt_at = CASE WHEN ${sql(delivered)} THEN next_attempt_at
        ELSE now() + (LEAST(3600, power(2, LEAST(attempts + 1, 10))::int * 10) * interval '1 second') END
    WHERE id = ${sql(id)}::uuid AND delivered_at IS NULL`);
}

export async function revokeAllIdentitySessions(userId: string): Promise<number> {
  await ensureIdentitySchema();
  const rows = await queryCommandRows<{ count: number }>(`
    WITH cutoff AS (
      INSERT INTO identity_revoked_before (user_id, revoked_before)
      VALUES (${sql(userId)}::uuid, now())
      ON CONFLICT (user_id) DO UPDATE SET revoked_before = EXCLUDED.revoked_before
      RETURNING user_id
    ), revoked AS (
      UPDATE identity_sessions SET revoked_at = now()
      WHERE user_id IN (SELECT user_id FROM cutoff) AND revoked_at IS NULL
      RETURNING id
    ) SELECT json_build_array(json_build_object('count', count(*)::int))::text FROM revoked
  `);
  return rows[0]?.count || 0;
}

export async function isUserTokenInvalidated(userId: string, issuedAt: number): Promise<boolean> {
  await ensureIdentitySchema();
  const rows = await queryRows<{ revoked_before: string }>(`
    SELECT revoked_before::text FROM identity_revoked_before WHERE user_id = ${sql(userId)}::uuid
  `);
  return rows.length > 0 && issuedAt * 1000 <= Date.parse(rows[0].revoked_before);
}

export async function isIdentitySessionActiveForUser(sessionId: string, userId: string): Promise<boolean> {
  const session = await getIdentitySessionById(sessionId);
  return session?.user_id === userId;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class IdentityGrantInvalidated extends Error {}
export async function issueRefreshToken(input: {
  clientId: string;
  userId: string;
  sessionId: string;
  scope: string;
  familyId?: string;
  authorizedAt?: number;
}): Promise<string> {
  await ensureIdentitySchema();
  const token = randomBytes(32).toString('base64url');
  const familyId = input.familyId || randomUUID();
  await psql(`
    INSERT INTO identity_refresh_families (id) VALUES (${sql(familyId)}::uuid)
      ON CONFLICT (id) DO NOTHING
  `);
  const inserted = await queryRows<{ token_hash: string }>(`
    INSERT INTO identity_refresh_tokens (token_hash, family_id, session_id, client_id, user_id, scope, expires_at)
    SELECT ${sql(tokenHash(token))}, ${sql(familyId)}::uuid, s.id, ${sql(input.clientId)}, s.user_id, ${sql(input.scope)}, s.expires_at
    FROM identity_sessions s JOIN identity_refresh_families f ON f.id = ${sql(familyId)}::uuid
    WHERE s.id = ${sql(input.sessionId)}::uuid AND s.user_id = ${sql(input.userId)}::uuid
      AND s.revoked_at IS NULL AND s.idle_expires_at > now() AND s.expires_at > now()
      AND f.revoked_at IS NULL
      AND admission_client_granted(${sql(input.clientId)}, s.user_id)
      AND NOT EXISTS (SELECT 1 FROM admission_client_cutoffs c
        WHERE c.client_id = ${sql(input.clientId)} AND c.user_id = s.user_id
          AND c.revoked_before >= to_timestamp(${sql(input.authorizedAt ?? Math.floor(Date.now() / 1000))}))
    RETURNING token_hash
  `);
  if (!inserted.length) throw new IdentityGrantInvalidated('Session or application admission changed during grant issuance');
  return token;
}

export async function rotateRefreshToken(token: string, clientId: string): Promise<{
  userId: string; sessionId: string; scope: string; token: string;
} | null> {
  await ensureIdentitySchema();
  if (!token) return null;
  const replacement = randomBytes(32).toString('base64url');
  const rows = await queryRows<{ user_id: string; session_id: string; scope: string }>(`
    SELECT * FROM identity_rotate_refresh(${sql(tokenHash(token))}, ${sql(clientId)}, ${sql(tokenHash(replacement))})
  `);
  const row = rows[0];
  if (!row || !(await getIdentitySessionById(row.session_id))) return null;
  return { userId: row.user_id, sessionId: row.session_id, scope: row.scope, token: replacement };
}

export async function revokeRefreshToken(token: string, clientId: string): Promise<void> {
  await ensureIdentitySchema();
  if (!token) return;
  await psql(`UPDATE identity_refresh_families SET revoked_at = COALESCE(revoked_at, now())
    WHERE id IN (SELECT family_id FROM identity_refresh_tokens
    WHERE token_hash = ${sql(tokenHash(token))} AND client_id = ${sql(clientId)})`);
}

export async function revokeAccessToken(tokenId: string, expiresAt: number): Promise<void> {
  await ensureIdentitySchema();
  if (!/^[0-9a-f-]{36}$/i.test(tokenId)) return;
  await psql(`INSERT INTO identity_revoked_access_tokens (token_id, expires_at)
    VALUES (${sql(tokenId)}::uuid, to_timestamp(${sql(expiresAt)})) ON CONFLICT (token_id) DO NOTHING`);
}

export async function isAccessTokenRevoked(tokenId: string): Promise<boolean> {
  await ensureIdentitySchema();
  if (!/^[0-9a-f-]{36}$/i.test(tokenId)) return true;
  const rows = await queryRows<{ token_id: string }>(`
    SELECT token_id::text FROM identity_revoked_access_tokens WHERE token_id = ${sql(tokenId)}::uuid AND expires_at > now()
  `);
  return rows.length > 0;
}

export async function getAppConsent(userId: string, clientId: string): Promise<IdentityAppConsent | null> {
  await ensureIdentitySchema();
  const rows = await queryRows<IdentityAppConsent>(`
    SELECT user_id::text, client_id, scopes, granted_at::text, updated_at::text
    FROM identity_app_consents
    WHERE user_id = ${sql(userId)}
      AND client_id = ${sql(clientId)}
    LIMIT 1
  `);
  return rows[0] || null;
}

export async function upsertAppConsent(input: {
  userId: string;
  clientId: string;
  scopes: string[];
}): Promise<IdentityAppConsent> {
  await ensureIdentitySchema();
  const scopes = Array.from(new Set(input.scopes.filter(Boolean)));
  const rows = await queryRows<IdentityAppConsent>(`
    INSERT INTO identity_app_consents (user_id, client_id, scopes)
    VALUES (${sql(input.userId)}, ${sql(input.clientId)}, ${sqlJson(scopes)})
    ON CONFLICT (user_id, client_id) DO UPDATE SET
      scopes = EXCLUDED.scopes,
      updated_at = now()
    RETURNING user_id::text, client_id, scopes, granted_at::text, updated_at::text
  `);
  return rows[0];
}

export async function revokeAppConsent(userId: string, clientId: string): Promise<void> {
  await ensureIdentitySchema();
  await psql(`
    DELETE FROM identity_app_consents
    WHERE user_id = ${sql(userId)}
      AND client_id = ${sql(clientId)}
  `);
}

export async function getSigningSecret(): Promise<string> {
  await ensureIdentitySchema();
  const existing = await queryRows<{ secret: string }>(`
    SELECT secret FROM identity_secrets WHERE purpose = 'jwt' LIMIT 1
  `);
  if (existing[0]?.secret) return existing[0].secret;
  const secret = randomBytes(48).toString('hex');
  await psql(`
    INSERT INTO identity_secrets (purpose, secret)
    VALUES ('jwt', ${sql(secret)})
    ON CONFLICT (purpose) DO NOTHING
  `);
  return secret;
}

export async function getIdentitySecret(purpose: string): Promise<string | null> {
  await ensureIdentitySchema();
  const existing = await queryRows<{ secret: string }>(`
    SELECT secret FROM identity_secrets WHERE purpose = ${sql(purpose)} LIMIT 1
  `);
  return existing[0]?.secret || null;
}

/** A public authority migration cannot reuse authorization state from the old issuer.
 * Managed clients keep their logical issuer and refresh/session behavior.
 * Users, subjects, consent, signing keys and client registrations are retained.
 */
export async function invalidatePublicOidcState(): Promise<void> {
  await ensureIdentitySchema();
  await psql(`BEGIN;
    UPDATE identity_auth_codes SET used_at = COALESCE(used_at, now())
      WHERE NOT starts_with(client_id, 'youeye-app-');
    UPDATE identity_refresh_tokens SET revoked_at = COALESCE(revoked_at, now())
      WHERE NOT starts_with(client_id, 'youeye-app-');
    COMMIT;`);
}

export async function setIdentitySecretIfAbsent(purpose: string, secret: string): Promise<string> {
  await ensureIdentitySchema();
  await psql(`INSERT INTO identity_secrets (purpose, secret) VALUES (${sql(purpose)}, ${sql(secret)}) ON CONFLICT (purpose) DO NOTHING`);
  const persisted = await getIdentitySecret(purpose);
  if (!persisted) throw new Error('Could not persist the YouEye ID signing key');
  return persisted;
}

export async function getOAuthSigningKeySnapshot(): Promise<{ active: string; retired: string[] }> {
  await ensureIdentitySchema();
  const rows = await queryRows<{ purpose: string; secret: string }>(`
    SELECT purpose, secret FROM identity_secrets
    WHERE purpose = 'oauth-rs256-private-key'
       OR (purpose LIKE 'oauth-rs256-retired:%' AND created_at > now() - interval '48 hours')
  `);
  const active = rows.find(row => row.purpose === 'oauth-rs256-private-key')?.secret;
  if (!active) throw new Error('YouEye ID signing key is not initialized');
  return { active, retired: rows.filter(row => row.purpose !== 'oauth-rs256-private-key').map(row => row.secret) };
}

export async function rotateOAuthSigningKey(oldPem: string, newPem: string, oldKid: string): Promise<boolean> {
  await ensureIdentitySchema();
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(oldKid)) throw new Error('Invalid signing key identifier');
  // A single statement archives the old key before switching the active row.
  // The row lock and old-key comparison make concurrent stale rotations fail.
  const result = await queryCommandRows<{ changed: boolean }>(`
    WITH previous AS MATERIALIZED (
      SELECT secret FROM identity_secrets
      WHERE purpose = 'oauth-rs256-private-key' AND secret = ${sql(oldPem)} FOR UPDATE
    ), archived AS (
      INSERT INTO identity_secrets (purpose, secret)
      SELECT ${sql(`oauth-rs256-retired:${oldKid}`)}, secret FROM previous
      ON CONFLICT (purpose) DO NOTHING RETURNING purpose
    ), changed AS (
      UPDATE identity_secrets SET secret = ${sql(newPem)}, created_at = now()
      WHERE purpose = 'oauth-rs256-private-key' AND secret = ${sql(oldPem)}
        AND EXISTS (SELECT 1 FROM archived)
      RETURNING purpose
    )
    SELECT json_build_array(json_build_object('changed', EXISTS (SELECT 1 FROM changed)))::text
  `);
  return result[0]?.changed === true;
}


// Membership and active identity change the authority of every app whose
// current policy evaluates the principal. Retain all app gates through SQL.
export async function withIdentityAppLifecycle<T>(work: () => Promise<T>): Promise<T> {
  await ensureIdentitySchema();
  const apps = await queryRows<{app_id: string}>(`SELECT app_id FROM admission_policies WHERE state <> 'deleted' ORDER BY app_id`);
  const { withAppLifecycles } = await import('../market/update-admission');
  return withAppLifecycles(['identity', ...apps.map(app => app.app_id)], work);
}
