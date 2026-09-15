const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const nextDir = path.join(rootDir, '.next');
const cacheDir = path.join(nextDir, 'cache');
const deterministicExpiry = 4102444800000;

function git(...args) {
  return execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

const suppliedCommit = process.env.YOUEYE_SOURCE_COMMIT || '';
let commit = suppliedCommit;
let gitCheckout = false;

if (fs.existsSync(path.join(rootDir, '..', '.git'))) {
  const checkoutCommit = git('rev-parse', 'HEAD');
  gitCheckout = true;
  if (suppliedCommit && suppliedCommit !== checkoutCommit) {
    throw new Error('YOUEYE_SOURCE_COMMIT does not match the checked-out source commit');
  }
  commit = checkoutCommit;
}

if (!/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error('YOUEYE_SOURCE_COMMIT must provide the exact 40-character source commit when Git metadata is absent');
}
if (gitCheckout && git('status', '--porcelain', '--untracked-files=no') !== '') {
  throw new Error('Refusing to produce a release build from modified tracked source');
}

function digest(label, encoding) {
  return crypto
    .createHash('sha256')
    .update(`youeye-control-panel-build-v1\0${label}\0${commit}`)
    .digest(encoding);
}

const actionKey = digest('server-actions', 'base64');
const preview = {
  previewModeId: digest('preview-id', 'hex').slice(0, 32),
  previewModeSigningKey: digest('preview-signing', 'hex'),
  previewModeEncryptionKey: digest('preview-encryption', 'hex'),
  expireAt: deterministicExpiry,
};

fs.rmSync(nextDir, { recursive: true, force: true });
fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(
  path.join(cacheDir, '.previewinfo'),
  JSON.stringify(preview),
  { mode: 0o600 },
);
fs.writeFileSync(
  path.join(cacheDir, '.rscinfo'),
  JSON.stringify({
    'encryption.key': actionKey,
    'encryption.expire_at': deterministicExpiry,
  }),
  { mode: 0o600 },
);

const env = {
  ...process.env,
  YOUEYE_BUILD_ID: commit,
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: actionKey,
};
execFileSync(path.join(rootDir, 'node_modules', '.bin', 'next'), ['build'], {
  cwd: rootDir,
  env,
  stdio: 'inherit',
});
execFileSync(process.execPath, [path.join(__dirname, 'postbuild.js')], {
  cwd: rootDir,
  env,
  stdio: 'inherit',
});
