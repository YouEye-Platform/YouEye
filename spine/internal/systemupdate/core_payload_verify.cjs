// Executed by the installed container's Node runtime. Input is a protected,
// host-derived index of an authenticated archive; output contains no file data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
try {
  const root = process.argv[1];
  const index = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!path.isAbsolute(root) || !fs.lstatSync(root).isDirectory()
    || index.schema !== 'youeye.core-payload.v1') throw new Error('invalid input');
  const entries = new Map(index.entries.map(entry => [entry.path, entry]));
  const seen = new Set();
  const cacheRoot = '.next/server/route-cache';
  const cacheOwner = cacheRoot + '/APP_ROUTE/' + crypto.createHash('sha256').update('/manifest.webmanifest/route').digest('hex');
  const cacheKey = cacheOwner + '/$/manifest.webmanifest';
  const cacheEnabled = entries.get('.next/server/app/manifest.webmanifest/route.js')?.kind === 'file';
  const cacheDirectories = new Set([cacheRoot, cacheRoot + '/APP_ROUTE', cacheOwner, cacheOwner + '/$']);
  function walkDirectory(file, prefix, expected) {
    let fd;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); }
    catch (error) { if (cacheDirectories.has(prefix) && error.code === 'ENOENT') return; throw error; }
    try {
      const actual = fs.fstatSync(fd);
      if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.mode !== expected.mode) throw new Error('changed directory identity');
      walk('/proc/self/fd/' + fd, prefix);
    } finally { fs.closeSync(fd); }
  }
  function walk(dir, prefix) {
    for (const name of fs.readdirSync(dir)) {
      const relative = prefix ? prefix + '/' + name : name;
      if (relative === '.env' || relative === '.next/cache') continue;
      const entry = entries.get(relative);
      const file = path.join(dir, name);
      if (!entry) {
        const directory = cacheDirectories.has(relative);
        if (!cacheEnabled || (!directory && relative !== cacheKey + '.body' && relative !== cacheKey + '.meta')) throw new Error('unrecorded path');
        let stat;
        try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (stat.mode & 0o7000) throw new Error('invalid response cache mode');
        if (directory) {
          if (!stat.isDirectory()) throw new Error('linked response cache');
          walkDirectory(file, relative, stat);
        } else if (!stat.isFile() || (stat.mode & 0o111) || stat.nlink > 1) throw new Error('invalid response cache file');
        continue;
      }
      const stat = fs.lstatSync(file);
      if ((stat.mode & 0o7777) !== entry.mode) throw new Error('changed mode');
      seen.add(relative);
      if (entry.kind === 'directory') {
        if (!stat.isDirectory()) throw new Error('changed directory');
        walkDirectory(file, relative, stat);
      } else if (entry.kind === 'symlink') {
        if (!stat.isSymbolicLink() || fs.readlinkSync(file) !== entry.link) throw new Error('changed link');
      } else if (entry.kind === 'file') {
        if (!stat.isFile() || stat.size !== (entry.size ?? 0)) throw new Error('changed file');
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          const actual = fs.fstatSync(fd);
          if (!actual.isFile() || actual.dev !== stat.dev || actual.ino !== stat.ino
            || actual.size !== stat.size) throw new Error('changed file identity');
          const hash = crypto.createHash('sha256');
          const buffer = Buffer.alloc(1024 * 1024);
          let read, total = 0;
          while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            total += read;
            if (total > stat.size) throw new Error('growing file');
            hash.update(buffer.subarray(0, read));
          }
          if (total !== stat.size || hash.digest('hex') !== entry.sha256) throw new Error('changed bytes');
        } finally { fs.closeSync(fd); }
      } else throw new Error('changed type');
    }
  }
  // Anchor the root component-by-component as well as descendant directories.
  let rootFd = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    for (const part of root.split('/').filter(Boolean)) {
      if (part === '.' || part === '..') throw new Error('unsafe root');
      const next = fs.openSync('/proc/self/fd/' + rootFd + '/' + part, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.closeSync(rootFd);
      rootFd = next;
    }
    walk('/proc/self/fd/' + rootFd, '');
  } finally { fs.closeSync(rootFd); }
  if (seen.size !== entries.size) throw new Error('missing path');
  process.stdout.write('verified\n');
} catch {
  process.stderr.write('Installed core payload is modified or unavailable\n');
  process.exitCode = 1;
}
