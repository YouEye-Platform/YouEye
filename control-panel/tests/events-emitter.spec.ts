import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

test('platform events go to the app\'s primary container, not its first (a sidecar)', async () => {
  const lookups: string[] = [];
  const posts: string[] = [];
  let delivered!: () => void;
  const done = new Promise<void>((resolve) => { delivered = resolve; });
  const exports: Record<string, any> = {};
  const mocks: Record<string, unknown> = {
    '@/lib/market/metadata': { listInstalledApps: async () => [{ appId: 'notes', containers: [
      { name: 'redis', containerName: 'app-notes-redis', type: 'oci' },
      { name: 'main', containerName: 'app-notes-main', type: 'lxd' },
    ] }] },
    '@/lib/market/frozen-manifest': { readInstalledAppManifest: async () => ({
      capabilities: { events: ['user.created'] },
      containers: [{ name: 'redis', port: 6379 }, { name: 'main', primary: true, port: 3000 }],
    }) },
    '@/lib/market/setup-context': { setupContainers: (manifest: any, meta: any) => Object.fromEntries(
      manifest.containers.map((spec: any) => [spec.name, meta.containers.find((c: any) => c.name === spec.name).containerName])) },
    '@/lib/incus/app-network': { appContainerAddress: async (container: string, appId: string) => {
      lookups.push(`${container}@${appId}`); return '10.76.0.5'; } },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/events/emitter.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, console, AbortSignal,
    fetch: async (url: string) => { posts.push(url); delivered(); return { ok: true }; },
    require: (name: string) => mocks[name],
  });
  exports.emitEvent('user.created', {});
  await done;
  assert.deepEqual(lookups, ['app-notes-main@notes']);
  assert.deepEqual(posts, ['http://10.76.0.5:3000/api/youeye/events']);
});
