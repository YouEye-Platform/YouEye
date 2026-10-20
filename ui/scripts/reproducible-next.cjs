const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function guardCanonicalFeatures(root) {
  const ts = require('typescript');
  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
        const source = ts.createSourceFile(name, fs.readFileSync(name, 'utf8'), ts.ScriptTarget.Latest, true);
        function check(node) {
          if (ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'use server') {
            throw new Error('Canonical public bundles do not enable Server Actions; supply a reviewed runtime key contract first');
          }
          if (ts.isIdentifier(node) && ['draftMode', 'setPreviewData', 'previewData'].includes(node.text)) {
            throw new Error('Canonical public bundles do not enable draft/preview mode; supply a reviewed runtime key contract first');
          }
          ts.forEachChild(node, check);
        }
        check(source);
      }
    }
  }
  visit(path.join(root, 'src'));
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return value.map(canonicalJSON);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonicalJSON(value[k])]));
  return value;
}

// Next emits this data manifest as a JavaScript assignment. Webpack may insert
// client module entries in completion order; serialize its JSON deterministically
// without evaluating generated code or changing ordered arrays/module values.
function canonicalClientReferenceManifest(source) {
  const prefix = 'globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST[';
  if (!source.startsWith(prefix)) throw new Error('Unexpected client reference manifest format');
  const match = source.slice(prefix.length).match(/^("(?:[^"\\]|\\.)*")\]=([\s\S]*);$/);
  if (!match) throw new Error('Unexpected client reference manifest assignment');
  const route = JSON.parse(match[1]);
  const manifest = JSON.parse(match[2]);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || !manifest.clientModules || typeof manifest.clientModules !== 'object' || Array.isArray(manifest.clientModules)) {
    throw new Error('Unexpected client reference manifest data');
  }
  return prefix + JSON.stringify(route) + ']=' + JSON.stringify(canonicalJSON(manifest)) + ';';
}

function canonicalizeNextOutput(root) {
  const next = path.join(root, '.next');
  const actions = path.join(next, 'server', 'server-reference-manifest.json');
  if (fs.existsSync(actions)) {
    const manifest = JSON.parse(fs.readFileSync(actions, 'utf8'));
    if (Object.keys(manifest.node || {}).length || Object.keys(manifest.edge || {}).length) throw new Error('Unexpected Server Actions in canonical public bundle');
  }
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['cache', 'standalone'].includes(entry.name)) continue;
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.name.endsWith('.json')) {
        const value = JSON.parse(fs.readFileSync(name, 'utf8'));
        if (entry.name.endsWith('.nft.json') && Array.isArray(value.files)) value.files.sort();
        fs.writeFileSync(name, JSON.stringify(canonicalJSON(value)));
      } else if (entry.name.endsWith('_client-reference-manifest.js')) {
        fs.writeFileSync(name, canonicalClientReferenceManifest(fs.readFileSync(name, 'utf8')));
      }
    }
  }
  visit(next);
  // Standalone contains its own copies of the generated manifests.
  const standalone = path.join(next, 'standalone');
  if (fs.existsSync(standalone)) {
    function copies(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const name = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '.next') visit(name); else copies(name);
        }
      }
    }
    copies(standalone);
  }
}

function build(root) {
  const commit = process.env.YOUEYE_SOURCE_COMMIT;
  const env = { ...process.env };
  if (commit !== undefined) {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Exact canonical source commit required');
    guardCanonicalFeatures(root);
    const name = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name;
    const digest = (label, encoding) => crypto.createHash('sha256').update(`youeye-public-web-build-v1\0${name}\0${commit}\0${label}`).digest(encoding);
    // These public, reproducible framework values are never application secrets.
    // The feature and output guards above prevent enabling consumers of them.
    const key = digest('unused-actions', 'base64');
    const cache = path.join(root, '.next', 'cache');
    fs.rmSync(path.join(root, '.next'), { recursive: true, force: true });
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(cache, '.previewinfo'), JSON.stringify({ previewModeId: digest('unused-preview-id', 'hex').slice(0,32), previewModeSigningKey: digest('unused-preview-signing', 'hex'), previewModeEncryptionKey: digest('unused-preview-encryption', 'hex'), expireAt: 4102444800000 }), { mode: 0o600 });
    fs.writeFileSync(path.join(cache, '.rscinfo'), JSON.stringify({ 'encryption.key': key, 'encryption.expire_at': 4102444800000 }), { mode: 0o600 });
    env.YOUEYE_BUILD_ID = commit;
    env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY = key;
  }
  execFileSync(path.join(root, 'node_modules', '.bin', 'next'), ['build', '--webpack'], { cwd: root, env, stdio: 'inherit' });
  if (commit !== undefined) canonicalizeNextOutput(root);
}
module.exports = { guardCanonicalFeatures, canonicalJSON, canonicalClientReferenceManifest, canonicalizeNextOutput, build };
if (require.main === module) build(path.join(__dirname, '..'));
