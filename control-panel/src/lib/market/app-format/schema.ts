/**
 * Zod schemas for the app formats (docs/app-manifest.md):
 * `youeye.app.v1`, `youeye.setup.v1`, `youeye.bundle.v1`, `youeye.system-app.v1`, `youeye.catalog.v1`.
 *
 * Every object is strict: an unknown key is an error, except keys starting with `x-`, which are
 * kept and never read. Free-form maps (env, headers, bodies) are not objects of this kind.
 */

import { z } from 'zod/v4';
import { RESERVED_ROLE_CLAIMS } from '@/lib/identity/reserved-claims';

// ─── Helpers ──────────────────────────────────────────────

/** A strict object that keeps (and ignores) `x-` keys. */
function xobject<T extends z.ZodRawShape>(shape: T) {
  return z.looseObject(shape).superRefine((value, ctx) => {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (!Object.hasOwn(shape, key) && !key.startsWith('x-')) {
        ctx.addIssue({ code: 'custom', path: [key], message: `unknown field "${key}"` });
      }
    }
  });
}

const SYSTEM_APP_IDS = ['postgres', 'caddy', 'pihole', 'control', 'ui'];

export const AppId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'id must be 1–32 chars of [a-z0-9-] and start with a letter');
export const ContainerName = z.string().regex(/^[a-z0-9-]{1,30}$/, 'container name must be 1–30 chars of [a-z0-9-]');
export const SecretName = z.string().regex(/^[a-z0-9_]{1,40}$/, 'secret name must be 1–40 chars of [a-z0-9_]');
const GroupName = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'shared folder group must be 1–32 chars of [a-z0-9-]');
const Version = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/, 'version must be a plain version string');
const DbIdentifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'database identifiers are [a-z0-9_]');
const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'environment variable names are [A-Za-z0-9_]');
const Text = z.string().min(1);
const Url = z.url({ protocol: /^https?$/ });
/** An OCI image reference; strict parsing additionally requires `@sha256:<64 hex>`. */
export const ImageRef = z.string().regex(/^[a-z0-9][a-z0-9._/:-]*(@sha256:[0-9a-f]{64})?$/, 'image must be an OCI image reference');
export const PINNED_IMAGE = /@sha256:[0-9a-f]{64}$/;

const scalarString = z.union([z.string(), z.number(), z.boolean()]).transform(String);
const EnvMap = z.record(EnvName, scalarString);

/** An absolute, normalized container path (no `..`, no `//`, not `/`). */
export function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') && value.length > 1 && !value.endsWith('/') && !value.includes('//')
    && !value.includes('\0') && !value.split('/').some((part) => part === '..' || part === '.');
}
const AbsPath = z.string().refine(isAbsolutePath, 'must be an absolute path without "..", "." or "//"');

/** A path on the app's own HTTP server: starts with `/`, no `//`, no scheme or host, no `..`. */
export function isRelativeHttpPath(value: string): boolean {
  if (!value.startsWith('/') || value.includes('//') || value.includes('\\') || /\s/.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value.slice(1)) || value.includes('://')) return false;
  const pathPart = value.split(/[?#]/, 1)[0];
  return !pathPart.split('/').some((part) => part === '..' || part === '.' || /^%2e%2e$/i.test(part));
}
const HttpPath = z.string().refine(isRelativeHttpPath, 'must be a path on the app itself: starts with "/", no "//", "..", scheme or host');

/** A file next to the manifest (icon, screenshot, setup file). */
export function isRelativeFile(value: string): boolean {
  return /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(value) && !value.split('/').some((part) => part === '..' || part === '.');
}
const RelativeFile = z.string().refine(isRelativeFile, 'must be a file path next to the manifest');
const SetupRef = z.string().regex(/^setup\/[a-z0-9][a-z0-9-]{0,62}\.yaml$/, 'must name a file setup/<name>.yaml');

const Seconds = z.number().int().positive().max(3600);
const Port = z.number().int().min(1).max(65535);
const Methods = z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])).min(1);
const Scope = z.enum(['user', 'service']);

const Health = z.union([HttpPath, xobject({ path: HttpPath, timeout: Seconds.optional() })]);
/** A sidecar's health: an HTTP path, or `{ postgres: <user> }` (pg_isready as that user). */
const SidecarHealth = z.union([Health, xobject({ postgres: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/), timeout: Seconds.optional() })]);
const OctalMode = z.string().regex(/^0?[0-7]{3}$/, 'mode is an octal string like "0644"');

