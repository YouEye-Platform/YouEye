import { createHash } from 'node:crypto';
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exact public Node release bytes, carried inside the signed application payload.
const version = '24.22.0';
const binarySHA256 = '67ca5783febb8bf85736c79fcdd92c8d6d465a0eb2a082672bcdfa76a506751c';
const licenseSHA256 = '5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace';
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
if (process.platform !== 'linux' || process.arch !== 'x64' || process.version !== `v${version}`) {
  throw new Error(`Standalone release packaging requires the pinned Linux x64 Node ${version} toolchain`);
}
const binary = realpathSync(process.execPath);
const license = join(dirname(fileURLToPath(import.meta.url)), 'node-LICENSE.txt');
if (sha(binary) !== binarySHA256 || sha(license) !== licenseSHA256) {
  throw new Error('Node runtime or retained upstream licence does not match the reviewed toolchain');
}
function findApp(root, depth = 0) {
  if (existsSync(join(root, 'server.js'))) return [root];
  if (depth >= 4) return [];
  return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'node_modules' && e.name !== '.next')
    .flatMap((e) => findApp(join(root, e.name), depth + 1));
}
const roots = findApp(resolve(process.argv[2] || '.next/standalone'));
if (roots.length !== 1) throw new Error('Expected exactly one standalone application entrypoint');
const root = roots[0];
const runtime = join(root, '.youeye-runtime');
mkdirSync(runtime, { recursive: true });
copyFileSync(binary, join(runtime, 'node')); chmodSync(join(runtime, 'node'), 0o755);
copyFileSync(license, join(runtime, 'LICENSE'));
writeFileSync(join(runtime, 'manifest.json'), JSON.stringify({ schema: 'youeye.node-runtime.v1', version, platform: 'linux', architecture: 'x64', binarySHA256, licenseSHA256, source: `https://nodejs.org/dist/v${version}/node-v${version}-linux-x64.tar.xz` }, null, 2) + '\n');
const entry = join(root, 'server.js');
const generated = join(root, 'next-server.cjs');
const marker = '// youeye-pinned-node-launcher-v1';
if (!readFileSync(entry, 'utf8').startsWith(marker)) renameSync(entry, generated);
writeFileSync(entry, `${marker}
// The existing service entrypoint remains compatible with older installed readers.
// Only this launcher runs on the host Node; application code uses the signed runtime.
const { spawn } = require('node:child_process');
const { realpathSync } = require('node:fs');
const { join } = require('node:path');
const runtime = join(__dirname, '.youeye-runtime', 'node');
if (realpathSync(process.execPath) === realpathSync(runtime)) {
  require('./next-server.cjs');
} else {
  const child = spawn(runtime, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
  const terminate = () => child.kill('SIGTERM');
  const interrupt = () => child.kill('SIGINT');
  process.on('SIGTERM', terminate); process.on('SIGINT', interrupt);
  child.once('error', () => { console.error('The signed application runtime could not start'); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    process.removeListener('SIGTERM', terminate); process.removeListener('SIGINT', interrupt);
    if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1;
  });
}
`);
console.log(`Bundled verified Node ${version} and its upstream licence`);
