import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// version.json identifies the build by its line and git tree only:
// `version` from env YOUEYE_LINE (X.Y.Z, the line in VERSION) and
// `source_tree` from env YOUEYE_SOURCE_TREE (the build's git tree, which Spine
// compares with the release member). Both are set by the release tooling
// (.youeye/build/lib.sh). Since 0.6.13 no build name (X.Y.Z-dev.N) is baked in:
// the release document names the build, on each channel under its own name, and
// a box shows its installed release's version. package.json carries a fixed
// placeholder. The packaged application root gets version.json next to server.js.
const version = process.env.YOUEYE_LINE?.trim();
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  console.error(`YOUEYE_LINE must be set to the release line (X.Y.Z); got ${JSON.stringify(process.env.YOUEYE_LINE ?? '')}`);
  process.exit(1);
}
const sourceTree = process.env.YOUEYE_SOURCE_TREE?.trim();
if (!sourceTree || !/^[0-9a-f]{40}$/.test(sourceTree)) {
  console.error(`YOUEYE_SOURCE_TREE must be set to the build's 40-character git tree; got ${JSON.stringify(process.env.YOUEYE_SOURCE_TREE ?? '')}`);
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
writeFileSync(join(roots[0], 'version.json'), JSON.stringify({ version, source_tree: sourceTree }) + '\n');
console.log(`Wrote version.json (${version}, tree ${sourceTree})`);
