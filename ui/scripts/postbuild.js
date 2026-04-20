/**
 * Post-build script for YE-UI
 *
 * Handles:
 * 1. Copy .next/static to standalone folder (CSS, JS chunks)
 * 2. Copy public folder to standalone folder (fonts, icons)
 * 3. Fix pnpm node_modules structure for deployment
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const standalonePath = path.join(rootDir, '.next', 'standalone');
const staticSrc = path.join(rootDir, '.next', 'static');
const staticDest = path.join(standalonePath, '.next', 'static');
const publicSrc = path.join(rootDir, 'public');
const publicDest = path.join(standalonePath, 'public');

function copyRecursive(src, dest, resolveSymlinks = false) {
  if (!fs.existsSync(src)) {
    console.log(`Source does not exist: ${src}`);
    return;
  }

  let stat = resolveSymlinks ? fs.statSync(src) : fs.lstatSync(src);

  if (fs.lstatSync(src).isSymbolicLink() && resolveSymlinks) {
    const realPath = fs.realpathSync(src);
    stat = fs.statSync(realPath);
    src = realPath;
  }

  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    const items = fs.readdirSync(src);
    for (const item of items) {
      copyRecursive(path.join(src, item), path.join(dest, item), resolveSymlinks);
    }
  } else if (stat.isSymbolicLink()) {
    const realPath = fs.realpathSync(src);
    copyRecursive(realPath, dest, true);
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// Step 1: Merge static assets (fonts, build manifests) WITHOUT overwriting existing files.
// Next.js standalone already generates a correct .next/static with matching chunk hashes.
// Overwriting it with the build .next/static breaks the server's internal file allowlist.
console.log('Merging .next/static into standalone (preserving existing files)...');
function mergeDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const items = fs.readdirSync(src);
  for (const item of items) {
    const srcPath = path.join(src, item);
    const destPath = path.join(dest, item);
    const stat = fs.lstatSync(srcPath);
    if (stat.isDirectory()) {
      mergeDir(srcPath, destPath);
    } else if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
mergeDir(staticSrc, staticDest);
console.log('Done merging static assets');

// Step 2: Copy public folder
console.log('Copying public/ to standalone...');
if (fs.existsSync(publicSrc)) {
  if (fs.existsSync(publicDest)) {
    fs.rmSync(publicDest, { recursive: true });
  }
  copyRecursive(publicSrc, publicDest);
  console.log('Done copying public folder');
} else {
  console.log('No public/ folder found, skipping');
}

// Step 3: Fix pnpm node_modules structure
console.log('Fixing pnpm modules...');
const nodeModulesPath = path.join(standalonePath, 'node_modules');
const pnpmNodeModulesPath = path.join(nodeModulesPath, '.pnpm', 'node_modules');

if (!fs.existsSync(pnpmNodeModulesPath)) {
  console.log('No .pnpm/node_modules found, skipping fix');
} else {
  const packages = fs.readdirSync(pnpmNodeModulesPath);
  for (const pkg of packages) {
    const srcPath = path.join(pnpmNodeModulesPath, pkg);
    const destPath = path.join(nodeModulesPath, pkg);
    if (fs.existsSync(destPath)) continue;
    console.log(`  Copying ${pkg}...`);
    copyRecursive(srcPath, destPath, true);
  }
  console.log('Done fixing pnpm modules');
}

// Step 4: Resolve symlinks in node_modules
console.log('Resolving symlinks in node_modules...');
function resolveSymlinksInDir(dir) {
  if (!fs.existsSync(dir)) return;
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const itemPath = path.join(dir, item);
    if (item === '.pnpm') continue;
    try {
      const lstat = fs.lstatSync(itemPath);
      if (lstat.isSymbolicLink()) {
        const realPath = fs.realpathSync(itemPath);
        console.log(`  Resolving ${item}...`);
        fs.unlinkSync(itemPath);
        copyRecursive(realPath, itemPath, true);
      } else if (lstat.isDirectory() && item.startsWith('@')) {
        resolveSymlinksInDir(itemPath);
      }
    } catch (err) {
      console.log(`  Error resolving ${item}: ${err.message}`);
    }
  }
}
resolveSymlinksInDir(nodeModulesPath);
console.log('Done resolving symlinks');

// Step 5: Copy hoisted monorepo dependencies that standalone misses
// In a pnpm monorepo, some deps are hoisted to the workspace root and
// not included in the standalone output. Next.js trace sometimes copies
// only package.json without the actual code — check for real content.
const workspaceRoot = path.join(rootDir, '..');
const workspaceModules = path.join(workspaceRoot, 'node_modules');
const localModules = path.join(rootDir, 'node_modules');

function hasCodeContent(dir) {
  try {
    const items = fs.readdirSync(dir);
    // A properly installed package has both code AND package.json.
    // Next.js standalone trace sometimes copies only dist/ without package.json,
    // which makes `require('next')` fail at runtime.
    if (!items.includes('package.json')) return false;
    return items.some(i => i === 'dist' || i === 'cjs' || i === 'esm' || i === 'lib' || i.endsWith('.js') || i.endsWith('.mjs'));
  } catch { return false; }
}

// Find a package inside pnpm's versioned store directories
// e.g. .pnpm/@swc+helpers@0.5.15/node_modules/@swc/helpers/
function findInPnpmStore(pkgName, pnpmDirs) {
  const storePrefix = pkgName.replace('/', '+');
  for (const pnpmDir of pnpmDirs) {
    if (!fs.existsSync(pnpmDir)) continue;
    try {
      const entries = fs.readdirSync(pnpmDir)
        .filter(e => e.startsWith(storePrefix + '@'))
        .sort().reverse();
      for (const entry of entries) {
        const candidate = path.join(pnpmDir, entry, 'node_modules', ...pkgName.split('/'));
        if (fs.existsSync(candidate) && hasCodeContent(candidate)) return candidate;
      }
    } catch { /* ignore */ }
  }
  return null;
}

