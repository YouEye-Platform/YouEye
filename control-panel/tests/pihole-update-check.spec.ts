import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { bashSyntaxOK, withoutRemoteUpdateCheck } from '../src/lib/infrastructure/pihole-update-check';
import { SYSTEM_IMAGES } from '../src/lib/infrastructure/system-images';

const root = process.cwd();
// `/opt/pihole/updatecheck.sh` of the pinned image, read from a box (sha256 da6ba097…). Refresh it with the pin.
const fixture = path.join(root, 'tests/fixtures', `pihole-${SYSTEM_IMAGES.pihole.version}-updatecheck.sh`);

test("Pi-hole's update check keeps its local versions and asks GitHub nothing", () => {
  const original = readFileSync(fixture, 'utf8');
  assert.match(original, /api\.github\.com/);
  assert.match(original, /git ls-remote "https:\/\/github\.com/);
  const local = withoutRemoteUpdateCheck(original)!;
  assert.ok(local);
  assert.doesNotMatch(local, /github|curl|ls-remote/);
  // Local versions are still recorded; the remote ones read "null", as when GitHub is unreachable.
  assert.match(local, /CORE_VERSION="\$\(get_local_version \/etc\/\.pihole\)"/);
  assert.match(local, /function get_remote_version\(\) \{[\s\S]*?\n {8}echo "null"\n/);
  assert.match(local, /function get_remote_hash\(\) \{\n {4}echo "null"\n\}/);
  assert.equal(local.split('\n').length, original.split('\n').length);
  assert.equal(withoutRemoteUpdateCheck(local), local);
});

test("an update check of another form is kept as it is, never cut into broken bash", async () => {
  const original = readFileSync(fixture, 'utf8');
  assert.equal(await bashSyntaxOK(withoutRemoteUpdateCheck(original)!), true);
  // Another GitHub address, a call cut over lines, one inside an if, a pipe that goes on, an unclosed quote.
  for (const form of [
    `${original}\nwget https://github.com/pi-hole/x\n`,
    'get() {\n  curl -s \\\n    "https://api.github.com/repos/pi-hole/x" || echo null\n}\n',
    'get() {\n  curl -s \\\n    "https://github.com/x"\n}\n',
    'if curl -s "https://api.github.com/x" >/dev/null; then\n  echo up\nfi\n',
    'curl -s "https://api.github.com/x" |\n  jq .tag_name\n',
    'X="$(git ls-remote "https://github.com/pi-hole/x)"\n',
    'curl -s "https://api.github.com/x" && { echo a; }\n',
  ]) assert.equal(withoutRemoteUpdateCheck(form), null, form);
  assert.equal(await bashSyntaxOK('get() {\n  echo "null"\n'), false);
});

/** The module with Incus replaced: `files` is the container's file system. */
function loadWithIncus(files: Map<string, string>, failUpload = false) {
  const source = ts.transpileModule(readFileSync(path.join(root, 'src/lib/infrastructure/pihole-update-check.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const nodeRequire = createRequire(import.meta.url);
  const exports: Record<string, unknown> = {};
  const uploads: string[] = [];
  runInNewContext(source, { exports, console: { log() {}, warn() {}, error() {} }, Buffer, require(id: string) {
    if (id === '@/lib/incus/server') return {
      async incusDownloadFile(_c: string, file: string) {
        if (!files.has(file)) throw new Error('no such file');
        return Buffer.from(files.get(file)!, 'utf8');
      },
      async incusUploadFile(_c: string, file: string, data: Buffer) {
        uploads.push(data.toString('utf8'));
        if (failUpload && uploads.length === 1) { files.set(file, data.toString('utf8').slice(0, 20)); throw new Error('cut off'); }
        files.set(file, data.toString('utf8'));
      },
    };
    return nodeRequire(id);
  } });
  return { turnOff: exports.turnOffPiholeUpdateCheck as (c?: string) => Promise<string>, uploads };
}

test('turning the check off never throws, and keeps or puts back the original when it cannot edit it', async () => {
  const script = '/opt/pihole/updatecheck.sh';
  const original = readFileSync(fixture, 'utf8');
  const edited = new Map([[script, original]]);
  assert.equal(await loadWithIncus(edited).turnOff(), 'changed');
  assert.doesNotMatch(edited.get(script)!, /github/);
  assert.equal(await loadWithIncus(edited).turnOff(), 'unchanged');
  const unknown = `${original}\nwget https://github.com/pi-hole/x\n`;
  const kept = new Map([[script, unknown]]);
  const keptRun = loadWithIncus(kept);
  assert.equal(await keptRun.turnOff(), 'kept');
  assert.deepEqual(keptRun.uploads, []);
  assert.equal(kept.get(script), unknown);
  assert.equal(await loadWithIncus(new Map()).turnOff(), 'kept');
  const cut = new Map([[script, original]]);
  assert.equal(await loadWithIncus(cut, true).turnOff(), 'kept');
  assert.equal(cut.get(script), original, 'a failed write puts the original back');
});

test('every Pi-hole deploy turns the check off before the first start, and the CP start converges older ones', () => {
  const deployer = readFileSync(path.join(root, 'src/lib/infrastructure/deployer.ts'), 'utf8');
  assert.doesNotMatch(deployer, /piholeManifest\(hostIP\);\s*\n\s*(?:remit\([^\n]*\n\s*)?await deployOCIContainer\(/);
  assert.equal(deployer.match(/await deployPihole\(manifest, hostIP\)/g)?.length, 3);
  assert.match(deployer, /\{ start: false \}\);\n\s*await turnOffPiholeUpdateCheck\(manifest\.containerName\);\n\s*await startOCIContainer/);
  assert.match(readFileSync(path.join(root, 'src/instrumentation.ts'), 'utf8'), /turnOffPiholeUpdateCheck\(\)/);
  const updater = readFileSync(path.join(root, 'src/lib/infrastructure/system-updater.ts'), 'utf8');
  const afterRebuild = updater.slice(updater.indexOf('await rebuildContainer(plan.containerName, plan.desiredImage);'));
  const edit = afterRebuild.slice(0, afterRebuild.indexOf('await startContainer(plan.containerName);'));
  assert.match(edit, /if \(plan\.id === 'pihole'\) \{\s*await import\('\.\/pihole-update-check'\)\.then\(m => m\.turnOffPiholeUpdateCheck\(plan\.containerName\)\)\s*\.catch\(/);
  assert.ok(edit.length < 600, 'the edit sits between the rebuild and the start');
});
