/**
 * Setup runner: runs an app's `youeye.setup.v1` files (docs/app-manifest.md, "Setup files").
 *
 * Steps run in order: `wait`, `http`, `file`, `exec`, `restart`, `sleep`. The rules the runner
 * enforces (not only the parser):
 * - An `http` URL is always built here as `http://<container address>:<port><path>` for one of
 *   this app's own containers, or the connected app's primary container (`target: peer`, only in
 *   the `connect:<app>` file of the approved connection). Paths are relative; redirects are never
 *   followed; responses are size- and time-limited.
 * - `exec`, `file` and `restart` act on this app's own containers only; `exec` takes argv, never
 *   a shell string.
 * - Saved values, `set` keys, `for_each` items and `${…}` lookups live in null-prototype objects;
 *   `__proto__`, `constructor` and `prototype` are refused anywhere in a key path.
 */

import { isIP } from 'node:net';
import { stringify as stringifyYAML } from 'yaml';
import { isAbsolutePath, isRelativeHttpPath } from './app-format/schema';
import { describeErrorChainForLog } from './install-tracker';
import type { SetupStep } from './app-format/schema';
import type { AppManifest, SetupFile, VariableContext } from './types';

/** What a setup file is for: `sso`, `install`, `url-change` or `connect:<app>`. */
export type SetupPurpose = 'sso' | 'install' | 'url-change' | `connect:${string}`;

// ─── Limits ───────────────────────────────────────────────

export const SETUP_LIMITS = {
  /** A whole setup file run (`steps:` or `remove:`), every step and `for_each` item included. */
  fileMs: 20 * 60_000,
  /** Largest HTTP response body the runner reads. */
  responseBytes: 4 * 1024 * 1024,
  /** One HTTP request, connect to last byte. */
  requestMs: 30_000,
  /** Default `exec` timeout (a step may set `timeout:`). */
  execMs: 60_000,
  /** Default `wait` timeout (a step may set `timeout:`). */
  waitMs: 120_000,
  /** Time between `wait` probes. */
  waitIntervalMs: 2_000,
  /** Most items a `for_each` step acts on. */
  forEachItems: 500,
  /** Deepest saved or generated structure. */
  depth: 64,
} as const;

// ─── Transport ────────────────────────────────────────────

export interface SetupHttpRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
}

export interface SetupHttpResponse {
  status: number;
  body: string;
}

/** How the runner reaches containers. Production uses Incus (`setup-transport.ts`); tests fake it. */
export interface SetupTransport {
  /**
   * The IPv4 address of a runtime container on app `network`'s bridge (on `iface` when given, else
   * `eth0`). Never trust what the container reports: production uses `appContainerAddress`.
   */
  address(container: string, network: string, iface?: string): Promise<string>;
  /** One HTTP request. Must never follow a redirect and must enforce `maxBytes` and `timeoutMs`. */
  fetch(url: string, request: SetupHttpRequest): Promise<SetupHttpResponse>;
  /** Run argv in a container (no shell). */
  exec(container: string, argv: string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Write a file into a container (parents created). `mode` is four octal digits. */
  writeFile(container: string, path: string, data: Buffer, mode: string): Promise<void>;
  restart(container: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** The clock the file deadline is measured with (default `Date.now`). */
  now?(): number;
}

/** fetch() for the runner: `redirect: 'manual'`, a deadline, and a body size cap. */
export async function cappedFetch(url: string, request: SetupHttpRequest): Promise<SetupHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('request timed out')), request.timeoutMs);
  try {
    const response = await fetch(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
      signal: controller.signal,
    });
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > request.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`response is larger than ${request.maxBytes} bytes`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > request.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`response is larger than ${request.maxBytes} bytes`);
      }
      chunks.push(value);
    }
    return { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
  } finally {
    clearTimeout(timer);
  }
}

async function defaultTransport(): Promise<SetupTransport> {
  const { incusSetupTransport } = await import('./setup-transport');
  return incusSetupTransport;
}

// ─── Context ──────────────────────────────────────────────

export interface SetupPeer {
  /** The connected app; must equal the `<app>` of the file's `connect:<app>`. */
  appId: string;
  /** The connected app's primary runtime container. */
  container: string;
  port: number;
}