/** A path on the app (may contain `${…}`, e.g. `${sso.slug}`). */
const AppPathTemplate = (what: string) => z.string()
  .refine((value) => isRelativeHttpPath(value.replace(/\$\{[^}]*\}/g, 'x')), `${what} must be a path on the app`);
/** A native-app redirect such as `app.immich:///oauth-callback`: a custom scheme, never http(s). */
export function isCustomSchemeUri(value: string): boolean {
  const match = /^([a-z][a-z0-9+.-]{1,63}):(\/\/\/?)?[^\s]*$/i.exec(value);
  return Boolean(match) && !['http', 'https', 'javascript', 'data', 'file', 'vbscript'].includes(match![1].toLowerCase());
}
const DataKind = z.enum(['data', 'config', 'media', 'cache']);
const DataList = z.array(z.union([AbsPath, xobject({ path: AbsPath, kind: DataKind.optional() })]));
const Argv = z.array(z.string()).min(1);

// ─── App manifest ─────────────────────────────────────────

const Listing = xobject({
  tagline: z.string().optional(),
  description: z.string().optional(),
  long_description: z.string().optional(),
  release_notes: z.string().optional(),
  category: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  tags: z.array(z.string().min(1).max(40)).optional(),
  icon: z.string().regex(/^[a-z0-9-]{1,60}$/, 'icon is a Lucide icon name').optional(),
  icon_file: RelativeFile.optional(),
  screenshots: z.array(xobject({ path: RelativeFile, caption: z.string().optional() })).optional(),
  website: Url.optional(),
  developer: z.string().optional(),
  license: z.string().optional(),
  source_code: Url.optional(),
  support: Url.optional(),
  docs: Url.optional(),
});

const Database = z.union([
  z.literal('none'),
  z.literal('postgres'),
  xobject({ postgres: xobject({ name: DbIdentifier, user: DbIdentifier }) }),
  xobject({ sidecar: ContainerName, name: DbIdentifier, user: DbIdentifier.optional() }),
]);

const ClaimValue = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);
// A role claim value: one string, or a list (sent as a JSON array) for apps that read a list of roles.
const RoleClaimValue = z.union([ClaimValue, z.array(z.string().regex(/^[A-Za-z0-9_.: -]{1,64}$/)).min(1).max(16)]);
const Sso = xobject({
  callback: AppPathTemplate('callback'),
  entry: AppPathTemplate('entry').optional(),
  /** Paths on the app, or custom-scheme URIs of the app's own clients (never http(s) URLs). */
  extra_callbacks: z.array(z.string().refine(
    (value) => isRelativeHttpPath(value.replace(/\$\{[^}]*\}/g, 'x')) || isCustomSchemeUri(value),
    'extra callbacks are paths on the app or custom-scheme URIs (e.g. app.immich:///oauth-callback)',
  )).optional(),
  backchannel_logout: HttpPath.optional(),
  admin_group: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
  /** Admins are marked by a claim value instead of a group (also requested as an OAuth scope). */
  role_claim: xobject({
    claim: ClaimValue.refine((claim) => !RESERVED_ROLE_CLAIMS.has(claim.toLowerCase()),
      'role_claim.claim names a standard claim or scope (sub, email, groups, is_admin, …); choose an app-specific name'),
    admin_value: RoleClaimValue,
    default_value: RoleClaimValue,
  })
    .refine((value) => Array.isArray(value.admin_value) === Array.isArray(value.default_value),
      'role_claim admin_value and default_value are both strings or both lists')
    .optional(),
  env: EnvMap.optional(),
}).refine((value) => !(value.admin_group && value.role_claim), 'sso has admin_group or role_claim, not both');

const Sidecar = xobject({
  name: ContainerName.refine((name) => name !== 'main', '"main" is reserved for the app itself'),
  image: ImageRef,
  port: Port.optional(),
  data: DataList.optional(),
  env: EnvMap.optional(),
  command: Argv.optional(),
  health: SidecarHealth.optional(),
});

