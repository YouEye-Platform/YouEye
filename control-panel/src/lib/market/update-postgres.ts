import { createHash, randomUUID } from 'node:crypto';
import type { UpdateInventoryObservations } from './update-inventory';

const FORBIDDEN = new Set(['postgres', 'template0', 'template1', 'youeye', 'youeye_ui', 'pointer']);
const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;

export class AppUpdatePostgresError extends Error {
  constructor(readonly code: string) {
    // Never propagate exec errors, SQL, connection strings, or dump contents.
    super(`App PostgreSQL checkpoint: ${code}`);
    this.name = 'AppUpdatePostgresError';
  }
}
function fail(code: string): never { throw new AppUpdatePostgresError(code); }

function securityScript(bytes: Buffer): Buffer {
  // Earlier v1 receipts captured psql's SET command tag before the SELECT
  // result. Preserve the verified receipt/digest and reconcile only this exact
  // generated prefix when applying it. Never strip arbitrary SQL or tags.
  if (bytes.subarray(0, 4).toString() !== 'SET\n') return bytes;
  if (!bytes.subarray(4).toString().startsWith('BEGIN; SET LOCAL search_path=pg_catalog;\n')) {
    fail('security-checkpoint-invalid');
  }
  return bytes.subarray(4);
}

export interface AppUpdatePostgresScope {
  appId: string;
  engine: string;
  mode: 'shared' | 'own';
  database: string;
  ownerRole: string;
  adminRole: string;
  /** Every trusted LOGIN superuser, including a bootstrap postgres role if enabled. */
  adminRoles: string[];
  maxDumpBytes: number;
  /** Required for every transaction method; omitted only for read-only preflight. */
  operationId?: string;
}

/**
 * The parent reads these under durable lifecycle/security exclusion, from actual
 * installed credential uses and runtime/ingress state, NOT manifest claims.
 * Include all uses of the owner credentials, even stopped jobs and other apps.
 * Engine remains Running, including for mode=own; never snapshot its raw PG data.
 */
export interface AppUpdatePostgresRuntime {
  lifecycleExcluded: boolean;
  ingressBlocked: boolean;
  securityRevision: string;
  engine: { name: string; state: 'Running' | 'Stopped'; ownerAppId?: string };
  credentialUses: Array<{
    engine: string; database: string; role: string; appId: string;
    container: string; state: 'Running' | 'Stopped'; clientAddresses: string[];
  }>;
}

export interface AppUpdatePostgresIO {
  exec(container: string, command: string[], options: { timeout: number }):
    Promise<{ exitCode: number; stdout: string; stderr: string }>;
  upload(container: string, path: string, bytes: Buffer, options: { mode: string; timeout: number }): Promise<void>;
  download(container: string, path: string): Promise<Buffer>;
  runtime(): Promise<AppUpdatePostgresRuntime>;
  /** Durably reserve/record this exact remote directory BEFORE mkdir. Idempotent. */
  persistStaging?(receipt: AppUpdatePostgresStaging): Promise<void>;
}

export interface AppUpdatePostgresStaging {
  schema: 'youeye.app-postgres-staging.v1';
  operationId: string; appId: string; engine: string; database: string; ownerRole: string;
  directory: string; initializationDirectory: string; reservedBytes: number;
}
export function appUpdatePostgresStagingBytes(maxDumpBytes: number): number {
  if (!Number.isSafeInteger(maxDumpBytes) || maxDumpBytes < 1024 || maxDumpBytes > 1024 ** 3) fail('invalid-dump-bound');
  return 2 * maxDumpBytes + 128 * 1024;
}

type Grant = { role: string; privilege: string; grantable: boolean; grantor: string };
interface Catalog {
  database: string; ownerRole: string; allowConnections: boolean; connectionLimit: number;
  version: number; encoding: string; collate: string; ctype: string;
  acl: Grant[];
  admin: boolean; unsafeOwner: boolean; sharedOwner: boolean;
  foreignOwners: string[]; foreignWriters: string[]; superusers: string[];
  sessions: Array<{ role: string; address: string | null; backend: string }>;
  unsupported: boolean;
}

/** Payload-free receipt. Persist before changing the fence; retain until unfenced. */
export interface AppUpdatePostgresFence {
  schema: 'youeye.app-postgres-fence.v1';
  engine: string; database: string; ownerRole: string;
  securityRevision: string;
  originalAllowConnections: boolean;
  originalConnectionLimit: number;
  originalAcl: Grant[];
  operationId?: string;
}
export interface AppUpdatePostgresCheckpoint {
  schema: 'youeye.app-postgres-checkpoint.v1';
  engine: string; database: string; ownerRole: string;
  serverVersion: number; byteSize: number; sha256: string;
  /** Sensitive! Parent must immediately encrypt/store in its protected workspace. */
  bytes: Buffer;
}
/**
 * Capture at rollback time, persist encrypted BEFORE DROP DATABASE. Retry must
 * supply this same snapshot, not recapture grants from a partial replacement.
 * Contains no role credentials. Never put bytes or database settings in a journal.
 */
export interface AppUpdatePostgresSecurity {
  schema: 'youeye.app-postgres-security.v1';
  engine: string; database: string; ownerRole: string; securityRevision: string;
  encoding: string; collate: string; ctype: string; version: number; acl: Grant[];
  bytes: Buffer; sha256: string;
}

/** Default Incus adapter; runtime evidence must come from the parent inventory. */
export function incusAppUpdatePostgresIO(
  runtime: AppUpdatePostgresIO['runtime'],
  persistStaging?: AppUpdatePostgresIO['persistStaging'],
): AppUpdatePostgresIO {
  return {
    runtime, persistStaging,
    exec: async (...args) => (await import('../incus/server')).execCommand(...args),
    upload: async (...args) => (await import('../incus/server')).incusUploadFile(...args),
    download: async (...args) => (await import('../incus/server')).incusDownloadFile(...args),
  };
}