export interface SetupRunContext {
  appId: string;
  /** Runtime container name per logical container (`main`, sidecar names). */
  containers: Record<string, string>;
  /** Resolved values for the setup file's `${…}` variables (`peer`/`self` in connect files). */
  variables: Partial<VariableContext>;
  /** `connect:<app>` files of an approved connection: the connected app (for `target: peer`). */
  peer?: SetupPeer;
  /** Run the file's `remove:` steps instead of `steps:` (e.g. turning SSO off). */
  remove?: boolean;
  onProgress?: (message: string) => void;
  /** Defaults to the Incus transport. */
  transport?: SetupTransport;
}

/** The setup file ran past `SETUP_LIMITS.fileMs`; never skipped by `allow_failure`. */
export class SetupDeadlineError extends Error {
  constructor() {
    super(`the setup file ran longer than ${SETUP_LIMITS.fileMs / 60_000} minutes`);
    this.name = 'SetupDeadlineError';
  }
}

export class SetupStepError extends Error {
  constructor(readonly file: string, readonly step: number, readonly kind: string, message: string) {
    super(`${file} step ${step} (${kind}): ${message}`);
    this.name = 'SetupStepError';
  }
}

/** The app's setup file for `purpose`, if it has one. */
export function setupFor(manifest: Pick<AppManifest, 'setups'>, purpose: SetupPurpose): SetupFile | undefined {
  return manifest.setups.find((setup) => setup.for === purpose);
}

// ─── Safe data ────────────────────────────────────────────

type Data = Record<string, unknown>;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertSafeKey(key: string, where: string): void {
  if (FORBIDDEN_KEYS.has(key)) throw new Error(`${where}: the key "${key}" is not allowed`);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isObject(value: unknown): value is Data {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A deep copy into null-prototype objects; refuses forbidden keys at any depth. */
export function safeClone(value: unknown, where: string, depth = 0): unknown {
  if (depth > SETUP_LIMITS.depth) throw new Error(`${where}: nested too deeply`);
  if (Array.isArray(value)) return value.map((item) => safeClone(item, where, depth + 1));
  if (isObject(value)) {
    const copy: Data = Object.create(null);
    for (const key of Object.keys(value)) {
      assertSafeKey(key, where);
      copy[key] = safeClone(value[key], where, depth + 1);
    }
    return copy;
  }
  return value;
}

/** Walk own properties only; refuses forbidden segments. `undefined` when absent. */
export function safeLookup(root: unknown, segments: readonly string[], where: string): unknown {
  let current = root;
  for (const segment of segments) {
    assertSafeKey(segment, where);
    if (current === null || typeof current !== 'object' || !hasOwn(current, segment)) return undefined;
    current = (current as Data)[segment];
  }
  return current;
}

/** Set a dotted key path, creating null-prototype objects; refuses forbidden segments. */
export function safeSet(root: Data, path: string, value: unknown, where: string): void {
  const segments = path.split('.');
  segments.forEach((segment) => assertSafeKey(segment, where));
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (!hasOwn(current, segment) || current[segment] === undefined || current[segment] === null) {
      current[segment] = Object.create(null);
    }
    const next = current[segment];
    if (!isObject(next)) throw new Error(`${where}: "${path}" crosses a value that is not an object`);
    current = next;
  }
  current[segments[segments.length - 1]] = value;
}

/** `$` → []; `data.items[0].id` → ['data', 'items', '0', 'id']. */
function responseSegments(path: string): string[] {
  if (path === '$') return [];
  return path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
}

// ─── Variables ────────────────────────────────────────────

const VARIABLE = () => /\$\{([^}]*)\}/g;

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * Replace `${name}` from `scope`. Strict mode throws on an unknown or non-scalar value; lenient
 * mode (conditions) turns it into ''. A forbidden key segment always throws.
 */
export function interpolate(template: string, scope: Data, lenient = false): string {
  return template.replace(VARIABLE(), (match, raw: string) => {
    const name = raw.trim();
    const value = scalar(safeLookup(scope, name.split('.'), `variable ${match}`));
    if (value === undefined) {
      if (lenient) return '';
      throw new Error(`unresolved variable ${match}`);
    }
    return value;
  });
}

