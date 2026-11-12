/**
 * The one parser for app formats. YAML is read with aliases refused, duplicate keys refused,
 * a 1 MiB cap and `__proto__`/`constructor`/`prototype` keys refused anywhere.
 *
 * - Strict (default): schema, image pinning and every `${…}` checked against the variable
 *   registry for the place it is used in.
 * - Lenient (frozen installed copies): structure only; no variable or pinning checks.
 */

import { isMap, isScalar, isSeq, parseDocument, type Node as YAMLNode } from 'yaml';
import type { z } from 'zod/v4';
import {
  AppSchema, BundleSchema, CatalogIndexSchema, CatalogSchema, PINNED_IMAGE, SetupSchema, SystemAppSchema,
  type AppDocument, type BundleDocument, type CatalogDocument, type CatalogIndexDocument, type SetupDocument,
  type SystemAppDocument,
} from './schema';
import { checkVariable, variableReferences, type VariableScope } from './variables';

export const MAX_DOCUMENT_BYTES = 1024 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class AppFormatError extends Error {
  readonly issues: string[];
  constructor(what: string, issues: string[]) {
    super(`${what}: ${issues.slice(0, 8).join('; ')}${issues.length > 8 ? ` (+${issues.length - 8} more)` : ''}`);
    this.name = 'AppFormatError';
    this.issues = issues;
  }
}

export interface ParseOptions {
  /** Frozen installed copies: structure only. */
  lenient?: boolean;
  /** Tests and development only: accept image tags that are not digest-pinned. */
  allowUnpinned?: boolean;
}