/** Secret-free observations shared with actual PostgreSQL acceptance. */
export function appUpdatePostgresCatalogQuery(scope: Pick<AppUpdatePostgresScope, 'database' | 'ownerRole'>): string {
  // Ordinary trigger routines execute with the caller's privileges. A foreign
  // caller still needs table DML privileges, checked above. SECURITY DEFINER
  // triggers remain potential writers, including when attached to a temp table.
  return `
WITH d AS (SELECT * FROM pg_database WHERE datname=${literal(scope.database)}),
 o AS (SELECT * FROM pg_roles WHERE rolname=${literal(scope.ownerRole)}),
 objects AS (
   SELECT n.nspowner AS owner FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
   UNION ALL SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
   UNION ALL SELECT p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
   UNION ALL SELECT t.typowner FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
     WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
 ),
 writers AS (
   SELECT r.rolname FROM pg_roles r WHERE r.rolcanlogin AND NOT r.rolsuper AND (
     EXISTS(SELECT 1 FROM pg_roles a WHERE a.rolsuper AND pg_has_role(r.oid,a.oid,'MEMBER')) OR
     has_database_privilege(r.oid,(SELECT oid FROM d),'CREATE') OR
     EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
       AND has_schema_privilege(r.oid,n.oid,'CREATE')) OR
     EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND
       ((c.relkind IN ('r','p','v','m','f') AND (has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
          OR has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE')))
       OR (c.relkind='S' AND has_sequence_privilege(r.oid,c.oid,'USAGE,UPDATE')))) OR
     EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
       AND (p.prosecdef OR p.prorettype <> 'pg_catalog.trigger'::regtype)
       AND has_function_privilege(r.oid,p.oid,'EXECUTE')))
 )
SELECT json_build_object(
 'database',d.datname,'ownerRole',pg_get_userbyid(d.datdba),
 'allowConnections',d.datallowconn,'connectionLimit',d.datconnlimit,
 'version',current_setting('server_version_num')::int,
 'encoding',pg_encoding_to_char(d.encoding),'collate',d.datcollate,'ctype',d.datctype,
 'acl',COALESCE((SELECT json_agg(json_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
   'privilege',a.privilege_type,'grantable',a.is_grantable,'grantor',pg_get_userbyid(a.grantor)))
   FROM aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a),'[]'::json),
 'admin',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),
 'unsafeOwner',NOT o.rolcanlogin OR o.rolsuper OR o.rolcreatedb OR o.rolcreaterole OR o.rolreplication OR o.rolbypassrls
   OR EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=o.oid OR member=o.oid),
 'sharedOwner',EXISTS(SELECT 1 FROM pg_shdepend s WHERE s.refclassid='pg_authid'::regclass AND s.refobjid=o.oid
   AND ((s.dbid<>0 AND s.dbid<>d.oid) OR (s.dbid=0 AND NOT (s.classid='pg_database'::regclass AND s.objid=d.oid)))),
 'foreignOwners',COALESCE((SELECT json_agg(DISTINCT pg_get_userbyid(owner)) FROM (
   SELECT owner FROM objects UNION ALL SELECT s.refobjid AS owner FROM pg_shdepend s
   WHERE s.dbid=d.oid AND s.refclassid='pg_authid'::regclass AND s.deptype='o') ownership
   WHERE owner NOT IN (o.oid,(SELECT oid FROM pg_roles WHERE rolname='pg_database_owner'))),'[]'::json),
 'foreignWriters',COALESCE((SELECT json_agg(rolname) FROM writers WHERE rolname<>o.rolname),'[]'::json),
 'superusers',COALESCE((SELECT json_agg(rolname) FROM pg_roles WHERE rolsuper AND rolcanlogin),'[]'::json),
 'sessions',COALESCE((SELECT json_agg(json_build_object('role',usename,'address',host(client_addr),'backend',backend_type))
   FROM pg_stat_activity WHERE datname=d.datname AND pid<>pg_backend_pid()),'[]'::json),
 'unsupported',d.datistemplate OR d.datlocprovider<>'c' OR d.dattablespace<>(SELECT oid FROM pg_tablespace WHERE spcname='pg_default')
   OR EXISTS(SELECT 1 FROM pg_extension WHERE extname<>'plpgsql')
   OR EXISTS(SELECT 1 FROM pg_class WHERE relkind='f')
   OR EXISTS(SELECT 1 FROM pg_subscription) OR EXISTS(SELECT 1 FROM pg_policy)
   OR EXISTS(SELECT 1 FROM pg_largeobject_metadata)
   OR EXISTS(SELECT 1 FROM pg_event_trigger)
   OR EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
     WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
       AND t.typacl IS NOT NULL AND (t.typrelid<>0 OR t.typelem<>0))
) FROM d CROSS JOIN o;`;
}

/**
 * Finite provider: one dedicated database, one nonprivileged owner login,
 * no memberships, foreign durable writers, foreign object owners, extension
 * objects, foreign tables, subscriptions, custom tablespaces or non-libc locales.
 * Parent owns locks, stop/start, checkpoint encryption, journal intent/result,
 * ingress, and restart reconciliation. No provider method starts a runtime.
 */