function interpolateDeep(value: unknown, scope: Data, where: string, depth = 0): unknown {
  if (depth > SETUP_LIMITS.depth) throw new Error(`${where}: nested too deeply`);
  if (typeof value === 'string') return interpolate(value, scope);
  if (Array.isArray(value)) return value.map((item) => interpolateDeep(item, scope, where, depth + 1));
  if (isObject(value)) {
    const copy: Data = Object.create(null);
    for (const key of Object.keys(value)) {
      assertSafeKey(key, where);
      copy[key] = interpolateDeep(value[key], scope, where, depth + 1);
    }
    return copy;
  }
  return value;
}

type Condition = { equals?: [string, string]; not_equals?: [string, string]; empty?: string; not_empty?: string };

function conditionHolds(condition: Condition, scope: Data): boolean {
  const value = (text: string) => interpolate(text, scope, true);
  if (condition.equals) return value(condition.equals[0]) === value(condition.equals[1]);
  if (condition.not_equals) return value(condition.not_equals[0]) !== value(condition.not_equals[1]);
  if (condition.empty !== undefined) return value(condition.empty) === '';
  if (condition.not_empty !== undefined) return value(condition.not_empty) !== '';
  throw new Error('a condition has one of equals, not_equals, empty or not_empty');
}

// ─── Serialisers ──────────────────────────────────────────

function iniValue(value: unknown, where: string): string {
  const text = scalar(value);
  if (text === undefined || /[\r\n]/.test(text)) throw new Error(`${where}: INI values are single-line strings, numbers or booleans`);
  return text;
}