/** Safe YAML (or JSON, which is YAML) to plain data. */
export function readYAML(text: string, what = 'document'): unknown {
  if (typeof text !== 'string') throw new AppFormatError(what, ['is not text']);
  if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES) throw new AppFormatError(what, ['is larger than 1 MiB']);
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false, merge: false });
  if (doc.errors.length > 0) throw new AppFormatError(what, doc.errors.map((error) => error.message.split('\n')[0]));
  const forbidden: string[] = [];
  const visit = (node: unknown, path: string) => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = isScalar(pair.key) ? String(pair.key.value) : '';
        if (FORBIDDEN_KEYS.has(key)) forbidden.push(`${path || '<root>'}: key "${key}" is not allowed`);
        visit(pair.value, path ? `${path}.${key}` : key);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, index) => visit(item, `${path}[${index}]`));
    }
  };
  visit(doc.contents as YAMLNode | null, '');
  if (forbidden.length > 0) throw new AppFormatError(what, forbidden);
  try {
    return doc.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new AppFormatError(what, [error instanceof Error ? error.message : 'YAML aliases are not allowed']);
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.length ? issue.path.join('.') : '<root>'}: ${issue.message}`);
}

function validate<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new AppFormatError(what, formatIssues(result.error));
  return result.data;
}

/** Every string value under `value`, with its path; `x-` keys and the listing are skipped. */
function* strings(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === 'string') {
    yield [path, value];
  } else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* strings(item, `${path}[${index}]`);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith('x-') || (path === '' && key === 'listing')) continue;
      // Keys of free-form maps may hold variables too (rare, but checked).
      yield* strings(key.includes('${') ? key : undefined, path ? `${path}.${key}` : key);
      yield* strings(item, path ? `${path}.${key}` : key);
    }
  }
}

function checkVariables(value: unknown, scope: VariableScope): string[] {
  const issues: string[] = [];
  for (const [path, text] of strings(value, '')) {
    for (const name of variableReferences(text)) {
      const problem = checkVariable(name, scope);
      if (problem) issues.push(`${path || '<root>'}: ${problem}`);
    }
  }
  return issues;
}

export function variableScope(app: AppDocument, setupFor?: string): VariableScope {
  return {
    sidecars: new Map((app.sidecars ?? []).map((sidecar) => [sidecar.name, { port: sidecar.port }])),
    database: Boolean(app.database && app.database !== 'none'),
    sso: Boolean(app.sso),
    smtp: Boolean(app.smtp),
    ai: Boolean(app.ai),
    setupFor,
  };
}

// ─── Public parsers ───────────────────────────────────────

export function parseApp(text: string, options: ParseOptions = {}): AppDocument {
  const app = validate(AppSchema, readYAML(text, 'youeye-app.yaml'), 'youeye-app.yaml');
  if (options.lenient) return app;
  const issues: string[] = [];
  const images = [
    ['image', app.image],
    ...(app.sidecars ?? []).map((sidecar, index) => [`sidecars[${index}].image`, sidecar.image]),
  ] as const;
  if (!options.allowUnpinned) {
    for (const [path, image] of images) {
      if (image && !PINNED_IMAGE.test(image)) issues.push(`${path}: image must be pinned by digest (@sha256:…)`);
    }
  }
  issues.push(...checkVariables(app, variableScope(app)));
  if (app.api_key && !appSecretNames(app).has(app.api_key.secret)) {
    issues.push(`api_key.secret: "${app.api_key.secret}" is not a secret of this app (declare it under secrets: or use \${secret.${app.api_key.secret}})`);
  }
  if (issues.length > 0) throw new AppFormatError('youeye-app.yaml', issues);
  return app;
}

/** The secrets a manifest declares (`secrets:`, `credentials[].password`) or uses (`${secret.<name>}`). */
export function appSecretNames(app: AppDocument): Set<string> {
  const names = new Set<string>(Object.keys(app.secrets ?? {}));
  for (const credential of app.credentials ?? []) names.add(credential.password);
  for (const [, text] of strings(app, '')) {
    for (const name of variableReferences(text)) {
      const match = /^secret\.([a-z0-9_]{1,40})$/.exec(name);
      if (match) names.add(match[1]);
    }
  }
  return names;
}

export interface ParseSetupOptions extends ParseOptions {
  /** The app the setup file belongs to; required for variable checks in strict mode. */
  app?: AppDocument;
  /** File name for messages, e.g. `setup/sso.yaml`. */
  name?: string;
}

export function parseSetup(text: string, options: ParseSetupOptions = {}): SetupDocument {
  const what = options.name ?? 'setup file';
  const setup = validate(SetupSchema, readYAML(text, what), what);
  if (options.lenient) return setup;
  const issues: string[] = [];
  if (options.app) {
    issues.push(...checkVariables({ steps: setup.steps, remove: setup.remove }, variableScope(options.app, setup.for)));
    const containers = new Set(['main', ...(options.app.sidecars ?? []).map((sidecar) => sidecar.name)]);
    const steps = [...setup.steps, ...(setup.remove ?? [])];
    for (const step of steps) {
      const container = 'restart' in step ? step.restart
        : 'http' in step ? step.http.container
          : 'exec' in step ? step.exec.container
            : 'file' in step ? step.file.container
              : 'wait' in step ? step.wait.container : undefined;
      if (container && !containers.has(container)) issues.push(`${what}: unknown container "${container}"`);
      if ('http' in step && step.http.target === 'peer' && !setup.for.startsWith('connect:')) {
        issues.push(`${what}: target: peer is only allowed in connect:<app> files`);
      }
    }
  }
  if (issues.length > 0) throw new AppFormatError(what, issues);
  return setup;
}

export function parseBundle(text: string): BundleDocument {
  return validate(BundleSchema, readYAML(text, 'bundle.yaml'), 'bundle.yaml');
}

export function parseSystemApp(text: string, options: ParseOptions = {}): SystemAppDocument {
  const app = validate(SystemAppSchema, readYAML(text, 'system app'), 'system app');
  if (!options.lenient && !options.allowUnpinned && !PINNED_IMAGE.test(app.image)) {
    throw new AppFormatError('system app', ['image: image must be pinned by digest (@sha256:…)']);
  }
  return app;
}

export function parseCatalog(text: string): CatalogDocument {
  return validate(CatalogSchema, readYAML(text, 'catalog.yaml'), 'catalog.yaml');
}

export function parseCatalogIndex(text: string): CatalogIndexDocument {
  return validate(CatalogIndexSchema, readYAML(text, 'catalog.json'), 'catalog.json');
}

// ─── App package (manifest + setup files) ─────────────────

export interface AppSource {
  /** `youeye-app.yaml` text. */
  manifest: string;
  /** Setup file name (`setup/<name>.yaml`) → text. */
  setups?: Record<string, string>;
}

export interface ParsedApp {
  app: AppDocument;
  /** Raw data (for the digest). */
  raw: unknown;
  setups: Array<{ name: string; setup: SetupDocument; raw: unknown }>;
  source: { manifest: string; setups: Record<string, string> };
}

/** Setup files for purposes other than connections are named after their purpose. */
export const PURPOSE_SETUP_FILES = ['setup/sso.yaml', 'setup/install.yaml', 'setup/url-change.yaml'] as const;

/**
 * Every setup file an app can have: `setup/<for>.yaml` for sso, install and url-change,
 * plus the files its `connects[].setup` name. Sources that cannot list folders fetch these.
 */
export function setupFileNames(app: AppDocument): string[] {
  const names = new Set<string>(PURPOSE_SETUP_FILES);
  for (const connect of app.connects ?? []) if (connect.setup) names.add(connect.setup);
  return [...names];
}

/**
 * Parse an app with its setup files and check the references between them:
 * a `for: sso|install|url-change` file is named `setup/<for>.yaml`; a `for: connect:<app>`
 * file is named by a `connects[].setup` for that app; no other files exist.
 */
export function parseAppSource(source: AppSource, options: ParseOptions = {}): ParsedApp {
  const app = parseApp(source.manifest, options);
  const raw = readYAML(source.manifest, 'youeye-app.yaml');
  const setupTexts = source.setups ?? {};
  const issues: string[] = [];
  const setups: ParsedApp['setups'] = [];
  for (const name of Object.keys(setupTexts).sort()) {
    if (!/^setup\/[a-z0-9][a-z0-9-]{0,62}\.yaml$/.test(name)) {
      issues.push(`${name}: setup files are named setup/<name>.yaml`);
      continue;
    }
    const setup = parseSetup(setupTexts[name], { ...options, app, name });
    if (setup.for.startsWith('connect:')) {
      const peer = setup.for.slice('connect:'.length);
      if (!(app.connects ?? []).some((connect) => connect.setup === name && connect.app === peer)) {
        issues.push(`${name}: no connects entry for app "${peer}" names this file`);
      }
    } else if (name !== `setup/${setup.for}.yaml`) {
      issues.push(`${name}: a for: ${setup.for} file is named setup/${setup.for}.yaml`);
    }
    setups.push({ name, setup, raw: readYAML(setupTexts[name], name) });
  }
  for (const [index, connect] of (app.connects ?? []).entries()) {
    if (connect.setup && !setups.some((item) => item.name === connect.setup)) {
      issues.push(`connects[${index}].setup: ${connect.setup} does not exist`);
    }
    if (connect.setup && !connect.app) issues.push(`connects[${index}].setup: only connections to an app have a setup file`);
  }
  if (issues.length > 0) throw new AppFormatError(app.id, issues);
  return { app, raw, setups, source: { manifest: source.manifest, setups: { ...setupTexts } } };
}

/** Fetch an app's setup files with `read` (null when a file does not exist) and parse it all. */
export async function readAppSource(
  manifest: string,
  read: (name: string) => Promise<string | null>,
  options: ParseOptions = {},
): Promise<ParsedApp> {
  const app = parseApp(manifest, options);
  const setups: Record<string, string> = {};
  for (const name of setupFileNames(app)) {
    const text = await read(name);
    if (text !== null) setups[name] = text;
  }
  return parseAppSource({ manifest, setups }, options);
}
