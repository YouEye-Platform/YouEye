import ts from 'typescript';
import { collectSourceLiterals } from '../../shared/i18n-source-audit.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = resolve(root, 'src/i18n/untranslated-baseline.json');
const found = collectSourceLiterals(root, ts);
const inventory = Object.fromEntries([...found].sort(([a], [b]) => a.localeCompare(b)));
if (process.argv.includes('--write-baseline')) {
  writeFileSync(baselinePath, JSON.stringify(inventory, null, 2) + '\n');
  console.log(`Recorded ${found.size} existing literal entries for staged translation work.`);
} else {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const added = [...found].filter(([id, count]) => count > (baseline[id] || 0));
  if (added.length) {
    console.error('New interface literals must use translated messages:');
    for (const [id] of added) console.error(JSON.parse(id).join(': '));
    process.exitCode = 1;
  } else console.log(`No new interface literals; ${found.size} existing entries remain in the translation inventory.`);
}
