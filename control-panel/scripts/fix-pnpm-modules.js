/**
 * Post-build script to fix pnpm node_modules structure for standalone deployment.
 * 
 * pnpm uses symlinks to deduplicate packages, but the standalone output only includes
 * the 4 top-level symlinks (next, react, react-dom, typescript). Other packages that
 * Next.js needs internally (like styled-jsx) are in .pnpm/node_modules/ but don't have
 * top-level symlinks.
 * 
 * This script copies those packages to the top level so they can be resolved.
 */

const fs = require('fs');
const path = require('path');

const standalonePath = path.join(__dirname, '..', '.next', 'standalone');
const nodeModulesPath = path.join(standalonePath, 'node_modules');
const pnpmNodeModulesPath = path.join(nodeModulesPath, '.pnpm', 'node_modules');

if (!fs.existsSync(pnpmNodeModulesPath)) {
  console.log('No .pnpm/node_modules found, skipping fix');
  process.exit(0);
}

// Get all packages in .pnpm/node_modules
const packages = fs.readdirSync(pnpmNodeModulesPath);

for (const pkg of packages) {
  const srcPath = path.join(pnpmNodeModulesPath, pkg);
  const destPath = path.join(nodeModulesPath, pkg);
  
  // Skip if already exists at top level
  if (fs.existsSync(destPath)) {
    console.log(`Skipping ${pkg} (already exists)`);
    continue;
  }
  
  // Copy the package
  console.log(`Copying ${pkg}...`);
  copyRecursive(srcPath, destPath);
}

console.log('Done fixing pnpm modules');

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    const items = fs.readdirSync(src);
    for (const item of items) {
      copyRecursive(path.join(src, item), path.join(dest, item));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}