export function createAppUpdatePostgresProvider(scopeInput: AppUpdatePostgresScope, io: AppUpdatePostgresIO) {
  const scope = structuredClone(scopeInput);
  for (const s of [scope.database, scope.ownerRole, scope.adminRole, ...scope.adminRoles]) {
    if (!identifier.test(s)) fail('unsafe-identifier');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(scope.engine)
    || !/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(scope.appId)) fail('unsafe-identity');
  if (FORBIDDEN.has(scope.database) || FORBIDDEN.has(scope.ownerRole)
    || scope.ownerRole === scope.adminRole || scope.adminRoles.includes(scope.ownerRole)) fail('platform-resource-excluded');
  if ((scope.mode === 'shared') !== (scope.engine === 'youeye-postgres')
    || (scope.mode === 'shared' && scope.adminRole !== 'youeye')
    || !scope.adminRoles.includes(scope.adminRole)
    || new Set(scope.adminRoles).size !== scope.adminRoles.length) fail('invalid-engine-scope');
  if (!Number.isSafeInteger(scope.maxDumpBytes) || scope.maxDumpBytes < 1024
    || scope.maxDumpBytes > 1024 ** 3) fail('invalid-dump-bound');
  if (scope.operationId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scope.operationId)) {
    fail('invalid-operation-id');
  }
  const db = quote(scope.database);
  const owner = quote(scope.ownerRole);
  const allowed = new Set([scope.ownerRole, ...scope.adminRoles]);
  const maintenance = ['psql', '--no-psqlrc', '--quiet', '--no-password', '--username', scope.adminRole,
    '--dbname', 'postgres', '--set', 'ON_ERROR_STOP=1', '--tuples-only', '--no-align'];

  async function exec(command: string[], timeout = 30_000) {
    try {
      const result = await io.exec(scope.engine, command, { timeout });
      if (result.exitCode !== 0) fail('execution-failed');
      return result.stdout;
    } catch { return fail('execution-failed'); }
  }

  const observationKey = createHash('sha256').update(JSON.stringify(
    [scope.appId, scope.engine, scope.database, scope.ownerRole],
  )).digest('hex');
  // Read-only preflight uses one fixed, non-payload scratch directory per
  // resource. Transaction payloads always require the journal's operation ID.
  const stagingRoot = scope.operationId
    ? `/tmp/youeye-app-pg-${scope.operationId.toLowerCase()}`
    : `/tmp/youeye-app-pg-observe-${observationKey}`;
  const stagingReceipt: AppUpdatePostgresStaging = {
    schema: 'youeye.app-postgres-staging.v1', operationId: scope.operationId ?? '',
    appId: scope.appId, engine: scope.engine, database: scope.database, ownerRole: scope.ownerRole,
    directory: stagingRoot,
    // Full scope binding separates this metadata-only initializer from arbitrary
    // unmarked final directories, including another resource using the same ID.
    initializationDirectory: `${stagingRoot}.init-${observationKey}`,
    reservedBytes: appUpdatePostgresStagingBytes(scope.maxDumpBytes),
  };
  const initializationRoot = stagingReceipt.initializationDirectory;
  const markerBytes = Buffer.from(JSON.stringify(stagingReceipt));
  const lockPath = `${stagingRoot}/exec.lock`;
  let stagingReady = false;
  let workspaceDepth = 0;
  function requireOperation() {
    if (!scope.operationId || !io.persistStaging) fail('operation-staging-receipt-required');
  }
  async function probeStat(path: string): Promise<string | undefined> {
    try {
      const result = await io.exec(scope.engine, ['stat', '-c', '%f:%u:%a', path], { timeout: 10_000 });
      if (result.exitCode === 1 && !result.stdout) return undefined;
      if (result.exitCode !== 0) fail('staging-observation-failed');
      return result.stdout.trim();
    } catch { return fail('staging-observation-failed'); }
  }
  function ownedMode(stat: string, type: number, mode: string) {
    const parts = stat.split(':');
    return parts.length === 3 && (parseInt(parts[0], 16) & 0xf000) === type && parts[1] === '0' && parts[2] === mode;
  }
  async function validateStaging(directory = stagingRoot): Promise<boolean> {
    const root = await probeStat(directory);
    if (root === undefined) return false;
    if (!ownedMode(root, 0x4000, '700')) fail('staging-ownership-unproven');
    const marker = await probeStat(`${directory}/owner.json`);
    if (!marker || !ownedMode(marker, 0x8000, '600')) fail('staging-ownership-unproven');
    const size = Number(await exec(['stat', '-c', '%s', `${directory}/owner.json`]));
    if (size !== markerBytes.length) fail('staging-ownership-unproven');
    let actual: Buffer;
    try { actual = await io.download(scope.engine, `${directory}/owner.json`); }
    catch { return fail('staging-ownership-unproven'); }
    if (!actual.equals(markerBytes)) fail('staging-ownership-unproven');
    return true;
  }
  async function persistStagingReceipt() {
    if (!scope.operationId) return;
    requireOperation();
    try { await io.persistStaging!(structuredClone(stagingReceipt)); }
    catch { fail('staging-persistence-failed'); }
  }
  /**
   * This exact receipt-recorded initializer is NEVER used for payloads. Recover
   * only an empty root-owned 0700 directory or its bounded expected marker
   * prefix. Refuse every other entry/content; never recursively delete it.
   * An arbitrary unmarked FINAL directory still fails validateStaging().
   */
  async function cleanupInitialization() {
    const root = await probeStat(initializationRoot);
    if (root === undefined) return;
    if (!ownedMode(root, 0x4000, '700')) fail('staging-initialization-unproven');
    const unexpected = await exec(['find', initializationRoot, '-mindepth', '1', '-maxdepth', '1',
      '!', '-name', 'owner.json', '-print', '-quit']);
    if (unexpected) fail('staging-initialization-unproven');
    const markerPath = `${initializationRoot}/owner.json`;
    const marker = await probeStat(markerPath);
    if (marker !== undefined) {
      if (!ownedMode(marker, 0x8000, '600')) fail('staging-initialization-unproven');
      const size = Number(await exec(['stat', '-c', '%s', markerPath]));
      if (!Number.isSafeInteger(size) || size < 0 || size > markerBytes.length) fail('staging-initialization-unproven');
      let bytes: Buffer;
      try { bytes = await io.download(scope.engine, markerPath); }
      catch { return fail('staging-initialization-unproven'); }
      if (bytes.length !== size || !bytes.equals(markerBytes.subarray(0, size))) fail('staging-initialization-unproven');
      await exec(['rm', '--', markerPath]);
    }
    await exec(['rmdir', '--', initializationRoot]);
    await exec(['sync', '-f', '/tmp']);
  }
  async function stagingCapacity() {
    const value = (await exec(['stat', '-f', '-c', '%a:%S', '/tmp'])).trim().split(':').map(Number);
    const availableBytes = value[0] * value[1];
    if (value.length !== 2 || !value.every(n => Number.isSafeInteger(n) && n >= 0)
      || !Number.isSafeInteger(availableBytes)) fail('staging-capacity-unknown');
    return { engine: scope.engine, root: '/tmp', directory: stagingRoot,
      initializationDirectory: initializationRoot, reservedBytes: stagingReceipt.reservedBytes, availableBytes };
  }
  async function initStaging() {
    if (stagingReady) return;
    await persistStagingReceipt();
    if (await validateStaging()) {
      await cleanupInitialization();
      // flock is also held by every remote script. CP death does not release a
      // still-running dump/restore's lock. Never unlink its files or launch a retry.
      await exec(['flock', '-n', lockPath, 'rm', '-rf', '--',
        `${stagingRoot}/step-0`, `${stagingRoot}/step-1`]);
    } else {
      await cleanupInitialization();
      if ((await stagingCapacity()).availableBytes < stagingReceipt.reservedBytes) fail('insufficient-staging-capacity');
      await exec(['mkdir', '-m0700', initializationRoot]);
      try { await io.upload(scope.engine, `${initializationRoot}/owner.json`, markerBytes, { mode: '0600', timeout: 30_000 }); }
      catch { fail('staging-marker-write-failed'); }
      await exec(['sync', '-f', initializationRoot]);
      if (!(await validateStaging(initializationRoot))) fail('staging-initialization-unproven');
      // Same filesystem atomic publication; never replace any existing final
      // directory. A lost mv acknowledgement leaves a complete, valid root.
      await exec(['mv', '-n', '-T', initializationRoot, stagingRoot]);
      await exec(['sync', '-f', '/tmp']);
      if (!(await validateStaging())) fail('staging-ownership-unproven');
    }
    if ((await stagingCapacity()).availableBytes < stagingReceipt.reservedBytes) fail('insufficient-staging-capacity');
    stagingReady = true;
  }

  // At most two fixed work slots, including nested SQL during restore.
  // Payloads and diagnostics never enter Incus record-output.
  async function workspace<T>(body: (dir: string) => Promise<T>): Promise<T> {
    await initStaging();
    if (workspaceDepth >= 2) fail('staging-depth-exceeded');
    const dir = `${stagingRoot}/step-${workspaceDepth}`;
    await exec(['flock', '-n', lockPath, 'rm', '-rf', '--', dir]);
    await exec(['mkdir', '-m0700', dir]);
    workspaceDepth++;
    try { return await body(dir); }
    finally {
      workspaceDepth--;
      await exec(['flock', '-n', lockPath, 'rm', '-rf', '--', dir]);
    }
  }
  async function script(dir: string, text: string, timeout = 300_000, privileged = true) {
    const path = `${dir}/${randomUUID()}.sh`;
    try {
      await io.upload(scope.engine, path, Buffer.from(
        `#!/bin/bash\nset -euo pipefail\numask 077\n` +
        `unset PGPASSWORD PGSERVICE PGSERVICEFILE PGHOSTADDR PGHOST PGPORT PGUSER PGDATABASE\n` +
        `export PGOPTIONS=${shellArg(privileged
          ? '-c search_path=pg_catalog -c log_statement=none -c log_min_error_statement=panic -c log_min_messages=panic -c log_min_duration_statement=-1 -c log_min_duration_sample=-1 -c log_duration=off -c log_statement_stats=off'
          : '-c client_min_messages=error -c statement_timeout=300000')}\n` +
        `ulimit -f ${Math.ceil(scope.maxDumpBytes / 1024)}\n${text}\n`,
      ), { mode: '0700', timeout: 30_000 });
    } catch { fail('upload-failed'); }
    // Bound the remote command too; losing CP's polling connection must
    // not leave an orphan holding the operation lock indefinitely.
    return exec(['timeout', '-k', '5', String(Math.ceil(timeout / 1000)),
      'flock', '-n', lockPath, 'bash', path], timeout + 10_000);
  }
  function shellArg(s: string) { return `'${s.replaceAll("'", "'\\''")}'`; }
  function command(args: string[]) { return args.map(shellArg).join(' '); }
  async function sql(text: string, target = 'postgres', output = false): Promise<string> {
    return workspace(async dir => {
      const path = `${dir}/step.sql`;
      try {
        await io.upload(scope.engine, path, Buffer.from(text), { mode: '0600', timeout: 30_000 });
      } catch { fail('upload-failed'); }
      const args = [...maintenance];
      args[args.indexOf('--dbname') + 1] = target;
      return script(dir, `${command([...args, '--file', path])} ${output ? '' : '>/dev/null'} 2>/dev/null`);
    });
  }

  async function runtime(stopped: boolean, requireIngress = true, requireClosure = true): Promise<AppUpdatePostgresRuntime> {
    let r: AppUpdatePostgresRuntime;
    try { r = await io.runtime(); } catch { return fail('runtime-observation-failed'); }
    if (!r.lifecycleExcluded || (requireIngress && !r.ingressBlocked) || !r.securityRevision
      || r.engine.name !== scope.engine
      || (scope.mode === 'own' && r.engine.ownerAppId !== scope.appId)) fail('runtime-not-excluded');
    if (r.engine.state !== 'Running') fail('engine-stopped-start-after-journal');
    if (!requireClosure) return r;
    checkWriterClosure(r, stopped);
    return r;
  }
  function checkWriterClosure(r: AppUpdatePostgresRuntime, stopped: boolean) {
    const uses = r.credentialUses.filter(u => u.role === scope.ownerRole);
    if (!uses.length || uses.some(u => u.appId !== scope.appId || u.engine !== scope.engine
      || u.database !== scope.database || !u.container || !Array.isArray(u.clientAddresses)
      || !['Running', 'Stopped'].includes(u.state)
      || (stopped && (u.state !== 'Stopped' || u.container === scope.engine)))) fail('writer-closure-unproven');
  }

  const catalogQuery = appUpdatePostgresCatalogQuery(scope);

  function checkCatalog(c: Catalog, r: AppUpdatePostgresRuntime, stopped: boolean) {
    if (c.database !== scope.database || c.ownerRole !== scope.ownerRole || !c.admin
      || c.unsafeOwner || c.sharedOwner || c.unsupported || c.version < 150000
      || !Number.isInteger(c.connectionLimit) || c.connectionLimit < -1
      || typeof c.allowConnections !== 'boolean') fail('dedicated-ownership-unproven');
    if (c.foreignOwners.length || c.foreignWriters.some(role => !allowed.has(role))
      || c.superusers.some(role => !scope.adminRoles.includes(role))) fail('foreign-writer');
    for (const session of c.sessions) {
      if (scope.adminRoles.includes(session.role) && session.backend === 'client backend') continue;
      if (session.role !== scope.ownerRole || stopped || session.backend !== 'client backend'
        || !session.address || !r.credentialUses.some(u => u.role === session.role
          && u.clientAddresses.includes(session.address!))) fail('foreign-session');
    }
  }
  async function catalog(r: AppUpdatePostgresRuntime, stopped: boolean) {
    let c: Catalog;
    try {
      c = JSON.parse((await sql(catalogQuery, scope.database, true)).trim()) as Catalog;
      if (!Array.isArray(c.acl) || !Array.isArray(c.foreignOwners) || !Array.isArray(c.foreignWriters)
        || !Array.isArray(c.superusers) || !Array.isArray(c.sessions)) fail('invalid-observation');
    } catch { return fail('invalid-observation'); }
    checkCatalog(c, r, stopped);
    return c;
  }
  async function databaseState(optional = false) {
    const result = await sql(`SELECT json_build_object('allowConnections',datallowconn,'connectionLimit',datconnlimit,
      'ownerRole',pg_get_userbyid(datdba)) FROM pg_database WHERE datname=${literal(scope.database)};`, 'postgres', true);
    try {
      if (optional && !result.trim()) return undefined;
      const c = JSON.parse(result.trim()) as Pick<Catalog, 'allowConnections' | 'connectionLimit' | 'ownerRole'>;
      if (c.ownerRole !== scope.ownerRole || typeof c.allowConnections !== 'boolean'
        || !Number.isInteger(c.connectionLimit)) fail('database-identity-changed');
      return c;
    } catch { return fail('database-identity-changed'); }
  }
  const closeSql = `ALTER DATABASE ${db} ALLOW_CONNECTIONS false; ALTER DATABASE ${db} CONNECTION LIMIT 0;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${literal(scope.database)} AND pid<>pg_backend_pid();`;
  async function close() {
    if (await databaseState(true)) await sql(closeSql);
  }
  async function requireClosed() {
    const c = await databaseState();
    if (!c || c.allowConnections || c.connectionLimit !== 0) fail('database-not-fenced');
  }
  async function ensureFenced(r: AppUpdatePostgresRuntime, stopped: boolean) {
    const c = await databaseState();
    if (!c) fail('database-identity-changed');
    if (c.allowConnections) await catalog(r, stopped);
    if (c.allowConnections || c.connectionLimit !== 0) await close();
    await requireClosed();
  }
  async function withMaintenance<T>(body: () => Promise<T>): Promise<T> {
    await requireClosed();
    try {
      // LIMIT 0 excludes every non-superuser, including the owner. Admin closure
      // is verified and serialized by the parent's durable maintenance lock.
      await sql(`ALTER DATABASE ${db} ALLOW_CONNECTIONS true;`);
      return await body();
    } finally { await close(); }
  }
  function checkFence(f: AppUpdatePostgresFence, r: AppUpdatePostgresRuntime) {
    if (f.schema !== 'youeye.app-postgres-fence.v1' || f.engine !== scope.engine
      || f.database !== scope.database || f.ownerRole !== scope.ownerRole || f.operationId !== scope.operationId
      || f.securityRevision !== r.securityRevision || !Array.isArray(f.originalAcl)
      || typeof f.originalAllowConnections !== 'boolean'
      || !Number.isInteger(f.originalConnectionLimit) || f.originalConnectionLimit < -1) fail('fence-identity-or-security-changed');
  }
  function grantSql(grants: Grant[], connectOnly = false) {
    return grants.filter(g => !connectOnly || g.privilege === 'CONNECT').map(g => {
      if (!['CONNECT', 'CREATE', 'TEMPORARY'].includes(g.privilege)
        || (g.role !== 'PUBLIC' && !identifier.test(g.role)) || !identifier.test(g.grantor)
        || !allowed.has(g.grantor) || typeof g.grantable !== 'boolean') fail('unsupported-database-grant');
      return `SET ROLE ${quote(g.grantor)}; GRANT ${g.privilege} ON DATABASE ${db} TO ${
        g.role === 'PUBLIC' ? 'PUBLIC' : quote(g.role)}${g.grantable ? ' WITH GRANT OPTION' : ''}; RESET ROLE;`;
    }).join('\n');
  }
  const revokeConnect = `REVOKE CONNECT ON DATABASE ${db} FROM PUBLIC;\n` +
    `DO $f$ DECLARE r record; BEGIN FOR r IN SELECT rolname FROM pg_roles LOOP
      EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I',${literal(scope.database)},r.rolname); END LOOP; END $f$;`;

  // Capture current object/default privileges, not checkpoint-era security.
  // Generate the reconciliation script directly into a protected remote file.
  // Unsupported ACL-bearing objects fail rather than silently lose a grant.
  const securityQuery = `SET search_path=pg_catalog;
WITH objects AS (
 SELECT 'SCHEMA' AS kind,quote_ident(nspname) AS identity,nspowner AS owner,nspacl AS acl,'n'::"char" AS code
 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema'
 UNION ALL
 SELECT CASE WHEN c.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,
   format('%I.%I',n.nspname,c.relname),c.relowner,c.relacl,
   CASE WHEN c.relkind='S' THEN 'S' ELSE 'r' END::"char"
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','S')
 UNION ALL
 SELECT CASE WHEN p.prokind='p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
   format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),p.proowner,p.proacl,'f'::"char"
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
 UNION ALL
 SELECT 'TYPE',format('%I.%I',n.nspname,t.typname),t.typowner,t.typacl,'T'::"char"
 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
 WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND t.typrelid=0 AND t.typelem=0
), lines AS (
 SELECT 0 AS ord,'BEGIN; SET LOCAL search_path=pg_catalog;' AS line
 UNION ALL SELECT 1,format('REVOKE ALL ON %s %s FROM PUBLIC;',kind,identity) FROM objects
 UNION ALL SELECT 2,format('SET ROLE %I; GRANT %s ON %s %s TO %s%s; RESET ROLE;',
   CASE WHEN pg_get_userbyid(a.grantor)='pg_database_owner' THEN ${literal(scope.ownerRole)}
     ELSE pg_get_userbyid(a.grantor) END,a.privilege_type,o.kind,o.identity,
   CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END,
   CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
 FROM objects o CROSS JOIN LATERAL aclexplode(COALESCE(o.acl,acldefault(o.code,o.owner))) a
 UNION ALL
 SELECT 3,format('SET ROLE %I; GRANT %s (%I) ON TABLE %I.%I TO %s%s; RESET ROLE;',
   pg_get_userbyid(a.grantor),a.privilege_type,att.attname,n.nspname,c.relname,
   CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END,
   CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
 FROM pg_attribute att JOIN pg_class c ON c.oid=att.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
 UNION ALL
 SELECT 4,format('ALTER DEFAULT PRIVILEGES FOR ROLE %I %s REVOKE ALL ON %s FROM PUBLIC;',
   pg_get_userbyid(d.defaclrole),CASE WHEN d.defaclnamespace=0 THEN '' ELSE format('IN SCHEMA %I',n.nspname) END,
   CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS'
     WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' END)
 FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
 UNION ALL
 SELECT 5,format('SET ROLE %I; ALTER DEFAULT PRIVILEGES FOR ROLE %I %s GRANT %s ON %s TO %s%s; RESET ROLE;',
   pg_get_userbyid(a.grantor),pg_get_userbyid(d.defaclrole),
   CASE WHEN d.defaclnamespace=0 THEN '' ELSE format('IN SCHEMA %I',n.nspname) END,
   a.privilege_type,CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES'
   WHEN 'f' THEN 'FUNCTIONS' WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' END,
   CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END,
   CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
 FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace CROSS JOIN LATERAL aclexplode(d.defaclacl) a
 UNION ALL
 SELECT 6,CASE WHEN s.setrole=0 THEN format('ALTER DATABASE %I SET %I TO %L;',${literal(scope.database)},
   split_part(v,'=',1),substr(v,strpos(v,'=')+1))
 ELSE format('ALTER ROLE %I IN DATABASE %I SET %I TO %L;',pg_get_userbyid(s.setrole),${literal(scope.database)},
   split_part(v,'=',1),substr(v,strpos(v,'=')+1)) END
 FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) v
 WHERE s.setdatabase=(SELECT oid FROM pg_database WHERE datname=${literal(scope.database)})
 UNION ALL SELECT 7,'COMMIT;'
) SELECT CASE WHEN ord IN (0,7) THEN line ELSE format(
 'DO $youeye_acl$ BEGIN EXECUTE %L; EXCEPTION WHEN undefined_table OR undefined_function OR undefined_object OR undefined_column OR invalid_schema_name THEN NULL; END $youeye_acl$;',
 line) END FROM lines ORDER BY ord,line;`;

  // Reset implicit PUBLIC grants and any grants introduced by current default
  // privileges before applying the retained current security. Old-only objects
  // must not accidentally regain a revoked PUBLIC function/type grant.
  const clearObjectGrants = `
DO $clear$ DECLARE o record; r record; BEGIN
 FOR o IN
  SELECT 'SCHEMA' AS kind,quote_ident(nspname) AS identity FROM pg_namespace
    WHERE nspname !~ '^pg_' AND nspname<>'information_schema'
  UNION ALL SELECT CASE WHEN c.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,format('%I.%I',n.nspname,c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','S')
  UNION ALL SELECT CASE WHEN p.prokind='p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
    format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
  UNION ALL SELECT 'TYPE',format('%I.%I',n.nspname,t.typname)
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND t.typrelid=0 AND t.typelem=0
 LOOP
  EXECUTE format('REVOKE ALL ON %s %s FROM PUBLIC CASCADE',o.kind,o.identity);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname NOT IN (${literal(scope.ownerRole)},'pg_database_owner') LOOP
   EXECUTE format('REVOKE ALL ON %s %s FROM %I CASCADE',o.kind,o.identity,r.rolname);
  END LOOP;
 END LOOP;
END $clear$;`;

  const provider = {
    /** Parent must add this reservation on the engine's /tmp filesystem. */
    stagingCapacity,

    /** No prefix deletion: exact path, root ownership/mode and full marker match. */
    async cleanupStaging(): Promise<void> {
      requireOperation();
      await runtime(false, false, false);
      if (workspaceDepth) fail('staging-in-use');
      await persistStagingReceipt();
      const exists = await validateStaging();
      await cleanupInitialization();
      if (!exists) { stagingReady = false; return; }
      await exec(['flock', '-n', lockPath, 'rm', '-rf', '--', stagingRoot]);
      stagingReady = false;
    },

    /**
     * Emergency recovery fence. The parent has stopped app writers. A newer
     * security generation blocks normal recovery, but must not leave this exact
     * still-app-owned database open. Do not replay any ACL/role/credential state.
     */
    async refence(f: AppUpdatePostgresFence): Promise<void> {
      requireOperation();
      const r = await runtime(true, true, false);
      if (f.schema !== 'youeye.app-postgres-fence.v1' || f.engine !== scope.engine
        || f.database !== scope.database || f.ownerRole !== scope.ownerRole || f.operationId !== scope.operationId) {
        fail('fence-identity-or-security-changed');
      }
      if (r.credentialUses.some(u => u.appId === scope.appId
        && u.container !== scope.engine && u.state !== 'Stopped')) fail('writers-not-stopped');
      // Maintenance database observations validate actual owner identity without
      // connecting to or reopening the target. Also terminate leftover sessions.
      await close();
      await requireClosed();
      checkFence(f, r);
      checkWriterClosure(r, true);
    },

    /**
     * Explicit SQL migration in the open apply phase, under the same operation
     * reservation. Connect AS owner, never admin+SET ROLE (RESET ROLE would
     * otherwise regain admin). No psql metacommands or non-UTF8/NUL payloads.
     * The owner session must already suppress statement/error/duration logging;
     * this method never changes role credentials, grants or logging policy.
     */
    async executeSQL(f: AppUpdatePostgresFence, input: string | Buffer): Promise<void> {
      requireOperation();
      const bytes = Buffer.from(input);
      if (!bytes.length || bytes.length > scope.maxDumpBytes || bytes.includes(0)
        || !Buffer.from(bytes.toString('utf8')).equals(bytes)) fail('sql-payload-invalid');
      // Deliberately conservative: also refuses escaped string literals. A SQL
      // parser would be needed to safely permit psql's backslash interpretation.
      if (bytes.includes(92)) fail('sql-metacommands-unsupported');
      const r = await runtime(false);
      checkFence(f, r);
      const state = await databaseState();
      if (!state?.allowConnections || state.connectionLimit !== f.originalConnectionLimit) fail('sql-requires-apply-phase');
      const c = await catalog(r, false);
      if (c.acl.some(g => g.privilege === 'CONNECT' && !allowed.has(g.role))
        || !c.acl.some(g => g.privilege === 'CONNECT' && g.role === scope.ownerRole)) fail('sql-requires-exclusive-admission');
      // Nonprivileged owners cannot inspect these restricted GUCs. Inspect
      // their effective startup context through maintenance without granting
      // pg_read_all_settings or running the migration as an administrator.
      const preloadSafe = await sql(`SELECT CASE /* youeye-owner-preload-check */ WHEN
 pg_catalog.current_setting('shared_preload_libraries')=''
 AND pg_catalog.current_setting('session_preload_libraries')=''
 AND NOT pg_catalog.has_parameter_privilege(${literal(scope.ownerRole)},'session_preload_libraries','SET')
 AND NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_db_role_setting s,
     LATERAL pg_catalog.unnest(s.setconfig) setting
   WHERE s.setrole IN (0,(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${literal(scope.ownerRole)}))
     AND s.setdatabase IN (0,(SELECT oid FROM pg_catalog.pg_database WHERE datname=${literal(scope.database)}))
     AND setting LIKE 'session_preload_libraries=%' AND setting<>'session_preload_libraries='
 ) THEN 1 ELSE 0 END;`, 'postgres', true);
      if (preloadSafe.trim() !== '1') fail('sql-owner-session-logging-unsafe');
      await workspace(async dir => {
        const ownerArgs = [...maintenance];
        ownerArgs[ownerArgs.indexOf('--username') + 1] = scope.ownerRole;
        ownerArgs[ownerArgs.indexOf('--dbname') + 1] = scope.database;
        const checkPath = `${dir}/owner-session.sql`;
        const loggingCheck = `SELECT CASE WHEN current_user=${literal(scope.ownerRole)}
 AND pg_catalog.current_setting('log_statement')='none'
 AND pg_catalog.current_setting('log_min_error_statement')='panic'
 AND pg_catalog.current_setting('log_min_messages')='panic'
 AND pg_catalog.current_setting('log_min_duration_statement')::int<0
 AND pg_catalog.current_setting('log_min_duration_sample')::int<0
 AND NOT pg_catalog.current_setting('log_duration')::boolean
 AND NOT pg_catalog.current_setting('log_statement_stats')::boolean
 AND pg_catalog.current_setting('local_preload_libraries')=''
 THEN 1 ELSE 0 END;`;
        try { await io.upload(scope.engine, checkPath, Buffer.from(loggingCheck), { mode: '0600', timeout: 30_000 }); }
        catch { fail('upload-failed'); }
        const safe = await script(dir,
          `${command([...ownerArgs, '--file', checkPath])} 2>/dev/null`, 30_000, false);
        if (safe.trim() !== '1') fail('sql-owner-session-logging-unsafe');
        const sqlPath = `${dir}/migration.sql`;
        try { await io.upload(scope.engine, sqlPath, bytes, { mode: '0600', timeout: 30_000 }); }
        catch { fail('upload-failed'); }
        await script(dir, `${command([...ownerArgs, '--file', sqlPath])} >/dev/null 2>/dev/null`, 300_000, false);
      });
    },

    async observations(): Promise<UpdateInventoryObservations['databases'][number]> {
      const r = await runtime(false, false);
      const state = await databaseState();
      if (!state?.allowConnections) fail('database-closed-reconcile-existing-fence');
      const c = await catalog(r, false);
      return { engine: scope.engine, name: c.database, ownerAppId: scope.appId,
        ownerRole: c.ownerRole, writers: [...new Set(r.credentialUses.filter(u => u.role === scope.ownerRole)
          .map(u => u.container))].sort(), logicalRestoreSupported: true };
    },

    /**
     * persist(receipt) MUST durably record intent before any ALTER DATABASE.
     * A crash during this method leaves an explicit restorable original state.
     */
    async preflightFence(persist: (receipt: AppUpdatePostgresFence) => Promise<void>): Promise<AppUpdatePostgresFence> {
      requireOperation();
      const r = await runtime(true);
      const state = await databaseState();
      if (!state?.allowConnections) fail('database-closed-reconcile-existing-fence');
      const c = await catalog(r, true);
      // Validate restorability of database grants before making any mutation.
      grantSql(c.acl);
      const f: AppUpdatePostgresFence = { schema: 'youeye.app-postgres-fence.v1',
        engine: scope.engine, database: scope.database, ownerRole: scope.ownerRole,
        operationId: scope.operationId, securityRevision: r.securityRevision, originalAllowConnections: c.allowConnections,
        originalConnectionLimit: c.connectionLimit, originalAcl: c.acl };
      try { await persist(structuredClone(f)); } catch { fail('fence-persistence-failed'); }
      await close();
      await requireClosed();
      return f;
    },

    async dump(f: AppUpdatePostgresFence): Promise<AppUpdatePostgresCheckpoint> {
      requireOperation();
      const r = await runtime(true);
      checkFence(f, r);
      return withMaintenance(async () => {
        const c = await catalog(r, true);
        return workspace(async dir => {
          const path = `${dir}/checkpoint.dump`;
          await script(dir, `${command(['pg_dump', '--no-password', '--username', scope.adminRole,
            '--dbname', scope.database, '--format=custom', '--no-privileges', '--file', path])} >/dev/null 2>/dev/null
${command(['pg_restore', '--exit-on-error', '--file=/dev/null', path])} >/dev/null 2>/dev/null`);
          const size = Number((await exec(['stat', '-c', '%s', path])).trim());
          if (!Number.isSafeInteger(size) || size < 5 || size > scope.maxDumpBytes) fail('dump-size-invalid');
          let bytes: Buffer;
          try { bytes = await io.download(scope.engine, path); } catch { return fail('download-failed'); }
          if (bytes.length !== size || bytes.subarray(0, 5).toString() !== 'PGDMP') fail('dump-incomplete');
          return { schema: 'youeye.app-postgres-checkpoint.v1', engine: scope.engine,
            database: scope.database, ownerRole: scope.ownerRole, serverVersion: c.version,
            byteSize: size, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
        });
      });
    },

    async restore(f: AppUpdatePostgresFence, checkpoint: AppUpdatePostgresCheckpoint, options: {
      persistSecurity: (security: AppUpdatePostgresSecurity) => Promise<void>;
      security?: AppUpdatePostgresSecurity;
    }): Promise<void> {
      requireOperation();
      const r = await runtime(true);
      checkFence(f, r);
      if (checkpoint.schema !== 'youeye.app-postgres-checkpoint.v1' || checkpoint.engine !== scope.engine
        || checkpoint.database !== scope.database || checkpoint.ownerRole !== scope.ownerRole
        || !Buffer.isBuffer(checkpoint.bytes) || checkpoint.bytes.length !== checkpoint.byteSize
        || checkpoint.byteSize > scope.maxDumpBytes || checkpoint.byteSize < 5
        || checkpoint.bytes.subarray(0, 5).toString() !== 'PGDMP'
        || !Number.isInteger(checkpoint.serverVersion) || checkpoint.serverVersion < 150000
        || createHash('sha256').update(checkpoint.bytes).digest('hex') !== checkpoint.sha256) fail('checkpoint-invalid');
      let retained = options.security;
      if (retained) {
        if (retained.schema !== 'youeye.app-postgres-security.v1' || retained.engine !== scope.engine
          || retained.database !== scope.database || retained.ownerRole !== scope.ownerRole
          || retained.securityRevision !== r.securityRevision || !Buffer.isBuffer(retained.bytes)
          || retained.bytes.length > scope.maxDumpBytes
          || createHash('sha256').update(retained.bytes).digest('hex') !== retained.sha256
          || !Number.isInteger(retained.version) || retained.version < 150000
          || ![retained.encoding, retained.collate, retained.ctype].every(s => typeof s === 'string' && !s.includes('\0'))) {
          fail('security-checkpoint-invalid');
        }
        grantSql(retained.acl);
        securityScript(retained.bytes);
        // Interrupted DROP/CREATE is recoverable only with durable current
        // security and the parent's exact database reservation.
        if (!(await databaseState(true))) {
          await sql(`CREATE DATABASE ${db} OWNER ${owner} TEMPLATE template0
ENCODING ${literal(retained.encoding)} LC_COLLATE ${literal(retained.collate)} LC_CTYPE ${literal(retained.ctype)}
ALLOW_CONNECTIONS false CONNECTION LIMIT 0;`);
        }
      }
      await ensureFenced(r, true);
      await withMaintenance(async () => {
        const current = await catalog(r, true);
        if (Math.floor(current.version / 10000) < Math.floor(checkpoint.serverVersion / 10000)) fail('logical-downgrade-unsupported');
        await workspace(async dir => {
          const archive = `${dir}/restore.dump`;
          const query = `${dir}/security-query.sql`;
          const security = `${dir}/current-security.sql`;
          try {
            await io.upload(scope.engine, archive, checkpoint.bytes, { mode: '0600', timeout: 300_000 });
            await io.upload(scope.engine, query, Buffer.from(securityQuery), { mode: '0600', timeout: 30_000 });
          } catch { fail('upload-failed'); }
          const target = [...maintenance];
          target[target.indexOf('--dbname') + 1] = scope.database;
          await script(dir, `${command(['pg_restore', '--exit-on-error', '--file=/dev/null', archive])} >/dev/null 2>/dev/null
${command([...target, '--file', query])} >${shellArg(security)} 2>/dev/null`);
          if (!retained) {
            let bytes: Buffer;
            try { bytes = await io.download(scope.engine, security); } catch { return fail('download-failed'); }
            if (!bytes.length || bytes.length > scope.maxDumpBytes) fail('security-checkpoint-invalid');
            retained = { schema: 'youeye.app-postgres-security.v1', engine: scope.engine,
              database: scope.database, ownerRole: scope.ownerRole, securityRevision: r.securityRevision,
              encoding: current.encoding, collate: current.collate, ctype: current.ctype, version: current.version,
              acl: current.acl, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
            try { await options.persistSecurity(retained); } catch { fail('security-persistence-failed'); }
          }
          // Upload the reconciled script for both freshly captured and retained
          // security; the durable original bytes remain unchanged.
          try { await io.upload(scope.engine, security, securityScript(retained.bytes), { mode: '0600', timeout: 30_000 }); }
          catch (error) {
            if (error instanceof AppUpdatePostgresError) throw error;
            fail('upload-failed');
          }
          if (Math.floor(current.version / 10000) < Math.floor(retained.version / 10000)) fail('logical-downgrade-unsupported');
          // Capture CURRENT database privileges; roles/credentials/memberships
          // are never dumped, dropped, recreated or altered.
          grantSql(retained.acl);
          await close();
          await sql(`DROP DATABASE ${db};`);
          await sql(`CREATE DATABASE ${db} OWNER ${owner} TEMPLATE template0
ENCODING ${literal(retained.encoding)} LC_COLLATE ${literal(retained.collate)} LC_CTYPE ${literal(retained.ctype)}
ALLOW_CONNECTIONS false CONNECTION LIMIT 0;`);
          await sql(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC;\n${grantSql(retained.acl)}`);
          await sql(`ALTER DATABASE ${db} ALLOW_CONNECTIONS true;`);
          await script(dir, `${command(['pg_restore', '--no-password', '--username', scope.adminRole,
            '--dbname', scope.database, '--role', scope.ownerRole, '--no-owner', '--no-privileges',
            '--exit-on-error', '--single-transaction', archive])} >/dev/null 2>/dev/null`);
          await sql(clearObjectGrants, scope.database);
          await script(dir, `${command([...target, '--file', security])} >/dev/null 2>/dev/null`);
          await catalog(r, true);
        });
      });
    },

    async unfence(f: AppUpdatePostgresFence, phase: 'apply' | 'original'): Promise<void> {
      requireOperation();
      const r = await runtime(phase === 'original');
      checkFence(f, r);
      if (!['apply', 'original'].includes(phase)) fail('invalid-unfence-phase');
      // Failures at any step explicitly return to the hard fence.
      try {
        await ensureFenced(r, phase === 'original');
        await withMaintenance(async () => {
          const c = await catalog(r, phase === 'original');
          await sql(revokeConnect);
          if (phase === 'apply') {
            await sql(`GRANT CONNECT ON DATABASE ${db} TO ${owner};`);
          } else {
            // A changed security generation cannot silently resurrect grants.
            // Other current privileges remain exactly as observed.
            grantSql(c.acl);
            await sql(grantSql(f.originalAcl, true));
          }
        });
        await sql(`ALTER DATABASE ${db} CONNECTION LIMIT ${f.originalConnectionLimit};
ALTER DATABASE ${db} ALLOW_CONNECTIONS ${phase === 'apply' ? 'true' : String(f.originalAllowConnections)};`);
      } catch { await close(); fail('unfence-failed'); }
    },

    async verify(expected: 'closed' | 'apply' | 'original', f: AppUpdatePostgresFence): Promise<void> {
      requireOperation();
      const r = await runtime(expected === 'closed');
      checkFence(f, r);
      if (expected === 'closed') {
        await requireClosed();
        await withMaintenance(async () => { await catalog(r, true); });
      } else {
        const c = await catalog(r, false);
        if (c.connectionLimit !== f.originalConnectionLimit
          || c.allowConnections !== (expected === 'apply' || f.originalAllowConnections)) fail('fence-verification-failed');
        if (expected === 'apply') {
          if (c.acl.some(g => g.privilege === 'CONNECT' && !allowed.has(g.role))) fail('foreign-connection-grant');
          if (!c.acl.some(g => g.privilege === 'CONNECT' && g.role === scope.ownerRole)) fail('app-connection-grant-missing');
        }
        if (expected === 'original') {
          const connect = (grants: Grant[]) => grants.filter(g => g.privilege === 'CONNECT')
            .map(g => JSON.stringify([g.role, g.grantor, g.grantable])).sort();
          if (JSON.stringify(connect(c.acl)) !== JSON.stringify(connect(f.originalAcl))) fail('original-connection-grants-changed');
        }
      }
    },
  };
  return { ...provider, observe: provider.observations, prepareFence: provider.preflightFence };
}
