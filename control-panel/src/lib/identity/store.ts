import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { execShell } from '@/lib/incus/server';
import { POSTGRES_MANIFEST } from '@/lib/apps/manifest';
import { requireIdentityPassword } from './password-policy';

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

async function psql(command: string): Promise<string> {
  const escaped = command
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/'/g, "'\\''");
  const { exitCode, stdout, stderr } = await execShell(
    CONTAINER,
    `su - postgres -c "psql -U youeye -d youeye -tA -c '${escaped}'"`,
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

export async function ensureIdentitySchema(): Promise<void> {
  await psql(`
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
      scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS identity_auth_codes (
      code text PRIMARY KEY,
      client_id text NOT NULL REFERENCES identity_clients(client_id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
      redirect_uri text NOT NULL,
      scope text NOT NULL,
      nonce text,
      expires_at timestamptz NOT NULL,
      used_at timestamptz
    );
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

export async function updateIdentityUser(id: string, patch: {
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

export async function deleteIdentityUser(id: string): Promise<void> {
  await ensureIdentitySchema();
  await psql(`DELETE FROM identity_users WHERE id = ${sql(id)}`);
}

export async function ensureClient(input: {
  clientId: string;
  clientSecret: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
}): Promise<IdentityClient> {
  await ensureIdentitySchema();
  const rows = await queryRows<IdentityClient>(`
    INSERT INTO identity_clients (client_id, client_secret, name, redirect_uris, scopes)
    VALUES (${sql(input.clientId)}, ${sql(input.clientSecret)}, ${sql(input.name)}, ${sqlJson(input.redirectUris)}, ${sqlJson(input.scopes)})
    ON CONFLICT (client_id) DO UPDATE SET
      client_secret = EXCLUDED.client_secret,
      name = EXCLUDED.name,
      redirect_uris = EXCLUDED.redirect_uris,
      scopes = EXCLUDED.scopes,
      updated_at = now()
    RETURNING client_id, client_secret, name, redirect_uris, scopes
  `);
  return rows[0];
}

export async function getClient(clientId: string): Promise<IdentityClient | null> {
  await ensureIdentitySchema();
  const rows = await queryRows<IdentityClient>(`
    SELECT client_id, client_secret, name, redirect_uris, scopes
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
}): Promise<string> {
  await ensureIdentitySchema();
  const code = randomBytes(32).toString('hex');
  await psql(`
    INSERT INTO identity_auth_codes (code, client_id, user_id, redirect_uri, scope, nonce, expires_at)
    VALUES (${sql(code)}, ${sql(input.clientId)}, ${sql(input.userId)}, ${sql(input.redirectUri)}, ${sql(input.scope)}, ${sql(input.nonce ?? null)}, now() + interval '10 minutes')
  `);
  return code;
}

export async function consumeAuthCode(code: string, clientId: string, redirectUri: string): Promise<AuthCode | null> {
  await ensureIdentitySchema();
  const rows = await queryRows<AuthCode>(`
    UPDATE identity_auth_codes
    SET used_at = now()
    WHERE code = ${sql(code)}
      AND client_id = ${sql(clientId)}
      AND redirect_uri = ${sql(redirectUri)}
      AND used_at IS NULL
      AND expires_at > now()
    RETURNING code, client_id, user_id::text, redirect_uri, scope, nonce
  `);
  return rows[0] || null;
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

export async function setIdentitySecret(purpose: string, secret: string): Promise<void> {
  await ensureIdentitySchema();
  await psql(`
    INSERT INTO identity_secrets (purpose, secret)
    VALUES (${sql(purpose)}, ${sql(secret)})
    ON CONFLICT (purpose) DO UPDATE SET secret = EXCLUDED.secret
  `);
}
