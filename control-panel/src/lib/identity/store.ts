import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { execShell } from '@/lib/incus/server';
import { POSTGRES_MANIFEST } from '@/lib/apps/manifest';

const CONTAINER = POSTGRES_MANIFEST.containerName;

export interface IdentityUser {
  id: string;
  username: string;
  name: string;
  email: string;
  groups: string[];
  is_admin: boolean;
}

export interface IdentityClient {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
  scopes: string[];
}

export interface AuthCode {
  code: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scope: string;
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

export async function ensureIdentitySchema(): Promise<void> {
  await psql(`
    CREATE TABLE IF NOT EXISTS identity_users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      username text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      name text NOT NULL DEFAULT '',
      email text NOT NULL DEFAULT '',
      groups jsonb NOT NULL DEFAULT '[]'::jsonb,
      is_admin boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
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
      expires_at timestamptz NOT NULL,
      used_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS identity_secrets (
      purpose text PRIMARY KEY,
      secret text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export function hashPassword(password: string): string {
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
  const passwordHash = hashPassword(input.password);
  const rows = await queryRows<IdentityUser>(`
    INSERT INTO identity_users (username, password_hash, name, email, groups, is_admin)
    VALUES (${sql(input.username)}, ${sql(passwordHash)}, ${sql(input.name)}, ${sql(input.email)}, ${sqlJson(input.groups)}, ${sql(input.isAdmin)})
    ON CONFLICT (username) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      name = EXCLUDED.name,
      email = EXCLUDED.email,
      groups = EXCLUDED.groups,
      is_admin = EXCLUDED.is_admin,
      updated_at = now()
    RETURNING id::text, username, name, email, groups, is_admin
  `);
  return rows[0];
}

export async function verifyUser(username: string, password: string): Promise<IdentityUser | null> {
  await ensureIdentitySchema();
  const rows = await queryRows<IdentityUser & { password_hash: string }>(`
    SELECT id::text, username, password_hash, name, email, groups, is_admin
    FROM identity_users
    WHERE username = ${sql(username)}
    LIMIT 1
  `);
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  const safeUser: IdentityUser = {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    groups: user.groups,
    is_admin: user.is_admin,
  };
  return safeUser;
}

export async function getUserById(id: string): Promise<IdentityUser | null> {
  await ensureIdentitySchema();
  const rows = await queryRows<IdentityUser>(`
    SELECT id::text, username, name, email, groups, is_admin
    FROM identity_users
    WHERE id = ${sql(id)}
    LIMIT 1
  `);
  return rows[0] || null;
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

export async function createAuthCode(input: {
  clientId: string;
  userId: string;
  redirectUri: string;
  scope: string;
}): Promise<string> {
  await ensureIdentitySchema();
  const code = randomBytes(32).toString('hex');
  await psql(`
    INSERT INTO identity_auth_codes (code, client_id, user_id, redirect_uri, scope, expires_at)
    VALUES (${sql(code)}, ${sql(input.clientId)}, ${sql(input.userId)}, ${sql(input.redirectUri)}, ${sql(input.scope)}, now() + interval '10 minutes')
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
    RETURNING code, client_id, user_id::text, redirect_uri, scope
  `);
  return rows[0] || null;
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
