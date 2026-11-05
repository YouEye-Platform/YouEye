#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const presetsPath = resolve(root, 'control-panel/src/lib/profile-avatar-presets.json');
const outputPath = resolve(process.argv[2] || resolve(root, 'legal/noto-avatar-inventory.json'));
const sourceDir = resolve(root, 'legal/upstream/noto-emoji-2.051');
const upstreamCommit = '8998f5dd683424a73e2314a8c1f1e359c19e8742';
const upstreamTree = 'f5de9223f07bb7c738724c53849c15b856ef5b45';

function gitBlobOID(bytes) {
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

const presets = JSON.parse(await readFile(presetsPath, 'utf8'));
const items = [];
for (const preset of presets) {
  const codepoints = [...preset.emoji]
    .map((character) => character.codePointAt(0).toString(16).padStart(4, '0'))
    .filter((codepoint) => codepoint !== 'fe0f');
  const sourcePath = `svg/emoji_u${codepoints.join('_')}.svg`;
  const sourceBytes = await readFile(resolve(sourceDir, sourcePath));
  const output = `control-panel/public/profile-avatar-art/${preset.id}.png`;
  const bytes = await readFile(resolve(root, output));
  items.push({
    id: preset.id,
    emoji: preset.emoji,
    source_path: sourcePath,
    source_blob_oid: gitBlobOID(sourceBytes),
    source_sha256: createHash('sha256').update(sourceBytes).digest('hex'),
    source_bytes: sourceBytes.length,
    output_path: output,
    output_blob_oid: gitBlobOID(bytes),
    output_sha256: createHash('sha256').update(bytes).digest('hex'),
    output_bytes: bytes.length,
  });
}

await writeFile(outputPath, `${JSON.stringify({
  schema: 'youeye.noto-avatar-inventory.v2',
  upstream_repository: 'https://github.com/googlefonts/noto-emoji',
  upstream_version: '2.051',
  upstream_commit: upstreamCommit,
  upstream_tree: upstreamTree,
  git_object_format: 'sha1',
  license: 'OFL-1.1',
  rendering_provenance: 'historical-render-recipe-unavailable',
  items,
}, null, 2)}\n`);
