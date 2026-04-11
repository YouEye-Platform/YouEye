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

console.log('\nPostbuild complete!');