// pnpm store locations to search
const pnpmStoreDirs = [
  path.join(localModules, '.pnpm'),
  path.join(workspaceModules, '.pnpm'),
];

// Packages that Next.js standalone needs at runtime but doesn't bundle.
const needed = ['next', 'react', 'react-dom', '@swc/helpers', '@swc/counter', '@next/env', 'styled-jsx', 'client-only', 'yaml', 'zod'];
for (const pkg of needed) {
  const dest = path.join(nodeModulesPath, pkg);
  // Skip only if already properly present with actual code (not just package.json)
  if (fs.existsSync(dest) && hasCodeContent(dest)) continue;
  // Try local node_modules first, then workspace root, then pnpm store
  const candidates = [path.join(localModules, pkg), path.join(workspaceModules, pkg)];
  let found = false;
  for (const src of candidates) {
    if (!fs.existsSync(src)) continue;
    let realSrc = src;
    try { if (fs.lstatSync(src).isSymbolicLink()) realSrc = fs.realpathSync(src); } catch { continue; }
    if (!hasCodeContent(realSrc)) continue;
    console.log(`  Copying ${pkg} from ${path.dirname(src) === localModules ? 'local' : 'workspace'} node_modules...`);
    try { fs.lstatSync(dest); fs.rmSync(dest, { recursive: true }); } catch {}
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    require('child_process').execSync(`cp -rL "${realSrc}" "${dest}"`);
    found = true;
    break;
  }
  // Fallback: search pnpm versioned store directories
  if (!found) {
    const storeSrc = findInPnpmStore(pkg, pnpmStoreDirs);
    if (storeSrc) {
      console.log(`  Copying ${pkg} from pnpm store...`);
      try { fs.lstatSync(dest); fs.rmSync(dest, { recursive: true }); } catch {}
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      require('child_process').execSync(`cp -rL "${storeSrc}" "${dest}"`);
    }
  }
}
console.log('Done copying workspace dependencies');

// Step 6: Final verification — ensure critical packages are present
const critical = ['styled-jsx', '@swc/helpers', '@next/env'];
for (const pkg of critical) {
  const dest = path.join(nodeModulesPath, pkg);
  if (!fs.existsSync(dest) || !hasCodeContent(dest)) {
    console.log(`WARNING: ${pkg} still missing after postbuild — UI may fail at runtime`);
  }
}

console.log('\nPostbuild complete!');
