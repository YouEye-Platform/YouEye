import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const SRC = join(import.meta.dirname, '../../src');

/** Transpile one source file and run it with the given `require`. */
export function loadSource(file: string, require: (name: string) => unknown, globals: Record<string, unknown> = {}): any {
  const output = ts.transpileModule(readFileSync(join(SRC, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  new Function('require', 'exports', ...Object.keys(globals), output)(require, exports, ...Object.values(globals));
  return exports;
}

export const containerOrder = () => loadSource('lib/apps/container-order.ts', () => ({}));

type FakeInstance = {
  name: string; status: 'Running' | 'Stopped' | 'Frozen'; config: Record<string, string>; profiles: string[];
  devices: Record<string, Record<string, string>>; expanded_devices: Record<string, Record<string, string>>;
};
type FakeVolume = { name: string; description: string; config: Record<string, string>; content_type: string;
  used_by: string[]; data: string; snapshots: Map<string, { description: string; data: string }> };

/**
 * A small Incus: instances with a state, custom volumes with snapshots. A clean stop of a container in `stuck` times
 * out (the container stays Running, and the whole timeout passes on `clock`); a clean stop of a container in
 * `refused` is rejected at once. A forced stop always works. `log` records every state change and effect.
 */
export function fakeIncus() {
  const instances = new Map<string, FakeInstance>();
  const volumes = new Map<string, FakeVolume>();
  const stuck = new Set<string>();
  const refused = new Set<string>();
  /** Set to refuse an instance PUT (true: Incus answers with an error). */
  const faults: { put?: (name: string, body: any) => boolean } = {};
  /** The time snapshot.ts sees (loadSnapshot): its waits move it, and so does a stop that times out. */
  const clock = { t: 0 };
  const log: string[] = [];
  let macs = 0;
  const notFound = { type: 'error', error_code: 404, status_code: 404 };
  const ok = (metadata?: unknown) => ({ type: 'sync', status_code: 200, metadata });
  function addInstance(name: string, status: FakeInstance['status'], extra: Partial<FakeInstance> = {}) {
    const devices = extra.devices ?? { eth0: { type: 'nic', network: 'yeapp1' }, root: { type: 'disk', path: '/', pool: 'default' } };
    instances.set(name, { name, status, profiles: ['default'], devices, expanded_devices: structuredClone(devices),
      ...extra, config: { 'volatile.uuid': `uuid-${name}`, 'volatile.base_image': `image-${name}`, 'image.id': `image-${name}`,
        'volatile.eth0.hwaddr': `10:66:6a:00:00:${String(++macs).padStart(2, '0')}`, ...extra.config } });
  }
  function addVolume(name: string, users: string[], data: string, appId = 'fixture') {
    volumes.set(name, { name, description: '', content_type: 'filesystem', data, snapshots: new Map(),
      config: { 'user.youeye.kind': 'app', 'user.youeye.app_id': appId },
      used_by: users.map(user => `/1.0/instances/${user}`) });
  }
  async function incusRequest(method: string, url: string, body?: any): Promise<any> {
    const parts = url.split('?')[0].split('/').slice(2).map(decodeURIComponent);
    if (parts[0] === 'instances') {
      const instance = instances.get(parts[1]);
      if (parts[2] === 'state') {
        if (!instance) return notFound;
        if (method === 'GET') return ok({ status: instance.status });
        if (body.action === 'start') { log.push(`start:${instance.name}`); instance.status = 'Running'; }
        else if (body.force) { log.push(`kill:${instance.name}`); instance.status = 'Stopped'; }
        else {
          log.push(`stop:${instance.name}:${body.timeout}`);
          if (refused.has(instance.name)) return { type: 'error', error_code: 500, status_code: 500, error: 'Instance is busy running a "stop" operation' };
          if (stuck.has(instance.name)) clock.t += body.timeout * 1000;
          else instance.status = 'Stopped';
        }
        return ok();
      }
      if (method === 'GET') return instance ? ok(structuredClone(instance)) : notFound;
      if (method === 'POST' && !parts[1]) {
        const source = instances.get(body.source.source)!;
        log.push(`copy:${source.name}>${body.name}`);
        // The worst case seen live: a copy comes back with new MAC addresses.
        const config = Object.fromEntries(Object.entries({ ...source.config, ...body.config })
          .filter(([key]) => !/^volatile\..*\.hwaddr$/.test(key) && key !== 'volatile.uuid'));
        const devices = body.devices ?? structuredClone(source.devices);
        instances.set(body.name, { ...structuredClone(source), name: body.name, status: 'Stopped',
          config: { ...config, 'volatile.uuid': `uuid-${body.name}` }, devices, expanded_devices: structuredClone(devices) });
        return ok();
      }
      if (!instance) return notFound;
      if (method === 'PUT') {
        if (faults.put?.(instance.name, body)) return { type: 'error', error_code: 400, status_code: 400, error: 'Invalid config' };
        const before = instance.devices;
        Object.assign(instance, { config: body.config ?? instance.config, devices: body.devices ?? instance.devices,
          profiles: body.profiles ?? instance.profiles });
        // As Incus does (deviceResetVolatile): a device added or whose type changed loses its volatile keys, even
        // ones set in the same request. Seen live: a NIC masked as `none` and put back got a new MAC.
        for (const [name, device] of Object.entries(instance.devices)) {
          if (before[name]?.type === device.type) continue;
          instance.config = Object.fromEntries(Object.entries(instance.config)
            .filter(([key]) => !key.startsWith(`volatile.${name}.`)));
        }
        instance.expanded_devices = structuredClone(instance.devices);
        return ok();
      }
      if (method === 'POST') {
        log.push(`rename:${instance.name}>${body.name}`);
        instances.delete(instance.name);
        instances.set(body.name, { ...instance, name: body.name });
        return ok();
      }
      if (method === 'DELETE') { log.push(`delete:${instance.name}`); instances.delete(instance.name); return ok(); }
      if (method === 'PATCH') {
        log.push(`patch:${instance.name}`);
        instance.config = { ...instance.config, ...body.config };
        return ok();
      }
    }
    if (parts[0] === 'storage-pools') {
      const volume = volumes.get(parts[4]);
      if (!volume) return notFound;
      if (parts[5] === 'snapshots') {
        if (method === 'POST') {
          log.push(`snapshot:${volume.name}`);
          volume.snapshots.set(body.name, { description: volume.description, data: volume.data });
          return ok();
        }
        const snapshot = volume.snapshots.get(parts[6]);
        if (!snapshot) return notFound;
        if (method === 'DELETE') { volume.snapshots.delete(parts[6]); return ok(); }
        return ok({ name: parts[6], description: snapshot.description, config: volume.config, content_type: 'filesystem', used_by: [] });
      }
      if (method === 'GET') return ok({ ...structuredClone({ ...volume, snapshots: undefined, data: undefined }) });
      if (body.restore) {
        log.push(`restore:${volume.name}`);
        volume.data = volume.snapshots.get(body.restore)!.data;
      } else volume.description = body.description ?? volume.description;
      return ok();
    }
    throw new Error(`fake Incus: ${method} ${url}`);
  }
  return { instances, volumes, stuck, refused, faults, clock, log, addInstance, addVolume, incusRequest };
}

/** The real snapshot.ts (clean stop, forced stop, timeouts) over a fake Incus. */
export function loadSnapshot(incus: ReturnType<typeof fakeIncus>) {
  // Waiting costs no real time: a wait moves the fake's clock and resumes at once.
  const setTimeout = (run: () => void, ms = 0) => { incus.clock.t += ms; return setImmediate(run); };
  return loadSource('lib/incus/snapshot.ts', (name) => name === './server'
    ? { incusRequest: incus.incusRequest, execShell: async () => ({ stdout: 'ready' }) } : {},
  { Date: { now: () => incus.clock.t }, setTimeout });
}

/**
 * The real update-provider.ts over a fake Incus, with the real stop helpers, container order and preflight error;
 * everything else comes from `stubs` (by import name) or is empty.
 */
export function loadUpdateProvider(incus: ReturnType<typeof fakeIncus>, stubs: Record<string, unknown> = {}) {
  const journal = { updateResourceKey: (r: { kind: string; name: string }) => `${r.kind}:${r.name}` };
  const real: Record<string, unknown> = {
    '@/lib/incus/server': { incusRequest: incus.incusRequest },
    '@/lib/incus/snapshot': loadSnapshot(incus),
    '@/lib/apps/container-order': containerOrder(),
    '@/lib/apps/container-readiness': loadSource('lib/apps/container-readiness.ts', () => ({})),
    './update-journal': journal,
    './update-inventory': loadSource('lib/market/update-inventory.ts', () => journal),
  };
  return loadSource('lib/market/update-provider.ts', (name) => stubs[name] ?? real[name] ?? {});
}
