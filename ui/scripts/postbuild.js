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
// not included in the standalone output. Copy them using -L (dereference)
// to follow pnpm symlinks properly.
const workspaceRoot = path.join(rootDir, '..');
const workspaceModules = path.join(workspaceRoot, 'node_modules');
const localModules = path.join(rootDir, 'node_modules');

// Packages that Next.js standalone needs at runtime but doesn't bundle.
const needed = ['next', 'react', 'react-dom', '@swc/helpers', '@swc/counter', '@next/env', 'styled-jsx', 'client-only'];
for (const pkg of needed) {
  const dest = path.join(nodeModulesPath, pkg);
  // Skip if already properly present (has package.json)
  if (fs.existsSync(path.join(dest, 'package.json'))) continue;
  // Try local node_modules first (pnpm resolves symlinks here), then workspace root
  const candidates = [path.join(localModules, pkg), path.join(workspaceModules, pkg)];
  for (const src of candidates) {
    if (fs.existsSync(path.join(src, 'package.json'))) {
      console.log(`  Copying ${pkg} from ${path.dirname(src) === localModules ? 'local' : 'workspace'} node_modules...`);
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
      // Use cp -rL to properly follow pnpm symlinks
      require('child_process').execSync(`cp -rL "${src}" "${dest}"`);
      break;
    }
  }
}
console.log('Done copying workspace dependencies');

// Step 6: Ensure styled-jsx is present (required by Next.js at runtime)
const styledJsxDest = path.join(nodeModulesPath, 'styled-jsx');
if (!fs.existsSync(path.join(styledJsxDest, 'package.json'))) {
  // In a pnpm monorepo, styled-jsx may be hoisted to the workspace root
  const candidates = [
    path.join(rootDir, 'node_modules', 'styled-jsx'),
    path.join(rootDir, '..', 'node_modules', 'styled-jsx'),
  ];
  let found = false;
  for (const src of candidates) {
    if (fs.existsSync(path.join(src, 'package.json'))) {
      console.log(`Copying styled-jsx from ${src}...`);
      if (fs.existsSync(styledJsxDest)) fs.rmSync(styledJsxDest, { recursive: true });
      copyRecursive(src, styledJsxDest, true);
      console.log('Done copying styled-jsx');
      found = true;
      break;
    }
  }
  if (!found) {
    console.log('WARNING: styled-jsx not found — UI may fail at runtime');
  }
} else {
  console.log('styled-jsx already present in standalone');
}

console.log('\nPostbuild complete!');
