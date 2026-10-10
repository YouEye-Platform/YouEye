import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { incusRequest, incusUploadFile, incusDownloadFile } from '../src/lib/incus/server';
import { waitForIncusOperation } from '../src/lib/infrastructure/oci-deployer';
import { retainRuntime, copyRetainedRuntime, verifyRetainedRuntime, deleteRetainedRuntime } from '../src/lib/admission/retained-runtime';

const target = process.env.YOUEYE_ADMISSION_TEST_SSH_TARGET;
const expectedIdentity = process.env.YOUEYE_ADMISSION_TEST_SMBIOS;
const images = [process.env.YOUEYE_ADMISSION_TEST_LXD_IMAGE, process.env.YOUEYE_ADMISSION_TEST_OCI_IMAGE];

test('real Incus preserves stopped LXD and OCI root content through retention and adoption', {
  skip: !target || !expectedIdentity || images.some(image => !image),
}, async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const names = [0, 1].flatMap(index => [`app-retention-test-${suffix}-${index}`, `ye-retention-test-${suffix}-${index}`]);
  const script = `
import base64,http.client,json,pathlib,socket,sys
request=json.load(sys.stdin)
assert pathlib.Path('/sys/class/dmi/id/product_uuid').read_text().strip()==request['identity'], 'Target identity changed'
path=request['path']
assert path=='/1.0/instances' or any(path.startswith('/1.0/instances/'+name) for name in request['names']) or path.startswith('/1.0/operations/'), 'Outside fixture boundary'
class UnixHTTP(http.client.HTTPConnection):
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
  self.sock.connect('/var/lib/incus/unix.socket')
connection=UnixHTTP('localhost',timeout=120)
body=base64.b64decode(request['body'])
connection.request(request['method'],path,body,request['headers'])
result=connection.getresponse()
sys.stdout.write(json.dumps({'status':result.status,'headers':dict(result.getheaders()),'body':base64.b64encode(result.read()).decode()}))
`;
  const directory = await mkdtemp(join(tmpdir(), 'retention-live-'));
  const socket = join(directory, 'incus.sock');
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const result = spawnSync('ssh', [target!, 'python3', '-c', `'${script.replaceAll("'", "'\\''")}'`], {
      input: JSON.stringify({ identity: expectedIdentity, names, path: request.url, method: request.method,
        headers: request.headers, body: Buffer.concat(chunks).toString('base64') }),
      encoding: 'utf8', timeout: 150_000, maxBuffer: 2 * 1024 * 1024,
    });
    if (result.status !== 0) {
      response.statusCode = 500;
      response.end(JSON.stringify({ type: 'error', error: 'Fixture transport failed' }));
      return;
    }
    const forwarded = JSON.parse(result.stdout);
    response.writeHead(forwarded.status, { 'content-type': forwarded.headers['Content-Type'] || 'application/json' });
    response.end(Buffer.from(forwarded.body, 'base64'));
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  const oldSocket = process.env.INCUS_SOCKET;
  const oldHttps = process.env.INCUS_HTTPS_URL;
  process.env.INCUS_SOCKET = socket;
  delete process.env.INCUS_HTTPS_URL;
  async function complete(result: Awaited<ReturnType<typeof incusRequest>>) {
    assert.notEqual(result.type, 'error', result.error);
    if (result.type === 'async') await waitForIncusOperation(result.operation);
  }
  const archiveDirectory = `/var/lib/youeye/backups/.staging/retention-test-${suffix}`;
  function archiveOperation(action: 'export' | 'import' | 'cleanup', name?: string, archive?: string) {
    const archiveScript = `
import json,pathlib,shutil,subprocess,sys
r=json.load(sys.stdin)
assert pathlib.Path('/sys/class/dmi/id/product_uuid').read_text().strip()==r['identity'], 'Target identity changed'
directory=pathlib.Path(r['directory'])
assert directory.parent==pathlib.Path('/var/lib/youeye/backups/.staging') and directory.name.startswith('retention-test-')
if r['action']=='cleanup':
 shutil.rmtree(directory,ignore_errors=True)
else:
 assert r['name'] in r['names']
 archive=directory/r['archive']
 assert archive.parent==directory and archive.suffix=='.gz'
 directory.mkdir(parents=True,exist_ok=True,mode=0o700)
 if r['action']=='export': subprocess.run(['incus','export',r['name'],str(archive),'--instance-only'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 else: subprocess.run(['incus','import',str(archive),r['name'],'--storage','default'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
`;
    const result = spawnSync('ssh', [target!, 'python3', '-c', `'${archiveScript.replaceAll("'", "'\\''")}'`], {
      input: JSON.stringify({ action, name, archive, names, identity: expectedIdentity, directory: archiveDirectory }),
      encoding: 'utf8', timeout: 150_000,
    });
    assert.equal(result.status, 0, 'Identity-bound fixture archive operation failed');
  }
  try {
    for (const [index, fingerprint] of images.entries()) {
      const binding = { appId: `retention-test-${suffix}`, installationId: randomUUID(), ownerId: randomUUID(),
        sourceName: names[index * 2], retainedName: names[index * 2 + 1], pool: 'default' };
      await complete(await incusRequest('POST', '/1.0/instances', {
        name: binding.sourceName, source: { type: 'image', fingerprint },
        profiles: [], devices: { root: { type: 'disk', pool: binding.pool, path: '/' } },
        config: { 'boot.autostart': 'false', 'user.youeye.app_id': binding.appId,
          'user.youeye.installation_id': binding.installationId, 'user.youeye.data_owner_id': binding.ownerId },
      }));
      const sentinel = Buffer.from(`private-${suffix}-${index}\n`);
      await incusUploadFile(binding.sourceName, '/household-retention-fixture.txt', sentinel, { mode: '0600' });
      await retainRuntime(binding);
      await verifyRetainedRuntime(binding);
      await assert.rejects(copyRetainedRuntime({ ...binding, ownerId: randomUUID() }), /foreign/);
      archiveOperation('export', binding.retainedName, `${index}.tar.gz`);
      await complete(await incusRequest('DELETE', `/1.0/instances/${binding.sourceName}`));
      archiveOperation('import', binding.sourceName, `${index}.tar.gz`);
      assert.deepEqual(await incusDownloadFile(binding.sourceName, '/household-retention-fixture.txt'), sentinel);
      const imported = await incusRequest<{ status: string; profiles: string[]; config: Record<string, string>;
        expanded_devices: Record<string, { type: string; path?: string }> }>('GET', `/1.0/instances/${binding.sourceName}`);
      assert.equal(imported.metadata.status, 'Stopped');
      assert.equal(imported.metadata.config['boot.autostart'], 'false');
      assert.deepEqual(imported.metadata.profiles, []);
      assert.ok(Object.values(imported.metadata.expanded_devices).every(device => device.type === 'disk' && device.path === '/'));
      await complete(await incusRequest('DELETE', `/1.0/instances/${binding.sourceName}`));
      await copyRetainedRuntime(binding);
      assert.deepEqual(await incusDownloadFile(binding.sourceName, '/household-retention-fixture.txt'), sentinel);
      await complete(await incusRequest('DELETE', `/1.0/instances/${binding.sourceName}`));
      await deleteRetainedRuntime(binding);
      console.log(`${index === 0 ? 'LXD' : 'OCI'} private root preserved through copy and offline archive import; foreign owner rejected; copies cleaned`);
    }
  } finally {
    // Only fixture names are ever touched. A failed identity check prevents cleanup.
    for (const name of names) {
      const current = await incusRequest('GET', `/1.0/instances/${name}`);
      if (current.type !== 'error') await complete(await incusRequest('DELETE', `/1.0/instances/${name}`));
    }
    archiveOperation('cleanup');
    if (oldSocket === undefined) delete process.env.INCUS_SOCKET; else process.env.INCUS_SOCKET = oldSocket;
    if (oldHttps === undefined) delete process.env.INCUS_HTTPS_URL; else process.env.INCUS_HTTPS_URL = oldHttps;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
