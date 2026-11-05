#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = resolve(root, 'legal/third-party-assets.json');
const outputPath = resolve(process.argv[2] || resolve(root, 'THIRD_PARTY_NOTICES.txt'));
const registry = JSON.parse(await readFile(registryPath, 'utf8'));
if (registry.schema !== 'youeye.third-party-assets.v1' || !Array.isArray(registry.assets)) {
  throw new Error('Third-party asset registry schema is invalid');
}

const ids = new Set();
const sections = [];
for (const asset of [...registry.assets].sort((a, b) => a.id.localeCompare(b.id))) {
  if (!asset.id || ids.has(asset.id) || !Array.isArray(asset.paths) || asset.paths.length === 0 || !asset.license) {
    throw new Error(`Third-party asset registry entry is invalid: ${asset.id || '<missing>'}`);
  }
  ids.add(asset.id);
  for (const assetPath of asset.paths) await readFile(resolve(root, assetPath)).catch(async () => {
    const { stat } = await import('node:fs/promises');
    await stat(resolve(root, assetPath));
  });
  if (asset.notice && asset.notices) throw new Error(`Third-party asset registry entry has both notice and notices: ${asset.id}`);
  const noticePaths = asset.notices || (asset.notice ? [asset.notice] : []);
  if (!Array.isArray(noticePaths) || noticePaths.some((noticePath) => typeof noticePath !== 'string' || !noticePath)) {
    throw new Error(`Third-party asset registry notice entry is invalid: ${asset.id}`);
  }
  const noticeTexts = await Promise.all(noticePaths.map(async (noticePath) => (
    await readFile(resolve(root, noticePath), 'utf8')
  ).trim()));
  const notice = noticeTexts.length > 0 ? `\n\n${noticeTexts.join('\n\n')}` : '';
  sections.push([
    asset.id,
    `Kind: ${asset.kind}`,
    `Paths: ${asset.paths.join(', ')}`,
    `Upstream: ${asset.upstream}`,
    ...(asset.version ? [`Version: ${asset.version}`] : []),
    `License: ${asset.license}`,
    `Review status: ${asset.review || asset.trademark_review || 'recorded'}`,
  ].join('\n') + notice);
}

const header = `YOUEYE THIRD-PARTY NOTICES\n\nThis file records bundled third-party assets and vendored source. Runtime dependency and operating-system package inventories are also provided by each release SBOM. Entries marked for review must be resolved before a public Stable release.`;
await writeFile(outputPath, `${header}\n\n${sections.join('\n\n---\n\n')}\n`);
