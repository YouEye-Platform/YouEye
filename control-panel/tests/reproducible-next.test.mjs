import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { guardCanonicalFeatures, canonicalClientReferenceManifest, canonicalizeNextOutput } = require('../scripts/reproducible-next.cjs');

const clientManifest = value => 'globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST["/page"]=' + JSON.stringify(value) + ';';
test('client reference data is stable across module insertion order without changing values or arrays', () => {
  const first = clientManifest({clientModules:{z:{id:8,chunks:['b','a']},a:{id:9}},entryCSSFiles:{page:['second.css','first.css']}});
  const second = clientManifest({entryCSSFiles:{page:['second.css','first.css']},clientModules:{a:{id:9},z:{chunks:['b','a'],id:8}}});
  assert.equal(canonicalClientReferenceManifest(first), canonicalClientReferenceManifest(second));
  assert.match(canonicalClientReferenceManifest(first), /"chunks":\["b","a"\]/);
  assert.match(canonicalClientReferenceManifest(first), /\["second.css","first.css"\]/);
  assert.notEqual(canonicalClientReferenceManifest(first), canonicalClientReferenceManifest(second.replace('"id":9','"id":10')));
  for (const invalid of [first + 'globalThis.unexpected=true;', first.replace('"/page"','getRoute()'), first.replace('"id":8','"id":danger()'), 'arbitrary code', clientManifest([])]) {
    assert.throws(() => canonicalClientReferenceManifest(invalid));
  }
});
test('generated and standalone client references receive the same deterministic serialization', () => {
  const root = mkdtempSync(join(tmpdir(), 'next-client-reference-'));
  try {
    const paths = ['.next/server/app/page_client-reference-manifest.js','.next/standalone/.next/server/app/page_client-reference-manifest.js'];
    const source = clientManifest({clientModules:{z:{id:1},a:{id:2}}});
    for (const relative of paths) {
      const file = join(root,relative);
      mkdirSync(join(file,'..'),{recursive:true});
      writeFileSync(file,source);
    }
    canonicalizeNextOutput(root);
    canonicalizeNextOutput(root);
    for (const relative of paths) assert.equal(readFileSync(join(root,relative),'utf8'),canonicalClientReferenceManifest(source));
  } finally { rmSync(root,{recursive:true}); }
});

test('public canonical framework values cannot enable actions or preview through aliases', () => {
  const root = mkdtempSync(join(tmpdir(), 'next-feature-guard-'));
  try {
    mkdirSync(join(root, 'src'));
    for (const source of [
      '"use server"; export async function action() {}',
      'import { draftMode as mode } from "next/headers"; mode();',
      'export async function fn(){"use server";}',
    ]) {
      writeFileSync(join(root, 'src', 'route.ts'), source);
      assert.throws(() => guardCanonicalFeatures(root));
    }
    writeFileSync(join(root, 'src', 'route.ts'), '// "use server" in commentary\nexport const GET=()=>new Response("ok");');
    guardCanonicalFeatures(root);
  } finally { rmSync(root, { recursive: true }); }
});
test('canonical manifests retain array semantics and reject generated action consumers', () => {
  const root = mkdtempSync(join(tmpdir(), 'next-output-guard-'));
  try {
    mkdirSync(join(root,'.next','server'),{recursive:true});
    const file=join(root,'.next','server','route.nft.json');
    writeFileSync(file,JSON.stringify({version:1,files:['z','a'],ordered:['z','a'],nested:{z:1,a:2}}));
    canonicalizeNextOutput(root);
    assert.equal(readFileSync(file,'utf8'),'{"files":["a","z"],"nested":{"a":2,"z":1},"ordered":["z","a"],"version":1}');
    writeFileSync(join(root,'.next','server','server-reference-manifest.json'),JSON.stringify({node:{action:{}},edge:{}}));
    assert.throws(()=>canonicalizeNextOutput(root),/Server Actions/);
  } finally { rmSync(root,{recursive:true}); }
});
