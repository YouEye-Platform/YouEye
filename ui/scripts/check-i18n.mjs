import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));
const { createTranslator } = require('next-intl');
const registry = JSON.parse(readFileSync(resolve(root, '../shared/languages.json'), 'utf8'));
const catalogueDir = resolve(root, 'messages');
const read = code => JSON.parse(readFileSync(resolve(catalogueDir, `${code}.json`), 'utf8'));
function flatten(tree, prefix = '') {
  return Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') return [[name, value]];
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid message ${name}`);
    return Object.entries(flatten(value, name));
  }));
}
const english = flatten(read('en'));
let count = 0;
const codes = new Set();
for (const language of registry) {
  if (codes.has(language.code)) throw new Error(`Duplicate locale ${language.code}`);
  codes.add(language.code);
  if (!['ltr', 'rtl'].includes(language.direction)) throw new Error(`Invalid direction ${language.code}`);
  new Intl.PluralRules(language.code);
  const messages = read(language.code);
  const flat = flatten(messages);
  const t = createTranslator({ locale: language.code, messages, onError(error) { throw error; } });
  for (const [key, text] of Object.entries(english)) {
    if (!(key in flat)) throw new Error(`Missing ${language.code}:${key}`);
    const variables = text => [...text.matchAll(/\{(\w+)(?:[,}])/g)].map(m => m[1]).sort();
    if (JSON.stringify([...new Set(variables(text))]) !== JSON.stringify([...new Set(variables(flat[key]))])) {
      throw new Error(`Placeholder mismatch ${language.code}:${key}`);
    }
    const values = Object.fromEntries(variables(text).map(name => [name, /\{\s*\w+\s*,\s*(plural|selectordinal|number)/.test(text) ? 2 : 'example']));
    for (const match of text.matchAll(/<([A-Za-z]\w*)>/g)) values[match[1]] = chunks => chunks;
    t.rich(key, values);
    count++;
  }
  for (const key of Object.keys(flat)) if (!(key in english)) throw new Error(`Unknown ${language.code}:${key}`);
}
for (const file of readdirSync(catalogueDir).filter(name => name.endsWith('.json'))) {
  if (!codes.has(file.slice(0, -5))) throw new Error(`Catalogue is not registered: ${file}`);
}
console.log(`Validated ${codes.size} language catalogues, ${count} messages, placeholders and ICU formatting.`);
