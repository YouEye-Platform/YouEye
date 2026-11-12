import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The build's version comes only from env YOUEYE_VERSION (X.Y.Z-rc.N), set by
// the release tooling. package.json carries a fixed placeholder. The packaged
// application root gets version.json next to server.js; Spine and the app read it.
const version = process.env.YOUEYE_VERSION?.trim();
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[1-9]\d*)?$/.test(version)) {
  console.error(`YOUEYE_VERSION must be set to the build version (X.Y.Z-rc.N); got ${JSON.stringify(process.env.YOUEYE_VERSION ?? '')}`);
  process.exit(1);
}
if (process.argv.includes('--check')) process.exit(0);
function findApp(root, depth = 0) {
  if (existsSync(join(root, 'server.js'))) return [root];
  if (depth >= 4) return [];
  return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'node_modules' && e.name !== '.next')
    .flatMap((e) => findApp(join(root, e.name), depth + 1));
}
const roots = findApp(resolve(process.argv[2] || '.next/standalone'));
if (roots.length !== 1) throw new Error('Expected exactly one standalone application entrypoint');
writeFileSync(join(roots[0], 'version.json'), JSON.stringify({ version }) + '\n');
console.log(`Wrote version.json (${version})`);
