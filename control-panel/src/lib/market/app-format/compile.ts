/**
 * Compile a parsed `youeye.app.v1` manifest (+ setup files) into the engine's internal model
 * (`AppManifest` in ../types.ts). The engine never sees the YAML format.
 */

import { getContainerName } from '../engine-helpers';
import type {
  AppManifest, ConfigFileSpec, ContainerSpec, FrozenAppSource, HealthCheckSpec, SecretSpec, SetupFile,
  SurfaceSpec, VolumeSpec,
} from '../types';
import { manifestDigest } from './digest';
import { parseAppSource, readAppSource, type AppSource, type ParseOptions, type ParsedApp } from './parse';
import type { AppDocument } from './schema';
import { variableReferences } from './variables';

/** The LXD base image of native app runtimes. */
export const NATIVE_BASE_IMAGE = 'debian/12';
const DEFAULT_SECRET_LENGTH = 32;
const DEFAULT_HEALTH_TIMEOUT_SECONDS = 120;

/** Shell-quote argv for Incus `oci.entrypoint`. */
export function quoteArgv(argv: readonly string[]): string {
  return argv.map((arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(' ');
}

type SidecarHealthDocument = NonNullable<NonNullable<AppDocument['sidecars']>[number]['health']>;

function health(value: SidecarHealthDocument | undefined): HealthCheckSpec | undefined {
  if (!value) return undefined;
  const common = { retries: 3, startPeriod: 0, autoRestart: true };
  if (typeof value === 'string') return { type: 'http', path: value, timeout: DEFAULT_HEALTH_TIMEOUT_SECONDS * 1000, ...common };
  const timeout = ((value.timeout as number | undefined) ?? DEFAULT_HEALTH_TIMEOUT_SECONDS) * 1000;
  if ('postgres' in value) return { type: 'postgres', user: String(value.postgres), timeout, ...common };
  return { type: 'http', path: String(value.path), timeout, ...common };
}

/** A volume name from its mount path: the last path segment, made unique per container. */
function volumeName(mountPath: string, taken: Set<string>): string {
  const last = mountPath.split('/').filter(Boolean).pop() ?? 'data';
  const base = last.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'data';
  let name = /^[a-z0-9]/.test(base) ? base : `v${base}`;
  for (let index = 2; taken.has(name); index += 1) name = `${base}-${index}`;
  taken.add(name);
  return name;
}

function volumes(data: AppDocument['data'], shared?: AppDocument['shared']): VolumeSpec[] {
  const taken = new Set<string>();
  const result: VolumeSpec[] = [];
  for (const [group, mountPath] of Object.entries(shared ?? {})) {
    taken.add(group);
    result.push({ name: group, container: mountPath, type: 'media', read_only: false, storageGroup: group });
  }
  for (const item of data ?? []) {
    const spec = typeof item === 'string' ? { path: item, kind: undefined } : item;
    result.push({ name: volumeName(spec.path, taken), container: spec.path, type: spec.kind ?? 'data', read_only: false });
  }
  return result;
}

function env(map: Record<string, string> | undefined): Record<string, string> {
  return { ...(map ?? {}) };
}

function surface(item: NonNullable<AppDocument['surfaces']>[number]): SurfaceSpec {
  const size = (value?: [number, number]) => (value ? { width: value[0], height: value[1] } : undefined);
  return {
    id: item.id,
    kind: item.kind,
    placement: item.placement,
    name: item.name,
    description: item.description,
    embedPath: item.embed,
    permissions: item.permissions ?? [],
    defaultSize: size(item.size?.default),
    minSize: size(item.size?.min),
    maxSize: size(item.size?.max),
    refreshInterval: item.refresh,
    settingsSchema: (item.settings ?? []).map((field) => ({ ...field })),
    triggers: item.triggers ?? [],
  };
}

/** Every `${secret.<name>}` the app or its setup files use. */
function referencedSecrets(parsed: ParsedApp): string[] {
  const names = new Set<string>();
  const scan = (value: unknown, top: boolean): void => {
    if (typeof value === 'string') {
      for (const name of variableReferences(value)) {
        const match = /^secret\.([a-z0-9_]{1,40})$/.exec(name);
        if (match) names.add(match[1]);
      }
    } else if (Array.isArray(value)) {
      value.forEach((item) => scan(item, false));
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (key.startsWith('x-') || (top && key === 'listing')) continue;
        scan(item, false);
      }
    }
  };
  scan(parsed.app, true);
  for (const setup of parsed.setups) scan(setup.setup, true);
  return [...names];
}

function secrets(parsed: ParsedApp, database: boolean): SecretSpec[] {
  const declared = parsed.app.secrets ?? {};
  const names = new Set<string>(Object.keys(declared));
  for (const name of referencedSecrets(parsed)) names.add(name);
  for (const credential of parsed.app.credentials ?? []) names.add(credential.password);
  if (database) names.add('db_password');
  const generator = { password: 'password', key: 'secretKey', hex: 'hexToken' } as const;
  return [...names].sort().map((name) => {
    const spec = declared[name] ?? {};
    return {
      name,
      file: `secrets/${name}`,
      generator: generator[spec.kind ?? 'password'],
      length: spec.length ?? DEFAULT_SECRET_LENGTH,
    };
  });
}

export function compileApp(parsed: ParsedApp): AppManifest {
  const { app } = parsed;
  const native = Boolean(app.source);
  const network = app.internet ? 'internet' as const : 'isolated' as const;
  const sidecars = app.sidecars ?? [];
  const containerCount = 1 + sidecars.length;

  const main: ContainerSpec = {
    name: 'main',
    type: native ? 'lxd' : 'oci',
    primary: true,
    image: app.image ?? NATIVE_BASE_IMAGE,
    port: app.port,
    command: app.command ? quoteArgv(app.command) : undefined,
    environment: {},
    volumes: volumes(app.data, app.shared),
    healthCheck: health(app.health),
    source: app.source ? { node: app.source.node } : undefined,
    network,
  };
  // Sidecars (database, cache, workers) come first, in their declared order, and
  // `main` last: the engine creates, starts and health-checks containers in this
  // order, and main's health check usually needs its sidecars (Immich cannot
  // start before its Postgres resolves). Code that needs main uses `primary`.
  const containers: ContainerSpec[] = [...sidecars.map((sidecar): ContainerSpec => ({
    name: sidecar.name,
    type: 'oci',
    primary: false,
    image: sidecar.image,
    port: sidecar.port,
    command: sidecar.command ? quoteArgv(sidecar.command) : undefined,
    environment: env(sidecar.env),
    volumes: volumes(sidecar.data),
    healthCheck: health(sidecar.health),
    network,
  })), main];

  const database = (() => {
    const value = app.database;
    if (!value || value === 'none') return { mode: 'none' as const };
    const fallback = app.id.replace(/-/g, '_');
    if (value === 'postgres') return { mode: 'shared' as const, name: fallback, user: fallback };
    if ('postgres' in value) {
      const postgres = value.postgres as { name: string; user: string };
      return { mode: 'shared' as const, name: postgres.name, user: postgres.user };
    }
    const own = value as { sidecar: string; name: string; user?: string };
    return { mode: 'own' as const, container: own.sidecar, name: own.name, user: own.user ?? own.name };
  })();

  const configFiles: ConfigFileSpec[] = (app.files ?? []).map((file) => ({
    container: file.container ?? 'main',
    path: file.path,
    permission: file.mode ? `0o${file.mode.replace(/^0/, '')}` : '0o644',
    directoryPermission: file.dir_mode ? `0o${file.dir_mode.replace(/^0/, '')}` : '0o700',
    template: file.template,
  }));

  const setups: SetupFile[] = parsed.setups.map(({ name, setup }) => ({
    name,
    for: setup.for,
    steps: setup.steps,
    remove: setup.remove,
  }));

  const listing = app.listing ?? {};
  const frozen: FrozenAppSource = {
    schema: 'youeye.frozen-app.v1',
    manifest: parsed.source.manifest,
    setups: { ...parsed.source.setups },
    digest: manifestDigest(parsed.raw, parsed.setups),
  };

  return {
    integration: native ? 'native' : 'basic',
    version: app.version,
    requires: app.requires ? { youeye: app.requires.youeye } : undefined,
    metadata: {
      id: app.id,
      name: app.name,
      description: listing.description ?? listing.tagline ?? app.name,
      icon: listing.icon ?? 'package',
      iconUrl: listing.icon_file,
      category: listing.category ?? 'other',
      website: listing.website,
      developer: listing.developer,
      license: listing.license,
      sourceCode: listing.source_code,
      support: listing.support,
      docs: listing.docs,
      tagline: listing.tagline,
      tags: listing.tags ?? [],
      defaultSubdomain: app.subdomain ?? app.id,
    },
    database,
    data_ownership: app.data_ownership ? { per_user: app.data_ownership.per_user } : undefined,
    env_mapping: { ...env(app.env), ...env(app.smtp?.env), ...env(app.ai?.env), ...env(app.sso?.env) },
    containers,
    secrets: secrets(parsed, database.mode !== 'none'),
    credentials: (app.credentials ?? []).map((credential) => ({
      label: credential.label,
      username: credential.username,
      passwordSecret: credential.password,
    })),
    configFiles,
    capabilities: {
      widgets: app.capabilities?.widgets,
      settings_panel: app.capabilities?.settings_panel,
      notifications: app.capabilities?.notifications,
      info_cards: app.capabilities?.info_cards,
      events: app.capabilities?.events,
      smtp: app.smtp ? true : undefined,
      ai_api: app.ai ? true : undefined,
      link_handlers: app.link_handlers?.map((handler) => ({ ...handler, endpoint: handler.endpoint ?? '/' })),
    },
    surfaces: (app.surfaces ?? []).map(surface),
    provides: (app.provides ?? []).map((item) => ({
      type: item.type,
      description: item.description,
      port: item.port,
      scope: item.scope ?? 'user',
    })),
    wants: (app.connects ?? []).map((item) => ({
      appId: item.app,
      type: item.type,
      name: item.name,
      description: item.description,
      defaultPort: item.port,
      proxy: item.proxy ? { paths: item.proxy.paths, methods: item.proxy.methods ?? ['GET'] } : undefined,
      scope: item.scope ?? 'user',
      setup: item.setup,
    })),
    apiKey: app.api_key ? { secret: app.api_key.secret } : undefined,
    internet: {
      proxy: (app.proxy ?? []).map((item) => ({
        host: item.host,
        paths: item.paths,
        methods: item.methods ?? ['GET'],
        scope: item.scope ?? 'user',
      })),
    },
    forwardAuth: app.forward_auth === undefined ? 'default' : app.forward_auth ? 'enabled' : 'disabled',
    publicAccess: app.public_access === true ? true : undefined,
    sso: app.sso ? {
      callback_path: app.sso.callback,
      entry_url: app.sso.entry,
      additional_callbacks: app.sso.extra_callbacks ?? [],
      backchannel_logout_path: app.sso.backchannel_logout,
      admin_group: app.sso.admin_group ?? 'admin',
      role_claim: app.sso.role_claim ? { ...app.sso.role_claim } : undefined,
    } : undefined,
    backup: database.mode === 'own' ? {
      ownPostgres: {
        container: getContainerName(app.id, database.container!, containerCount),
        database: database.name!,
        user: database.user,
      },
    } : undefined,
    detail: {
      longDescription: listing.long_description ?? listing.description ?? app.name,
      releaseNotes: listing.release_notes,
      screenshots: (listing.screenshots ?? []).map((item) => ({ path: item.path, caption: item.caption })),
    },
    api: app.api ? { ...app.api } : undefined,
    setups,
    frozen,
  };
}

/** Parse (strict unless `lenient`) and compile an app with its setup files. */
export function loadApp(source: AppSource, options: ParseOptions = {}): AppManifest {
  return compileApp(parseAppSource(source, options));
}

/** The installed app's model from its frozen copy (lenient: structure only). */
export function loadFrozenApp(frozen: Pick<FrozenAppSource, 'manifest' | 'setups' | 'version'>): AppManifest {
  const manifest = loadApp({ manifest: frozen.manifest, setups: frozen.setups }, { lenient: true });
  if (frozen.version) {
    manifest.version = frozen.version;
    manifest.frozen!.version = frozen.version;
  }
  return manifest;
}

/** Parse and compile an app whose setup files `read` fetches by name (null: no such file). */
export async function fetchApp(
  manifest: string,
  read: (name: string) => Promise<string | null>,
  options: ParseOptions = {},
): Promise<AppManifest> {
  return compileApp(await readAppSource(manifest, read, options));
}
