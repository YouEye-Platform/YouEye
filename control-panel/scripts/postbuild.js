/**
 * Post-build script for YE-ControlPanel
 *
 * Handles:
 * 1. Detect if standalone output is nested (pnpm workspace root != project root)
 * 2. Copy static assets to standalone folder
 * 3. Copy public folder to standalone folder
 * 4. Fix pnpm node_modules structure for deployment
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const standalonePath = path.join(rootDir, '.next', 'standalone');
const staticSrc = path.join(rootDir, '.next', 'static');
const publicSrc = path.join(rootDir, 'public');

// Detect nested standalone output (happens when pnpm workspace root != project root).
// Next.js places server.js relative to the workspace root, so the project files
// end up nested inside standalone (e.g., .next/standalone/Core Repos/YE-ControlPanel/).
// We detect this by looking for server.js — if it's not at the standalone root,
// search subdirectories for it.
function findServerJsDir(base) {
  if (fs.existsSync(path.join(base, 'server.js'))) return base;

  // Search one or two levels deep
  function searchDir(dir, depth) {
    if (depth > 3) return null;
    try {
      for (const item of fs.readdirSync(dir)) {
        const full = path.join(dir, item);
        if (!fs.statSync(full).isDirectory()) continue;
        if (item === 'node_modules' || item === '.next' || item === 'public') continue;
        if (fs.existsSync(path.join(full, 'server.js'))) return full;
        const found = searchDir(full, depth + 1);
        if (found) return found;
      }
    } catch { /* ignore permission errors */ }
    return null;
  }

  return searchDir(base, 0);
}

const appDir = findServerJsDir(standalonePath);
if (!appDir) {
  console.error('ERROR: Could not find server.js in standalone output!');
  console.error('Standalone path:', standalonePath);
  process.exit(1);
}

if (appDir !== standalonePath) {
  const relative = path.relative(standalonePath, appDir);
  console.log(`Detected nested standalone output: ${relative}`);
  console.log('  Workspace root != project root — adjusting paths');
}

const staticDest = path.join(appDir, '.next', 'static');
const publicDest = path.join(appDir, 'public');
const nodeModulesPath = path.join(appDir, 'node_modules');

// Copy function that resolves symlinks
function copyRecursive(src, dest, resolveSymlinks = false) {
  if (!fs.existsSync(src)) {
    console.log(`Source does not exist: ${src}`);
    return;
  }

  let stat = resolveSymlinks ? fs.statSync(src) : fs.lstatSync(src);

  // If it's a symlink and we want to resolve, follow it
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
console.log('Copying static assets...');
if (fs.existsSync(staticDest)) {
  fs.rmSync(staticDest, { recursive: true });
}
copyRecursive(staticSrc, staticDest);
console.log('Done copying static assets');

// Step 2: Copy public folder
console.log('Copying public folder...');
if (fs.existsSync(publicDest)) {
  fs.rmSync(publicDest, { recursive: true });
}
copyRecursive(publicSrc, publicDest);
console.log('Done copying public folder');

// Step 3: Fix pnpm node_modules structure
console.log('Fixing pnpm modules...');
const pnpmNodeModulesPath = path.join(nodeModulesPath, '.pnpm', 'node_modules');

if (!fs.existsSync(pnpmNodeModulesPath)) {
  console.log('No .pnpm/node_modules found, skipping fix');
} else {
  const packages = fs.readdirSync(pnpmNodeModulesPath);

  for (const pkg of packages) {
    const srcPath = path.join(pnpmNodeModulesPath, pkg);
    const destPath = path.join(nodeModulesPath, pkg);

    if (fs.existsSync(destPath)) {
      console.log(`  Skipping ${pkg} (already exists)`);
      continue;
    }

    console.log(`  Copying ${pkg}...`);
    copyRecursive(srcPath, destPath, true);
  }
  console.log('Done fixing pnpm modules');
}

// Step 4: Resolve all symlinks in node_modules (including nested ones)
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

console.log('\nPostbuild complete!');
console.log(`App directory: ${appDir}`);
