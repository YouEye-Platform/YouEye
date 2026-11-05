import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { writeJsonAtomically } from '../bridges/atomic-json-store';
import {
  acceptProductSequence, identicalProductPayloads, parseProductRelease, productReceipt,
  verifyInstalledProductReceipt, type InstalledProductReceipt, type ProductSequenceFloors, type VerifiedProductRelease,
} from '../releases/product-release';
import { productRuntimeIdentity, publishProductProjection, verifyProductProjection } from '../releases/product-projection';
import { AppUpdateWorkspace, updateDigest } from '../market/update-workspace';
import { updateResourceKey, type AppUpdateJournalStore, type AppUpdateRecord, type UpdateCheckpoint, type UpdateResource } from '../market/update-journal';
import { runAppUpdateTransaction, type AppUpdateProvider } from '../market/update-transaction';

const FILE = '/var/lib/youeye/state/pointer-release/installed.json';
const CONTAINER = 'youeye-pointer';
export type PointerReleaseState = {
  schema: 'youeye.installed-pointer.v1';
  installed: {receipt: InstalledProductReceipt; runtimeUUID: string; acceptedAt?: string} | null;
  floors: ProductSequenceFloors;
};
export function pointerRelease(state: PointerReleaseState): VerifiedProductRelease | null {
  if (!state.installed) return null;
  const {release} = parseProductRelease(Buffer.from(state.installed.receipt.manifestBase64,'base64'));
  const selected = verifyInstalledProductReceipt(state.installed.receipt,{product:'pointer',source:release.source,tag:release.tag});
  if (selected.build.kind !== 'native' || !/^[a-f0-9-]{36}$/i.test(state.installed.runtimeUUID)) throw new Error('Invalid installed Pointer identity');
  const key = updateDigest(`${release.source}\0${release.branch}`), floor = state.floors[key];
  if (!floor || floor.source !== release.source || floor.branch !== release.branch || !Number.isSafeInteger(floor.sequence)
    || floor.sequence < release.sequence || !/^[0-9a-f]{64}$/.test(floor.manifestSHA256)
    || floor.sequence === release.sequence && floor.manifestSHA256 !== selected.manifestSHA256) throw new Error('Invalid Pointer release replay floor');
  return selected;
}
export async function readPointerReleaseState(filePath = FILE): Promise<PointerReleaseState> {
  let file;
  try { file = await open(filePath,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {schema:'youeye.installed-pointer.v1',installed:null,floors:{}};
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 4 * 1024 * 1024) throw new Error('Insecure installed Pointer release');
    const state = JSON.parse(await file.readFile('utf8')) as PointerReleaseState;
    if (state.schema !== 'youeye.installed-pointer.v1' || !state.floors || typeof state.floors !== 'object' || Array.isArray(state.floors)) throw new Error('Invalid Pointer release state');
    pointerRelease(state);
    return state;
  } finally { await file.close(); }
}
export async function savePointerReleaseState(state: PointerReleaseState, filePath = FILE): Promise<void> {
  pointerRelease(state);
  await writeJsonAtomically(filePath,state);
}

export interface PointerReleaseIO {
  read(): Promise<PointerReleaseState>;
  save(state: PointerReleaseState): Promise<void>;
  verify(installed: NonNullable<PointerReleaseState['installed']>): Promise<void>;
  publish(installed: NonNullable<PointerReleaseState['installed']>): Promise<void>;
  health(): Promise<void>;
}
const runtimeIO: PointerReleaseIO = {
  read:readPointerReleaseState,save:savePointerReleaseState,
  verify:p=>verifyProductProjection(CONTAINER,p.receipt,p.runtimeUUID),
  publish:async p=>{
    if (await productRuntimeIdentity(CONTAINER) !== p.runtimeUUID) throw new Error('Pointer runtime was replaced');
    if (await publishProductProjection(CONTAINER,p.receipt) !== p.runtimeUUID) throw new Error('Pointer runtime was replaced');
  },
  health:async()=>{
    const {healthCheckViaExec} = await import('../incus/snapshot');
    await healthCheckViaExec(CONTAINER,4001,'/readyz',3);
  },
};

/** Pointer has its own installation record; it is not a synthetic Market app.
 * Recovery shares the platform's journal and changes only the accepted label. */
