/**
 * Validate app sources with the Control Panel's own strict parser.
 *
 *   node --import tsx scripts/validate-app-sources.ts <market-repo> [native-repo…] [--ref <git ref>]
 *
 * A market repo is checked as a catalog (catalog.yaml, apps/<id>/, bundles/<id>/bundle.yaml,
 * system/<id>.yaml); any other repo as one app (youeye-app.yaml + setup/*.yaml at its root).
 * With --ref, files are read from that git ref (git show) instead of the working tree.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadApp } from '../src/lib/market/app-format/compile';
import { parseBundle, parseCatalog, parseSystemApp } from '../src/lib/market/app-format/parse';
import { catalogFromFiles } from '../src/lib/market/catalog';

const args = process.argv.slice(2);
const refIndex = args.indexOf('--ref');
const ref = refIndex >= 0 ? args.splice(refIndex, 2)[1] : undefined;

function files(repo: string): string[] {
  if (ref) return execFileSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', ref], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(path.join(repo, dir))) {
      if (name === '.git' || name === 'node_modules') continue;
      const rel = dir ? `${dir}/${name}` : name;
      if (statSync(path.join(repo, rel)).isDirectory()) walk(rel); else out.push(rel);
    }
  };
  walk('');
  return out;
}
const read = (repo: string, file: string) => ref
  ? execFileSync('git', ['-C', repo, 'show', `${ref}:${file}`], { encoding: 'utf8' })
  : readFileSync(path.join(repo, file), 'utf8');

let failures = 0;
const check = (label: string, run: () => string) => {
  try { console.log(`ok    ${label}${(() => { const note = run(); return note ? `  (${note})` : ''; })()}`); }
  catch (error) { failures += 1; console.log(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`); }
};
const appIn = (repo: string, list: string[], dir: string) => {
  const prefix = dir ? `${dir}/` : '';
  const setups = Object.fromEntries(list.filter((file) => file.startsWith(`${prefix}setup/`) && file.endsWith('.yaml'))
    .map((file) => [file.slice(prefix.length), read(repo, file)]));
  const manifest = loadApp({ manifest: read(repo, `${prefix}youeye-app.yaml`), setups });
  return `${manifest.metadata.id} ${manifest.version}${manifest.setups.length ? `, setup: ${manifest.setups.map((s) => s.for).join(' ')}` : ''}`;
};

for (const repo of args) {
  const list = files(repo);
  const name = path.basename(repo);
  if (list.includes('catalog.yaml')) {
    check(`${name}/catalog.yaml`, () => { const c = catalogFromFiles(read(repo, 'catalog.yaml'), list); parseCatalog(read(repo, 'catalog.yaml')); return `${c.apps.length} apps, ${c.bundles.length} bundles, ${c.system.length} system`; });
    for (const file of list.filter((f) => /^apps\/[^/]+\/youeye-app\.yaml$/.test(f))) check(`${name}/${path.dirname(file)}`, () => appIn(repo, list, path.dirname(file)));
    for (const file of list.filter((f) => /^bundles\/[^/]+\/bundle\.yaml$/.test(f))) check(`${name}/${file}`, () => parseBundle(read(repo, file)).id);
    for (const file of list.filter((f) => /^system\/[^/]+\.yaml$/.test(f))) check(`${name}/${file}`, () => parseSystemApp(read(repo, file)).id);
  } else if (list.includes('youeye-app.yaml') || (!ref && existsSync(path.join(repo, 'youeye-app.yaml')))) {
    check(`${name}/youeye-app.yaml`, () => appIn(repo, list, ''));
  } else {
    failures += 1;
    console.log(`FAIL  ${name}: no catalog.yaml or youeye-app.yaml`);
  }
}
console.log(failures ? `${failures} failed` : 'all valid');
process.exit(failures ? 1 : 0);
