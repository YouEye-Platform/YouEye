#!/usr/bin/env node
// payload-guard.mjs <standalone.tar>
//
// Fails a Control Panel or UI build whose server would write into its own
// installed tree. The update check verifies that tree against what was shipped,
// so any file the server adds or changes there can refuse a later update.
//
//  (a) .next/required-server-files.json must carry isrFlushToDisk: false.
//  (b) A copy of the packaged tree is started as an unprivileged user (state in
//      a temporary directory, NEXT_PHASE=phase-production-build so
//      instrumentation starts no background jobs), every prerendered route plus
//      /favicon.ico, /manifest.webmanifest, the icon routes and the sign-in
//      pages the build has are requested, the server is stopped, and the copy
//      must be byte-for-byte what was packaged. No directory is exempt.
//      /favicon.ico and /manifest.webmanifest must answer 200 (signed out) when
//      the tree ships them (a public/ file or a prerendered route).
//      The request proxy (middleware) of the Control Panel calls its own server
//      at http://localhost:3000; such a fixed loopback port is where the copy
//      listens, and only when nothing on this machine listens there, so the
//      run never reaches a real local service.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Public metadata files: requested always; 200 is required when the tree ships them.
const METADATA_ROUTES = ['/favicon.ico', '/manifest.webmanifest'];
const READY_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SETTLE_MS = 2_000;

const fail = (message) => {
  console.error(`payload-guard: FAILED: ${message}`);
  process.exit(1);
};
const log = (message) => console.log(`payload-guard: ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tarPath = process.argv[2];
if (!tarPath || process.argv.length !== 3) fail('usage: payload-guard.mjs <standalone.tar>');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${result.status ?? result.signal}`);
}

// The server runs as `nobody` when the build runs as root (the tree and its
// state are handed to that user, so a write would succeed and be seen), and
// as the build user otherwise.
function serverUser() {
  if (process.getuid() !== 0) return null;
  const entry = readFileSync('/etc/passwd', 'utf8').split('\n').map((line) => line.split(':')).find((f) => f[0] === 'nobody');
  if (!entry) fail('user nobody does not exist');
  return { uid: Number(entry[2]), gid: Number(entry[3]) };
}

