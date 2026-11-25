// Every message key the Control Panel's source uses exists in every registered catalogue (YE-163).
// Usage: node scripts/check-i18n-keys.mjs [--dynamic]   (--dynamic lists the calls whose key is not a literal)
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMessageKeys } from '../../shared/i18n-message-keys.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(readFileSync(resolve(root, '../shared/languages.json'), 'utf8'));
const catalogues = Object.fromEntries(registry.map(({ code }) =>
  [code, JSON.parse(readFileSync(resolve(root, 'messages', `${code}.json`), 'utf8'))]));
const result = checkMessageKeys({ root, ts, sourceDirs: [resolve(root, 'src')], catalogues });
if (process.argv.includes('--dynamic')) for (const d of result.dynamic) console.log(`${d.file}:${d.line}: ${d.text}`);
if (result.missing.length) {
  console.error('Message keys used in the source but missing from a catalogue:');
  for (const m of result.missing) console.error(`  ${m.file}:${m.line}: ${m.key} (missing in ${m.locales.join(', ')})`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${result.keys} message key uses in ${result.files} files against ${Object.keys(catalogues).length} catalogues; ` +
    `${result.dynamic.length} calls compute their key (checked by their literal prefix or the interface key scan; --dynamic lists them).`);
}