const SurfaceSize = z.tuple([z.number().positive(), z.number().positive()]);
const SettingsField = xobject({
  key: Text,
  type: Text,
  label: Text,
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  choices: z.array(xobject({ value: z.string(), label: z.string() })).optional(),
});
const Surface = xobject({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  kind: z.enum(['widget', 'info-card', 'timeline-card', 'notification', 'settings-panel']),
  placement: z.enum(['dashboard', 'timeline', 'notification-center', 'app-settings', 'app-detail']),
  name: z.string().optional(),
  description: z.string().optional(),
  embed: HttpPath,
  permissions: z.array(Text).optional(),
  size: xobject({ default: SurfaceSize.optional(), min: SurfaceSize.optional(), max: SurfaceSize.optional() }).optional(),
  refresh: z.number().int().positive().optional(),
  settings: z.array(SettingsField).optional(),
  triggers: z.array(Text).optional(),
});

const Connect = xobject({
  app: AppId.refine((id) => !SYSTEM_APP_IDS.includes(id), 'connections cannot target system containers').optional(),
  type: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  name: Text,
  description: z.string().optional(),
  scope: Scope.optional(),
  setup: SetupRef.optional(),
  port: Port.optional(),
  proxy: xobject({ paths: z.array(HttpPath.or(z.string().regex(/^\/[A-Za-z0-9._~/*-]*$/))).min(1), methods: Methods.optional() }).optional(),
}).refine((value) => Boolean(value.app) !== Boolean(value.type), 'a connection names exactly one of app or type');

export const AppSchema = xobject({
  schema: z.literal('youeye.app.v1'),
  id: AppId,
  version: Version,
  name: Text,
  requires: xobject({ youeye: z.string().regex(/^>=\d+\.\d+\.\d+$/, 'requires.youeye must be ">=X.Y.Z"') }).optional(),
  subdomain: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/).optional(),
  listing: Listing.optional(),

  image: ImageRef.optional(),
  source: xobject({ node: z.enum(['22', '24']) }).optional(),
  port: Port,
  health: Health.optional(),
  command: Argv.optional(),
  internet: z.boolean().optional(),

  database: Database.optional(),
  data: DataList.optional(),
  shared: z.record(GroupName, AbsPath).optional(),

  env: EnvMap.optional(),
  secrets: z.record(SecretName, z.union([
    z.null(),
    xobject({ kind: z.enum(['password', 'key', 'hex']).optional(), length: z.number().int().min(8).max(256).optional() }),
  ])).optional(),
  credentials: z.array(xobject({ label: Text, username: Text, password: SecretName })).optional(),
  files: z.array(xobject({
    path: AbsPath,
    container: ContainerName.optional(),
    mode: OctalMode.optional(),
    dir_mode: OctalMode.optional(),
    template: z.string(),
  })).optional(),

  sso: Sso.optional(),
  ai: xobject({ env: EnvMap }).optional(),
  smtp: xobject({ env: EnvMap }).optional(),
  forward_auth: z.boolean().optional(),

  sidecars: z.array(Sidecar).optional(),

  provides: z.array(xobject({
    type: z.string().regex(/^[a-z0-9-]{1,40}$/),
    description: z.string().optional(),
    port: Port.optional(),
    scope: Scope.optional(),
  })).optional(),
  connects: z.array(Connect).optional(),
  /** The secret that holds this app's API key (`${peer.api_key}`/`${self.api_key}` in connect files). */
  api_key: xobject({ secret: SecretName }).optional(),
  api: xobject({
    base: HttpPath.optional(),
    spec: z.union([z.literal('none'), HttpPath]).optional(),
    auth: z.array(xobject({ id: z.string().regex(/^[a-z0-9-]{1,40}$/), principal: Text, scheme: Text, provision: Text })).optional(),
    identity: Text.optional(),
  }).optional(),

  data_ownership: xobject({ per_user: z.literal('identity_uuid') }).optional(),
  capabilities: xobject({
    widgets: z.boolean().optional(),
    settings_panel: z.boolean().optional(),
    notifications: z.union([z.boolean(), z.literal('push')]).optional(),
    info_cards: z.boolean().optional(),
    events: z.array(Text).optional(),
  }).optional(),
  surfaces: z.array(Surface).optional(),
  proxy: z.array(xobject({
    // A DNS name, optionally with one leading wildcard label (`*.wikipedia.org`).
    host: z.string().regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'proxy host must be a DNS name, optionally *.<name>'),
    paths: z.array(z.string().regex(/^\/[A-Za-z0-9._~/*%-]*$/)).min(1),
    methods: Methods.optional(),
    scope: Scope.optional(),
  })).optional(),
  link_handlers: z.array(xobject({
    type: Text,
    description: z.string(),
    endpoint: HttpPath.optional(),
    triggers: z.array(Text).min(1),
  })).optional(),
}).superRefine((app, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  if (Boolean(app.image) === Boolean(app.source)) issue(['image'], 'an app has exactly one of image (container app) or source (native app)');
  const sidecars = new Set<string>();
  for (const [index, sidecar] of (app.sidecars ?? []).entries()) {
    if (sidecars.has(sidecar.name)) issue(['sidecars', index, 'name'], `duplicate sidecar "${sidecar.name}"`);
    sidecars.add(sidecar.name);
  }
  if (app.source && sidecars.size > 0) issue(['sidecars'], 'native apps have no sidecars');
  for (const [index, file] of (app.files ?? []).entries()) {
    if (file.container && file.container !== 'main' && !sidecars.has(file.container)) {
      issue(['files', index, 'container'], `unknown container "${file.container}"`);
    }
  }
  const ownDatabase = app.database && typeof app.database === 'object' && 'sidecar' in app.database
    ? String(app.database.sidecar) : undefined;
  if (ownDatabase && !sidecars.has(ownDatabase)) issue(['database', 'sidecar'], `unknown sidecar "${ownDatabase}"`);
  const ids = new Set<string>();
  for (const [index, surface] of (app.surfaces ?? []).entries()) {
    if (ids.has(surface.id)) issue(['surfaces', index, 'id'], `duplicate surface "${surface.id}"`);
    ids.add(surface.id);
  }
});

export type AppDocument = z.infer<typeof AppSchema>;

// ─── Setup file ───────────────────────────────────────────

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** A dotted key path (for `set:`/`save:`) that never walks into the prototype chain. */
const KeyPath = z.string().regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, 'must be a dotted key path')
  .refine((value) => !value.split('.').some((part) => FORBIDDEN_KEYS.has(part)), 'must not use __proto__, constructor or prototype');
const VarName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).refine((value) => !FORBIDDEN_KEYS.has(value), 'reserved name');

const CONDITIONS = ['equals', 'not_equals', 'empty', 'not_empty'] as const;
const Condition = xobject({
  equals: z.tuple([z.string(), z.string()]).optional(),
  not_equals: z.tuple([z.string(), z.string()]).optional(),
  empty: z.string().optional(),
  not_empty: z.string().optional(),
}).refine((value) => CONDITIONS.filter((key) => value[key] !== undefined).length === 1,
  'a condition has exactly one of equals, not_equals, empty or not_empty');

/** A JSON path into a response: `$` (the whole body) or a dotted path (`data.items[0].id`). */
const ResponsePath = z.string().regex(/^(\$|[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+|\[\d+\])*)$/, 'must be "$" or a dotted path')
  .refine((value) => !value.split(/[.[\]]/).some((part) => FORBIDDEN_KEYS.has(part)), 'must not use __proto__, constructor or prototype');

const StepContainer = ContainerName.optional();

const HttpStep = xobject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).optional(),
  path: HttpPath,
  container: StepContainer,
  target: z.literal('peer').optional(),
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string()).optional(),
  body: z.unknown().optional(),
  body_from: KeyPath.optional(),
  set: z.record(KeyPath, z.unknown()).optional(),
  save: z.record(VarName, ResponsePath).optional(),
  ok: z.array(z.number().int().min(100).max(599)).min(1).optional(),
  allow_failure: z.boolean().optional(),
  if: Condition.optional(),
  for_each: xobject({ path: HttpPath, where: z.record(z.string(), z.unknown()).optional(), items: ResponsePath.optional() }).optional(),
}).refine((value) => !(value.body !== undefined && value.body_from), 'a step has body or body_from, not both')
  .refine((value) => !value.set || value.body_from || value.body === undefined, 'set merges into body_from');

const FileStep = xobject({
  container: StepContainer,
  path: AbsPath,
  mode: OctalMode.optional(),
  json: z.unknown().optional(),
  yaml: z.unknown().optional(),
  ini: z.record(z.string(), z.unknown()).optional(),
  text: z.string().optional(),
}).refine((value) => ['json', 'yaml', 'ini', 'text'].filter((key) => (value as Record<string, unknown>)[key] !== undefined).length === 1,
  'a file step has exactly one of json, yaml, ini or text');

const ExecStep = xobject({
  container: StepContainer,
  run: Argv,
  timeout: Seconds.optional(),
  allow_failure: z.boolean().optional(),
});

const WaitStep = xobject({ http: HttpPath, container: StepContainer, timeout: Seconds.optional() });

const STEP_SCHEMAS = {
  wait: WaitStep,
  http: HttpStep,
  file: FileStep,
  exec: ExecStep,
  restart: ContainerName,
  sleep: z.number().int().min(1).max(600),
} as const;

export type SetupStep =
  | { wait: z.infer<typeof WaitStep> }
  | { http: z.infer<typeof HttpStep> }
  | { file: z.infer<typeof FileStep> }
  | { exec: z.infer<typeof ExecStep> }
  | { restart: string }
  | { sleep: number };

/** One step: an object with exactly one step key (plus optional `x-` keys). */
const Step = z.record(z.string(), z.unknown()).transform((value, ctx): SetupStep => {
  const keys = Object.keys(value).filter((key) => !key.startsWith('x-'));
  const kind = keys[0] as keyof typeof STEP_SCHEMAS;
  if (keys.length !== 1 || !Object.hasOwn(STEP_SCHEMAS, kind)) {
    ctx.addIssue({ code: 'custom', message: `a step has exactly one of: ${Object.keys(STEP_SCHEMAS).join(', ')}` });
    return z.NEVER;
  }
  const parsed = STEP_SCHEMAS[kind].safeParse(value[kind]);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', path: [kind, ...issue.path], message: issue.message });
    return z.NEVER;
  }
  return { [kind]: parsed.data } as SetupStep;
});

export const SETUP_FOR = /^(sso|install|url-change|connect:[a-z][a-z0-9-]{0,31})$/;

export const SetupSchema = xobject({
  schema: z.literal('youeye.setup.v1'),
  for: z.string().regex(SETUP_FOR, 'for is sso, install, url-change or connect:<app>'),
  steps: z.array(Step).min(1),
  remove: z.array(Step).optional(),
});

export type SetupDocument = z.infer<typeof SetupSchema>;

// ─── Other kinds ──────────────────────────────────────────

export const BundleSchema = xobject({
  schema: z.literal('youeye.bundle.v1'),
  id: AppId,
  name: Text,
  description: Text,
  icon: z.string().optional(),
  category: z.string().optional(),
  summary: z.string().optional(),
  members: z.array(AppId).min(1),
  connections: z.array(xobject({ from: AppId, to: AppId, scope: Scope.optional() })).optional(),
  shared: z.array(GroupName).optional(),
});

export type BundleDocument = z.infer<typeof BundleSchema>;

export const SystemAppSchema = xobject({
  schema: z.literal('youeye.system-app.v1'),
  id: AppId,
  version: Version,
  name: Text,
  image: ImageRef,
  health: Health.optional(),
});

export type SystemAppDocument = z.infer<typeof SystemAppSchema>;

export const CatalogSchema = xobject({
  schema: z.literal('youeye.catalog.v1'),
  categories: z.array(xobject({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    label: Text,
    icon: z.string().optional(),
    order: z.number().optional(),
    tile: xobject({ bg: Text, fg: Text }).optional(),
  })).optional(),
  curation: xobject({
    spotlight: xobject({ title: z.string().optional(), apps: z.array(AppId) }).optional(),
    collections: z.array(xobject({ id: Text, label: Text, apps: z.array(AppId) })).optional(),
  }).optional(),
  native: z.array(AppId).optional(),
});

export type CatalogDocument = z.infer<typeof CatalogSchema>;

/**
 * The generated index of a custom (git) Market source, which cannot list folders:
 * `catalog.json` lists the app, bundle and system ids found in its folders.
 */
export const CatalogIndexSchema = xobject({
  schema: z.literal('youeye.catalog-index.v1'),
  apps: z.array(AppId),
  bundles: z.array(AppId).optional(),
  system: z.array(AppId).optional(),
});

export type CatalogIndexDocument = z.infer<typeof CatalogIndexSchema>;
