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

// Step 3: Fix pnpm node_modules — collect all packages from .pnpm versioned dirs
console.log('Fixing pnpm modules...');

function findPnpmPackages(pnpmDir) {
  const pkgs = new Map();
  if (!fs.existsSync(pnpmDir)) return pkgs;
  for (const entry of fs.readdirSync(pnpmDir)) {
    if (entry === 'node_modules') continue;
    const nmDir = path.join(pnpmDir, entry, 'node_modules');
    if (!fs.existsSync(nmDir)) continue;
    for (const pkg of fs.readdirSync(nmDir)) {
      if (pkg === '.pnpm') continue;
      const pkgPath = path.join(nmDir, pkg);
      if (pkg.startsWith('@')) {
        for (const sub of fs.readdirSync(pkgPath)) {
          const key = `${pkg}/${sub}`;
          const fullPath = path.join(pkgPath, sub);
          const indexFile = path.join(fullPath, 'dist', 'index.js');
          if (!pkgs.has(key) || fs.existsSync(indexFile)) {
            pkgs.set(key, fullPath);
          }
        }
      } else {
        const indexFile = path.join(pkgPath, 'dist', 'index.js');
        if (!pkgs.has(pkg) || fs.existsSync(indexFile)) {
          pkgs.set(pkg, pkgPath);
        }
      }
    }
  }
  return pkgs;
}

function hasCodeContent(dir) {
  try {
    const items = fs.readdirSync(dir);
    return items.some(i => i === 'dist' || i === 'cjs' || i === 'esm' || i === 'lib' || i.endsWith('.js') || i.endsWith('.mjs'));
  } catch { return false; }
}

function mergePnpmPackages(pnpmDir, targetNodeModules, label) {
  const pkgs = findPnpmPackages(pnpmDir);
  for (const [name, srcPath] of pkgs) {
    const destPath = path.join(targetNodeModules, name);
    if (fs.existsSync(destPath)) {
      if (hasCodeContent(destPath)) continue;
      if (!hasCodeContent(srcPath)) continue;
      console.log(`  [${label}] Replacing incomplete ${name}...`);
      fs.rmSync(destPath, { recursive: true });
    } else {
      console.log(`  [${label}] Adding ${name}...`);
    }
    copyRecursive(srcPath, destPath, true);
  }
}

const allPnpmDirs = [path.join(nodeModulesPath, '.pnpm')];
const wsNodeModules = path.join(standalonePath, 'node_modules');
if (appDir !== standalonePath && fs.existsSync(wsNodeModules)) {
  allPnpmDirs.push(path.join(wsNodeModules, '.pnpm'));
  for (const pkg of fs.readdirSync(wsNodeModules)) {
    if (pkg === '.pnpm') continue;
    const destPath = path.join(nodeModulesPath, pkg);
    if (fs.existsSync(destPath)) continue;
    const srcPath = path.join(wsNodeModules, pkg);
    copyRecursive(srcPath, destPath, true);
  }
}

for (const pnpmDir of allPnpmDirs) {
  const label = pnpmDir.includes('standalone/node_modules') ? 'workspace' : 'app';
  mergePnpmPackages(pnpmDir, nodeModulesPath, label);
}
console.log('Done fixing pnpm modules');

// Step 4: Resolve all remaining symlinks in node_modules
console.log('Resolving symlinks in node_modules...');
function resolveSymlinksInDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const item of fs.readdirSync(dir)) {
    if (item === '.pnpm') continue;
    const itemPath = path.join(dir, item);
    try {
      const lstat = fs.lstatSync(itemPath);
      if (lstat.isSymbolicLink()) {
        try {
          const realPath = fs.realpathSync(itemPath);
          fs.unlinkSync(itemPath);
          copyRecursive(realPath, itemPath, true);
        } catch { fs.unlinkSync(itemPath); }
      } else if (lstat.isDirectory() && item.startsWith('@')) {
        resolveSymlinksInDir(itemPath);
      }
    } catch (err) {
      console.log(`  Error: ${item}: ${err.message}`);
    }
  }
}
resolveSymlinksInDir(nodeModulesPath);
console.log('Done resolving symlinks');

// Step 5: Copy missing workspace-level dependencies (pnpm hoists some to root)
const workspaceDeps = ['@swc/helpers', '@swc/counter', '@next/env', 'styled-jsx', 'client-only', 'next', 'react', 'react-dom'];
const wsRootNodeModules = path.resolve(rootDir, '..', 'node_modules');
for (const dep of workspaceDeps) {
  const destPath = path.join(nodeModulesPath, dep);
  if (fs.existsSync(destPath) && hasCodeContent(destPath)) continue;
  for (const searchDir of [path.join(rootDir, 'node_modules'), wsRootNodeModules]) {
    const srcPath = path.join(searchDir, dep);
    if (!fs.existsSync(srcPath)) continue;
    let realSrc = srcPath;
    try { if (fs.lstatSync(srcPath).isSymbolicLink()) realSrc = fs.realpathSync(srcPath); } catch { continue; }
    if (!hasCodeContent(realSrc)) continue;
    console.log(`  Copying ${dep} from ${searchDir === wsRootNodeModules ? 'workspace' : 'local'} node_modules...`);
    if (fs.existsSync(destPath)) fs.rmSync(destPath, { recursive: true });
    copyRecursive(realSrc, destPath, true);
    break;
  }
}
console.log('Done copying workspace dependencies');

// Ensure styled-jsx is present (Next.js requires it)
const styledJsx = path.join(nodeModulesPath, 'styled-jsx');
if (fs.existsSync(styledJsx)) console.log('styled-jsx already present in standalone');

console.log('\nPostbuild complete!');
console.log(`App directory: ${appDir}`);
