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

// Step 1: Copy static assets
console.log('Copying .next/static to standalone...');
if (fs.existsSync(staticDest)) {
  fs.rmSync(staticDest, { recursive: true });
}
copyRecursive(staticSrc, staticDest);
console.log('Done copying static assets');

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
// not included in the standalone output. Copy them from the workspace root.
const workspaceRoot = path.join(rootDir, '..');
const workspaceModules = path.join(workspaceRoot, 'node_modules');
if (fs.existsSync(workspaceModules)) {
  // Packages that Next.js standalone needs at runtime but doesn't bundle.
  // Only copy lightweight helpers, NOT native binaries (@swc/core-* are huge).
  const needed = ['@swc/helpers', '@swc/counter', 'styled-jsx', 'client-only', 'react', 'react-dom'];
  for (const pkg of needed) {
    const src = path.join(workspaceModules, pkg);
    const dest = path.join(nodeModulesPath, pkg);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      console.log(`  Copying ${pkg} from workspace root...`);
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
      copyRecursive(src, dest, true);
    }
  }
  console.log('Done copying workspace dependencies');
}

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