export class PointerReleaseMetadataProvider implements AppUpdateProvider {
  constructor(private readonly root: string, private readonly initial?: PointerReleaseState, private readonly io = runtimeIO) {}
  private workspace(record: AppUpdateRecord) { return new AppUpdateWorkspace(this.root,record.id); }
  private before(record: AppUpdateRecord): PointerReleaseState {
    if (record.operationKind !== 'pointer-release-metadata' || record.appId !== 'pointer') throw new Error('Wrong Pointer recovery operation');
    const checkpoint = record.checkpoints.find(c=>c.method === 'scoped-metadata');
    const raw = this.workspace(record).get('pointer-release',checkpoint?.sha256);
    if (updateDigest(raw) !== record.metadataBeforeSHA256) throw new Error('Pointer recovery state differs');
    const before = JSON.parse(raw.toString()) as PointerReleaseState;
    if (pointerRelease(before)?.manifestSHA256 !== record.source.manifestSHA256) throw new Error('Pointer recovery source differs');
    return before;
  }
  async initialize(record: AppUpdateRecord) {
    if (!this.initial || updateDigest(JSON.stringify(await this.io.read())) !== record.metadataBeforeSHA256) throw new Error('Pointer registration changed before admission');
    this.workspace(record).put('pointer-release',Buffer.from(JSON.stringify(this.initial)));
    this.before(record);
  }
  async quiesce(record: AppUpdateRecord) { await this.io.verify(this.before(record).installed!); await this.io.health(); }
  async checkpoint(record: AppUpdateRecord, resource: UpdateResource): Promise<UpdateCheckpoint> {
    if (resource.kind !== 'metadata') throw new Error('Pointer label update cannot checkpoint payloads');
    const sha256 = this.workspace(record).put('pointer-release',Buffer.from(JSON.stringify(this.before(record))));
    return {resource:updateResourceKey(resource),method:'scoped-metadata',reference:'pointer-release',sha256,verifiedAt:new Date().toISOString()};
  }
  async validateCheckpoints(record: AppUpdateRecord) { this.before(record); }
  private changed(record: AppUpdateRecord) { return record.steps.some(s=>s.phase === 'applying' || s.phase === 'verifying'); }
  async restore(record: AppUpdateRecord) {
    if (!this.changed(record)) return;
    const before = this.before(record), current = await this.io.read();
    await this.io.publish(before.installed!);
    await this.io.save({...before,floors:current.floors});
  }
  async verifyRestored(record: AppUpdateRecord) {
    if (!this.changed(record)) return;
    const before = this.before(record), current = await this.io.read();
    if (!isDeepStrictEqual(before.installed,current.installed)) throw new Error('Pointer label recovery differs');
    await this.io.verify(before.installed!); await this.io.health();
  }
  async reopen() { /* Pointer remained running; only the lifecycle reservation is released. */ }
  async cleanup(record: AppUpdateRecord) { this.workspace(record).remove(); }
}

/** False means changed payloads or an older install without this receipt. */
export async function updateIdenticalPointerRelease(store: AppUpdateJournalStore, selected: VerifiedProductRelease, io = runtimeIO): Promise<boolean> {
  const before = await io.read(), original = pointerRelease(before);
  if (!original || !identicalProductPayloads(original,selected)) return false;
  const next: PointerReleaseState = {...before,installed:{...before.installed!,receipt:productReceipt(selected),acceptedAt:new Date().toISOString()},floors:acceptProductSequence(before.floors,selected)};
  pointerRelease(next);
  const artifacts = original.build.assets.filter(a=>a.name === 'standalone.tar').map(a=>a.sha256);
  await runAppUpdateTransaction(store, {
    appId:'pointer',operationKind:'pointer-release-metadata',metadataBeforeSHA256:updateDigest(JSON.stringify(before)),
    originalRunning:{[CONTAINER]:true},source:{manifestSHA256:original.manifestSHA256,artifactSHA256:artifacts},
    target:{manifestSHA256:selected.manifestSHA256,artifactSHA256:artifacts},
    resources:[{kind:'app',scope:'market',name:'pointer',ownerAppId:'pointer',mutable:false},
      {kind:'metadata',scope:'pointer',name:'release',ownerAppId:'pointer',mutable:true},
      {kind:'container',scope:'incus',name:CONTAINER,ownerAppId:'pointer',mutable:false}],
  },new PointerReleaseMetadataProvider(store.directory,before,io),async transaction=>{
    // Preserve the accepted sequence through recovery even if projection
    // publication is interrupted; recovery may restore its prior display.
    await transaction.mutate('save-pointer-release',()=>io.save(next));
    await transaction.mutate('publish-pointer-label',()=>io.publish(next.installed!));
    transaction.verifying();
    await transaction.mutate('verify-pointer-label',()=>io.verify(next.installed!));
    await transaction.mutate('verify-pointer-health',()=>io.health());
    const saved = await io.read();
    if (!isDeepStrictEqual(saved,next)) throw new Error('Pointer registration did not converge');
    return {value:true,metadataDigest:updateDigest(JSON.stringify(saved))};
  });
  return true;
}