function iniKey(key: string, where: string): string {
  if (!/^[^\s=[\]\r\n;#][^=[\]\r\n]*$/.test(key)) throw new Error(`${where}: "${key}" is not a valid INI key`);
  return key;
}

function serializeINI(value: Data, where: string): string {
  const lines: string[] = [];
  const sections: [string, Data][] = [];
  for (const [key, item] of Object.entries(value)) {
    if (isObject(item)) sections.push([key, item]);
    else lines.push(`${iniKey(key, where)}=${iniValue(item, where)}`);
  }
  for (const [name, entries] of sections) {
    if (lines.length) lines.push('');
    lines.push(`[${iniKey(name, where)}]`);
    for (const [key, item] of Object.entries(entries)) lines.push(`${iniKey(key, where)}=${iniValue(item, where)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Null-prototype data → plain objects for serialisers (keys were already checked). */
function plain(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// ─── Runner ───────────────────────────────────────────────

type HttpStep = Extract<SetupStep, { http: unknown }>['http'];
/** `network`: the app whose network the container's address must lie in. */
type Endpoint = { container: string; network: string; port: number; label: string };

function stepKind(step: SetupStep): string {
  return Object.keys(step)[0];
}

function pathForMessage(path: string): string {
  return path.split(/[?#]/, 1)[0];
}

class Run {
  private readonly vars: Data = Object.create(null);
  /** Checked container addresses for this run (cleared by `restart`). */
  private readonly addresses = new Map<string, string>();
  private readonly base: Data = Object.create(null);
  private readonly deadline: number;

  constructor(
    private readonly manifest: Pick<AppManifest, 'setups' | 'containers'>,
    private readonly file: SetupFile,
    private readonly purpose: SetupPurpose,
    private readonly context: SetupRunContext,
    private readonly io: SetupTransport,
  ) {
    for (const [key, value] of Object.entries(context.variables)) {
      if (key === 'vars' || key === 'item') continue;
      assertSafeKey(key, 'variables');
      this.base[key] = value;
    }
    this.base.vars = this.vars;
    this.deadline = this.now() + SETUP_LIMITS.fileMs;
  }

  // ── Time ──

  private now(): number {
    return this.io.now ? this.io.now() : Date.now();
  }

  /** Time left before the file deadline; throws once it has passed. */
  private remaining(): number {
    const left = this.deadline - this.now();
    if (left <= 0) throw new SetupDeadlineError();
    return left;
  }

  private scope(item?: unknown): Data {
    const scope: Data = Object.create(null);
    Object.assign(scope, this.base);
    if (item !== undefined) scope.item = item;
    return scope;
  }

  // ── Containers ──

  private ownContainer(logical = 'main'): string {
    if (!hasOwn(this.context.containers, logical)) throw new Error(`"${logical}" is not a container of ${this.context.appId}`);
    return this.context.containers[logical];
  }

  private ownEndpoint(logical = 'main'): Endpoint {
    const container = this.ownContainer(logical);
    const port = this.manifest.containers.find((spec) => spec.name === logical)?.port;
    if (!port) throw new Error(`container "${logical}" has no port`);
    return { container, network: this.context.appId, port, label: logical };
  }

  private peerEndpoint(step: { container?: string }): Endpoint {
    const peer = this.context.peer;
    const connected = this.purpose.startsWith('connect:') ? this.purpose.slice('connect:'.length) : undefined;
    if (!connected || this.file.for !== this.purpose) throw new Error('target: peer is only allowed in a connect:<app> setup file');
    if (!peer || peer.appId !== connected) throw new Error(`target: peer needs the approved connection to ${connected}`);
    if (step.container) throw new Error('target: peer always uses the connected app\'s primary container');
    return { container: peer.container, network: peer.appId, port: peer.port, label: `peer ${peer.appId}` };
  }

  private endpoint(step: { container?: string; target?: 'peer' }): Endpoint {
    return step.target === 'peer' ? this.peerEndpoint(step) : this.ownEndpoint(step.container);
  }

  // ── HTTP ──

  /** The only place a setup URL is built. */
  private async url(endpoint: Endpoint, path: string, template: string): Promise<string> {
    if (!isRelativeHttpPath(path)) throw new Error(`"${pathForMessage(template)}" is not a path on the app`);
    const key = `${endpoint.network}/${endpoint.container}`;
    const address = this.addresses.get(key) ?? await this.io.address(endpoint.container, endpoint.network);
    const family = isIP(address);
    if (!family) throw new Error(`no IP address for ${endpoint.label}`);
    const origin = `http://${family === 6 ? `[${address}]` : address}:${endpoint.port}`;
    const url = new URL(`${origin}${path}`);
    if (url.origin !== new URL(origin).origin) throw new Error('setup URL left the container');
    this.addresses.set(key, address);
    return url.toString();
  }

  /** `template`: the path as the file wrote it, for messages (the substituted one may hold secrets). */
  private async send(endpoint: Endpoint, method: string, path: string, template: string, headers: Record<string, string>, body?: string, timeoutMs: number = SETUP_LIMITS.requestMs) {
    const url = await this.url(endpoint, path, template);
    return this.io.fetch(url, { method, headers, body, timeoutMs: Math.min(timeoutMs, this.remaining()), maxBytes: SETUP_LIMITS.responseBytes });
  }

  private headers(step: HttpStep, scope: Data): Record<string, string> {
    const headers: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(step.headers ?? {})) {
      const text = interpolate(value, scope);
      if (/[\r\n]/.test(text)) throw new Error(`header ${name} contains a line break`);
      headers[name] = text;
    }
    return headers;
  }

  private body(step: HttpStep, scope: Data, headers: Record<string, string>): string | undefined {
    let value: unknown;
    if (step.body_from || step.set) {
      let base: unknown = Object.create(null);
      if (step.body_from) {
        base = safeLookup(this.vars, step.body_from.split('.'), 'body_from');
        if (base === undefined) throw new Error(`body_from: "${step.body_from}" was not saved by an earlier step`);
        base = safeClone(base, 'body_from');
      }
      for (const [key, item] of Object.entries(step.set ?? {})) {
        if (!isObject(base)) throw new Error('set needs an object to merge into');
        safeSet(base, key, interpolateDeep(item, scope, 'set'), 'set');
      }
      value = base;
    } else if (step.body !== undefined) {
      value = interpolateDeep(step.body, scope, 'body');
    } else {
      return undefined;
    }
    if (typeof value === 'string') return value;
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    return JSON.stringify(value);
  }

  private okStatus(step: { ok?: number[] }, status: number): boolean {
    return step.ok ? step.ok.includes(status) : status >= 200 && status < 300;
  }

  private failure(method: string, path: string, status: number): Error {
    const redirect = status >= 300 && status < 400 ? ' (redirects are not followed)' : '';
    return new Error(`${method} ${pathForMessage(path)} returned HTTP ${status}${redirect}`);
  }

  private parseJSON(body: string, where: string): unknown {
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`${where}: the response is not JSON`);
    }
  }

  private async http(step: HttpStep): Promise<void> {
    const endpoint = this.endpoint(step);
    const method = step.method ?? 'GET';
    let items: unknown[] = [undefined];
    if (step.for_each) items = await this.listItems(step, endpoint);
    for (const item of items) {
      this.remaining();
      const scope = this.scope(item);
      if (step.if && !conditionHolds(step.if, scope)) continue;
      const path = interpolate(step.path, scope);
      const headers = this.headers(step, scope);
      const body = method === 'GET' || method === 'HEAD' ? undefined : this.body(step, scope, headers);
      const response = await this.send(endpoint, method, path, step.path, headers, body);
      if (!this.okStatus(step, response.status)) throw this.failure(method, step.path, response.status);
      if (step.save) this.save(step.save, response.body);
    }
  }

  private save(save: Record<string, string>, body: string): void {
    const json = this.parseJSON(body, 'save');
    for (const [name, path] of Object.entries(save)) {
      assertSafeKey(name, 'save');
      const value = path === '$' ? json : safeLookup(json, responseSegments(path), `save ${name}`);
      if (value === undefined) throw new Error(`save ${name}: the response has no "${path}"`);
      this.vars[name] = safeClone(value, `save ${name}`);
    }
  }

  private async listItems(step: HttpStep, endpoint: Endpoint): Promise<unknown[]> {
    const forEach = step.for_each!;
    const scope = this.scope();
    const path = interpolate(forEach.path, scope);
    const response = await this.send(endpoint, 'GET', path, forEach.path, this.headers(step, scope));
    if (response.status < 200 || response.status >= 300) throw this.failure('GET', forEach.path, response.status);
    const json = this.parseJSON(response.body, 'for_each');
    const list = forEach.items ? safeLookup(json, responseSegments(forEach.items), 'for_each.items') : json;
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) throw new Error('for_each: the list is not an array');
    const where = Object.entries(forEach.where ?? {}).map(([key, expected]) => {
      const segments = key.split('.');
      segments.forEach((segment) => assertSafeKey(segment, 'for_each.where'));
      const text = typeof expected === 'string' ? interpolate(expected, scope) : scalar(expected);
      if (text === undefined) throw new Error(`for_each.where ${key}: compare with a string, number or boolean`);
      return [segments, text] as const;
    });
    const matches = list.filter((item) => where.every(([segments, expected]) =>
      scalar(safeLookup(item, segments, 'for_each.where')) === expected));
    if (matches.length > SETUP_LIMITS.forEachItems) throw new Error(`for_each: more than ${SETUP_LIMITS.forEachItems} items`);
    return matches.map((item) => safeClone(item, 'for_each item'));
  }

  // ── Other steps ──

  private async wait(step: Extract<SetupStep, { wait: unknown }>['wait']): Promise<void> {
    const endpoint = this.ownEndpoint(step.container);
    const path = interpolate(step.http, this.scope());
    const deadline = Math.min(this.deadline, this.now() + (step.timeout ? step.timeout * 1000 : SETUP_LIMITS.waitMs));
    let last = 'no response';
    for (;;) {
      this.remaining();
      try {
        const remaining = Math.max(1, deadline - this.now());
        const response = await this.send(endpoint, 'GET', path, step.http, {}, undefined, Math.min(SETUP_LIMITS.requestMs, remaining));
        if (response.status >= 200 && response.status < 300) return;
        last = `HTTP ${response.status}`;
      } catch (error) {
        if (error instanceof Error && /not a path|not a container|has no port/.test(error.message)) throw error;
        last = error instanceof Error ? error.message : String(error);
      }
      if (this.now() >= deadline) {
        this.remaining();
        throw new Error(`${pathForMessage(step.http)} was not ready in time (${last})`);
      }
      await this.io.sleep(Math.min(SETUP_LIMITS.waitIntervalMs, Math.max(0, deadline - this.now())));
    }
  }

  private async fileStep(step: Extract<SetupStep, { file: unknown }>['file']): Promise<void> {
    const container = this.ownContainer(step.container);
    const scope = this.scope();
    const path = interpolate(step.path, scope);
    if (!isAbsolutePath(path)) throw new Error(`"${step.path}" is not an absolute path`);
    let content: string;
    if (step.json !== undefined) content = `${JSON.stringify(interpolateDeep(step.json, scope, 'json'), null, 2)}\n`;
    else if (step.yaml !== undefined) content = stringifyYAML(plain(interpolateDeep(step.yaml, scope, 'yaml')));
    else if (step.ini !== undefined) content = serializeINI(interpolateDeep(step.ini, scope, 'ini') as Data, 'ini');
    else content = interpolate(step.text ?? '', scope);
    const mode = (step.mode ?? '0644').replace(/^0?/, '0');
    await this.io.writeFile(container, path, Buffer.from(content, 'utf8'), mode);
  }

  private async exec(step: Extract<SetupStep, { exec: unknown }>['exec']): Promise<void> {
    const container = this.ownContainer(step.container);
    const scope = this.scope();
    const argv = step.run.map((arg) => interpolate(arg, scope));
    if (argv.length === 0 || !argv[0]) throw new Error('exec needs a program');
    const result = await this.io.exec(container, argv, Math.min(step.timeout ? step.timeout * 1000 : SETUP_LIMITS.execMs, this.remaining()));
    // Its output is not repeated: it may hold the secrets the command was given.
    if (result.exitCode !== 0) throw new Error(`${step.run[0]} exited with ${result.exitCode}`);
  }

  async step(step: SetupStep): Promise<void> {
    if ('wait' in step) return this.wait(step.wait);
    if ('http' in step) return this.http(step.http);
    if ('file' in step) return this.fileStep(step.file);
    if ('exec' in step) return this.exec(step.exec);
    if ('restart' in step) {
      this.addresses.clear();
      return this.io.restart(this.ownContainer(step.restart));
    }
    if ('sleep' in step) {
      if (step.sleep * 1000 >= this.remaining()) throw new SetupDeadlineError();
      return this.io.sleep(step.sleep * 1000);
    }
    throw new Error('unknown step');
  }

  async run(steps: SetupStep[]): Promise<void> {
    for (const [index, step] of steps.entries()) {
      const kind = stepKind(step);
      this.context.onProgress?.(`${this.file.name}: step ${index + 1}/${steps.length} (${kind})`);
      try {
        this.remaining();
        await this.step(step);
        this.remaining();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const allowFailure = !(error instanceof SetupDeadlineError)
          && (('http' in step && step.http.allow_failure) || ('exec' in step && step.exec.allow_failure));
        if (allowFailure) {
          console.warn(`[setup] ${this.context.appId} ${this.file.name} step ${index + 1} (${kind}) failed (allowed): ${describeErrorChainForLog(error)}`);
          continue;
        }
        throw new SetupStepError(this.file.name, index + 1, kind, message);
      }
    }
  }
}

/**
 * Run the app's setup file for `purpose` (its `remove:` steps with `context.remove`). An app
 * without such a file, or without `remove:` steps when removing, is a no-op (returns false).
 * A failing step throws `SetupStepError` unless the step has `allow_failure`.
 */
export async function runSetup(
  manifest: Pick<AppManifest, 'setups' | 'containers'>,
  purpose: SetupPurpose,
  context: SetupRunContext,
): Promise<boolean> {
  const file = setupFor(manifest, purpose);
  if (!file) return false;
  const steps = context.remove ? file.remove ?? [] : file.steps;
  if (steps.length === 0) return false;
  const io = context.transport ?? await defaultTransport();
  await new Run(manifest, file, purpose, context, io).run(steps);
  return true;
}