function listing(root) {
  const entries = new Map();
  const walk = (relative) => {
    const absolute = join(root, relative);
    const stat = lstatSync(absolute);
    const mode = (stat.mode & 0o7777).toString(8);
    if (stat.isSymbolicLink()) {
      entries.set(relative, `link ${readlinkSync(absolute)}`);
    } else if (stat.isDirectory()) {
      entries.set(relative, `dir ${mode}`);
      for (const name of readdirSync(absolute).sort()) walk(relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) {
      const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
      entries.set(relative, `file ${mode} ${stat.size} ${digest}`);
    } else {
      entries.set(relative, `other ${stat.mode.toString(8)}`);
    }
  };
  walk('');
  return entries;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Nothing listens on this port on 127.0.0.1 or ::1 (a family this host lacks counts as free).
async function portIsFree(port) {
  for (const host of ['127.0.0.1', '::1']) {
    const free = await new Promise((resolve) => {
      const probe = createServer();
      probe.once('error', (error) => resolve(error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT'));
      probe.listen(port, host, () => probe.close(() => resolve(true)));
    });
    if (!free) return false;
  }
  return true;
}

// Loopback ports the request proxy (middleware) calls with a fixed URL: it runs on every request made here.
function proxyLoopbackPorts(root) {
  const ports = new Set();
  for (const file of ['.next/server/middleware.js', '.next/server/proxy.js']) {
    let text;
    try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    for (const match of text.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})\b/g)) ports.add(Number(match[1]));
  }
  return [...ports].sort((a, b) => a - b);
}

// The port to serve the copy on: the proxy's own fixed port when it has one (its calls then reach this copy), else
// any free port. A fixed port another process holds fails the guard: the copy would talk to a real local service.
async function choosePort(selfPorts) {
  for (const port of selfPorts) {
    if (!(await portIsFree(port))) {
      fail(`port ${port} is in use on this machine. The packaged request proxy calls http://localhost:${port} itself, `
        + 'so the copy must listen there and nothing else may; stop the service on that port and build again.');
    }
  }
  return selfPorts[0] ?? await freePort();
}

async function request(base, path) {
  const response = await fetch(new URL(path, base), { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  await response.arrayBuffer();
  return response.status;
}

const user = serverUser();
// A world-traversable parent, so `nobody` can reach the copy.
const work = mkdtempSync(join(user ? '/var/tmp' : tmpdir(), 'youeye-payload-guard.'));
let server = null;
const cleanup = () => {
  if (server && server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  rmSync(work, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(1));

const tree = join(work, 'tree');
const state = join(work, 'state');
for (const dir of [tree, join(state, 'home'), join(state, 'tmp')]) mkdirSync(dir, { recursive: true });
run('tar', ['--no-same-owner', '-xf', tarPath, '-C', tree]);

// (a) The built configuration.
let required;
try {
  required = JSON.parse(readFileSync(join(tree, '.next/required-server-files.json'), 'utf8'));
} catch (error) {
  fail(`.next/required-server-files.json is unreadable: ${error.message}`);
}
const flush = required?.config?.experimental?.isrFlushToDisk;
if (flush !== false) {
  fail(`.next/required-server-files.json has experimental.isrFlushToDisk=${JSON.stringify(flush)}; next.config must set it to false`);
}
log('required-server-files.json has isrFlushToDisk: false');

// (b) Run a copy and compare it before and after.
let prerendered;
try {
  prerendered = Object.keys(JSON.parse(readFileSync(join(tree, '.next/prerender-manifest.json'), 'utf8')).routes ?? {});
} catch (error) {
  fail(`.next/prerender-manifest.json is unreadable: ${error.message}`);
}
// The icon routes and the sign-in pages the build has (extra requests; any status).
let appRoutes = [];
try {
  appRoutes = Object.entries(JSON.parse(readFileSync(join(tree, '.next/app-path-routes-manifest.json'), 'utf8')))
    .filter(([entry, route]) => !route.includes('[') && !route.startsWith('/api/')
      && (/^\/(icon|apple-icon)$/.test(route) || entry.endsWith('/page') && /\/(login|sign-in|signin)$/.test(route)))
    .map(([, route]) => route);
} catch { /* no app routes manifest: no extras */ }
const mustAnswer200 = METADATA_ROUTES.filter((route) => prerendered.includes(route) || existsSync(join(tree, 'public', route)));
const routes = [...new Set([...prerendered, ...METADATA_ROUTES, ...appRoutes])].sort();
const runtime = join(tree, '.youeye-runtime/node');
try {
  lstatSync(runtime);
} catch {
  fail('the packaged tree has no .youeye-runtime/node');
}
if (user) run('chown', ['-R', `${user.uid}:${user.gid}`, work]);
const before = listing(tree);
log(`packaged tree: ${before.size} entries; server runs as ${user ? 'nobody' : 'the build user'}`);

const selfPorts = proxyLoopbackPorts(tree);
if (selfPorts.length) log(`the request proxy calls loopback port(s) ${selfPorts.join(', ')}; the copy listens on ${selfPorts[0]}`);

let base;
let logPath;
const serverLog = () => readFileSync(logPath, 'utf8').split('\n').slice(-40).join('\n');

async function stopServer() {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  const stopped = await Promise.race([
    new Promise((resolve) => server.once('exit', () => resolve(true))),
    sleep(15_000).then(() => false),
  ]);
  if (!stopped) {
    server.kill('SIGKILL');
    await new Promise((resolve) => server.once('exit', resolve));
  }
}

// Start the copy on a port; null once it answers, else why it did not.
async function startServer(attempt) {
  const port = await choosePort(selfPorts);
  base = `http://127.0.0.1:${port}`;
  logPath = join(work, `server-${attempt}.log`);
  const logFd = openSync(logPath, 'w');
  server = spawn(runtime, ['server.js'], {
    cwd: tree,
    stdio: ['ignore', logFd, logFd],
    ...(user ?? {}),
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: join(state, 'home'),
      TMPDIR: join(state, 'tmp'),
      LANG: 'C.UTF-8',
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PHASE: 'phase-production-build',
      HOSTNAME: '127.0.0.1',
      PORT: String(port),
    },
  });
  closeSync(logFd);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (server.exitCode !== null || server.signalCode !== null) {
      return `the server on port ${port} exited before it answered (${server.exitCode ?? server.signalCode})`;
    }
    try {
      await request(base, METADATA_ROUTES[0]);
      return null;
    } catch {
      if (Date.now() > deadline) {
        await stopServer();
        return `the server on port ${port} did not answer within ${READY_TIMEOUT_MS / 1000}s`;
      }
      await sleep(250);
    }
  }
}

// A port taken meanwhile or a slow first start: one more try (on another port when the port is not fixed).
let problem = await startServer(1);
if (problem) {
  log(`${problem}; trying once more. Server log:\n${serverLog()}`);
  problem = await startServer(2);
  if (problem) fail(`${problem}. Server log:\n${serverLog()}`);
}

// Twice each: the first read can promote a build seed, the second can revalidate.
for (const pass of [1, 2]) {
  for (const route of routes) {
    let status;
    try {
      status = await request(base, route);
    } catch (error) {
      fail(`GET ${route} failed: ${error.message}. Server log:\n${serverLog()}`);
    }
    if (pass === 1) log(`GET ${route} -> ${status}${mustAnswer200.includes(route) ? ' (must be 200)' : ''}`);
    if (mustAnswer200.includes(route) && status !== 200) {
      fail(`GET ${route} answered ${status}: the tree ships it, so it must be public and answer 200 without a session`);
    }
  }
}
await sleep(SETTLE_MS);
await stopServer();

const after = listing(tree);
const added = [...after.keys()].filter((path) => !before.has(path));
const changed = [...after.keys()].filter((path) => before.has(path) && before.get(path) !== after.get(path));
const removed = [...before.keys()].filter((path) => !after.has(path));
if (added.length + changed.length + removed.length > 0) {
  const show = (label, paths) => (paths.length ? `\n  ${label}:\n${paths.slice(0, 50).map((p) => `    ${p}`).join('\n')}${paths.length > 50 ? `\n    … and ${paths.length - 50} more` : ''}` : '');
  fail(`the server wrote into its own tree (${added.length} added, ${changed.length} changed, ${removed.length} removed).`
    + ' An installed tree that changes at runtime can refuse a later System update.'
    + show('added', added) + show('changed', changed) + show('removed', removed));
}
log(`OK: ${routes.length} routes requested; the tree is unchanged (${after.size} entries)`);
