/**
 * Build script for connector-runtime.
 * Creates a standalone directory ready for tar + deploy.
 * No bundler needed — plain Node.js ESM modules.
 */

import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'dist');
const STANDALONE = join(__dirname, '.standalone');

// Clean
rmSync(DIST, { recursive: true, force: true });
rmSync(STANDALONE, { recursive: true, force: true });

// Copy source files to dist
mkdirSync(join(DIST, 'transforms'), { recursive: true });
mkdirSync(join(DIST, 'security'), { recursive: true });

const files = [
  'src/server.mjs',
  'src/proxy.mjs',
  'src/health.mjs',
  'src/manifests.mjs',
  'src/ui-assets.mjs',
  'src/transforms/json-map.mjs',
  'src/transforms/script.mjs',
  'src/security/ssrf.mjs',
  'src/security/rate-limit.mjs',
];

for (const file of files) {
  const dest = file.replace('src/', '');
  cpSync(join(__dirname, file), join(DIST, dest));
}

// Copy package.json (for runtime metadata)
cpSync(join(__dirname, 'package.json'), join(DIST, 'package.json'));

// Build standalone directory: dist + production node_modules
mkdirSync(STANDALONE, { recursive: true });
cpSync(DIST, STANDALONE, { recursive: true });

// Install production dependencies in standalone
writeFileSync(join(STANDALONE, 'package.json'), readFileSync(join(__dirname, 'package.json')));
execSync('npm install --omit=dev --no-package-lock', {
  cwd: STANDALONE,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' },
});

console.log('[build] Standalone directory ready at .standalone/');
console.log('[build] To create tarball: cd .standalone && tar -cf ../standalone.tar .');
