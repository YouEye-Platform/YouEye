import { isDeepStrictEqual } from 'node:util';
import type { AppManifest, InstallMetadata } from './types';
import { sameMarketInstallContract } from './native-artifact';
import type { InstalledApp, InstalledAppUpdateState } from './installed-apps';
import { AppUpdateWorkspace, updateDigest } from './update-workspace';
import { updateResourceKey, type AppUpdateRecord, type UpdateResource, type UpdateCheckpoint, type AppUpdateJournalStore } from './update-journal';
import { runAppUpdateTransaction, type AppUpdateProvider } from './update-transaction';
import { acceptProductSequence, identicalProductPayloads, productReceipt, verifyInstalledProductReceipt,
  type InstalledProductReceipt, type VerifiedProductRelease } from '../releases/product-release';

const fields = ['installedVersion', 'nativeArtifacts', 'manifestPath', 'manifestRepo', 'manifestBranch', 'manifestDigest'] as const;
const installedFields = ['installedVersion', 'catalogVersion', 'updateAvailable', 'switchPending',
  'installedTag', 'installedBranch', 'channelSource', 'candidateVersion', 'candidateBranch', 'candidateTag'] as const;
function installedState(app: InstalledApp): InstalledAppUpdateState {
  return Object.fromEntries(installedFields.map(key => [key, app[key] ?? null])) as InstalledAppUpdateState;
}
function registration(metadata: InstallMetadata) {
  return Object.fromEntries(fields.map(key => [key, metadata[key]]));
}
type Projection = { container: string; runtimeUUID: string; receipt: InstalledProductReceipt };
type RecoveryPlan = {
  before: InstallMetadata; installed: InstalledAppUpdateState; manifest: AppManifest; projections: Projection[];
};
export interface ReleaseMetadataIO {
  metadata(appId: string): Promise<InstallMetadata | null>;
  save(metadata: InstallMetadata): Promise<void>;
  installed(appId: string): Promise<InstalledApp | null>;
  restoreInstalled(appId: string, state: InstalledAppUpdateState): Promise<void>;
  provenance(appId: string, selected: VerifiedProductRelease): Promise<void>;
  manifest(appId: string, version: string): Promise<AppManifest>;
  syncManifest(appId: string, manifest: AppManifest): Promise<void>;
  verifyProjection(projection: Projection): Promise<void>;
  publishProjection(projection: Projection): Promise<void>;
  health(metadata: InstallMetadata): Promise<void>;
}
const runtimeIO: ReleaseMetadataIO = {
  metadata: async id => (await import('./metadata')).readInstallMetadata(id),
  save: async m => (await import('./metadata')).saveInstallMetadata(m),
  installed: async id => (await import('./installed-apps')).getInstalledApp(id),
  restoreInstalled: async (id, state) => (await import('./installed-apps')).restoreInstalledAppUpdateState(id, state),
  provenance: async (id, {release:r}) => (await import('./installed-apps')).recordAppProvenance(id,
    {version:r.version, tag:r.tag, branch:r.branch, source:r.source}),
  manifest: async (id, version) => (await import('./frozen-manifest')).readFrozenUpdateManifest(id, version),
  syncManifest: async (id, m) => (await import('./ui-manifest-sync')).syncAppManifestObjectToUI(id, m as unknown as Record<string, unknown>),
  verifyProjection: async p => (await import('../releases/product-projection')).verifyProductProjection(p.container, p.receipt, p.runtimeUUID),
  publishProjection: async p => {
    const api = await import('../releases/product-projection');
    if (await api.productRuntimeIdentity(p.container) !== p.runtimeUUID) throw new Error('Product runtime was replaced');
    if (await api.publishProductProjection(p.container, p.receipt) !== p.runtimeUUID) throw new Error('Product runtime was replaced');
  },
  health: async metadata => {
    const { containerState } = await import('../incus/snapshot');
    const { waitForAppHealth } = await import('./health');
    for (const c of metadata.containers) {
      if (await containerState(c.containerName) !== 'Running') throw new Error('Release metadata update requires the existing runtime to be running');
      if (c.port && c.role !== 'database' && !await waitForAppHealth(c.containerName, c.port, c.healthCheck?.path || '/', 15_000)) {
        throw new Error('Existing product runtime health failed');
      }
    }
  },
};

/** Uses the ordinary durable journal, but owns only registrations and projections.
 * No process, executable, volume, app database or credential is rewound. */
export class ReleaseMetadataUpdateProvider implements AppUpdateProvider {
  constructor(private readonly root: string, private readonly initial?: RecoveryPlan, private readonly io = runtimeIO) {}
  private workspace(record: AppUpdateRecord) { return new AppUpdateWorkspace(this.root, record.id); }
  private plan(record: AppUpdateRecord): RecoveryPlan {
    if (record.operationKind !== 'release-metadata') throw new Error('Wrong metadata recovery operation');
    const point = record.checkpoints.find(c => c.method === 'scoped-metadata');
    const p = JSON.parse(this.workspace(record).get('release-registration', point?.sha256).toString()) as RecoveryPlan;
    if (p.before.appId !== record.appId || updateDigest(JSON.stringify(p.before)) !== record.metadataBeforeSHA256
      || updateDigest(JSON.stringify(p.manifest)) !== record.source.manifestSHA256) throw new Error('Metadata recovery binding differs');
    return p;
  }
  async initialize(record: AppUpdateRecord) {
    if (!this.initial || updateDigest(JSON.stringify(await this.io.metadata(record.appId))) !== record.metadataBeforeSHA256) throw new Error('Installed metadata changed before admission');
    this.workspace(record).put('release-registration', Buffer.from(JSON.stringify(this.initial)));
    this.plan(record);
  }
  async quiesce(record: AppUpdateRecord) {
    // The existing app/core lifecycle reservation excludes mutations. Payload
    // writers can continue: this operation never touches their files or data.
    const p = this.plan(record);
    for (const projection of p.projections) await this.io.verifyProjection(projection);
    await this.io.health(p.before);
  }
  async checkpoint(record: AppUpdateRecord, resource: UpdateResource): Promise<UpdateCheckpoint> {
    if (resource.kind !== 'metadata') throw new Error('Metadata update cannot checkpoint payload resources');
    const sha256 = this.workspace(record).put('release-registration', Buffer.from(JSON.stringify(this.plan(record))));
    return {resource:updateResourceKey(resource), method:'scoped-metadata', reference:'release-registration', sha256, verifiedAt:new Date().toISOString()};
  }
  async validateCheckpoints(record: AppUpdateRecord) { this.plan(record); }
  private noEffects(record: AppUpdateRecord) {
    return !record.steps.some(s => s.phase === 'applying' || s.phase === 'verifying');
  }
  async restore(record: AppUpdateRecord) {
    // A death before recovery-plan publication cannot have changed a label.
    if (this.noEffects(record)) return;
    const p = this.plan(record);
    for (const projection of p.projections) await this.io.publishProjection(projection);
    await this.io.syncManifest(record.appId, p.manifest);
    const current = await this.io.metadata(record.appId);
    if (!current) throw new Error('Installed metadata disappeared');
    // Keep current credentials, ownership and monotonic sequence floors.
    for (const key of fields) {
      if (Object.hasOwn(p.before, key)) Object.assign(current, {[key]:p.before[key]});
      else delete current[key];
    }
    await this.io.save(current);
    await this.io.restoreInstalled(record.appId, p.installed);
  }
  async verifyRestored(record: AppUpdateRecord) {
    if (this.noEffects(record)) return;
    const p = this.plan(record), current = await this.io.metadata(record.appId), installed = await this.io.installed(record.appId);
    if (!current || !installed || !isDeepStrictEqual(registration(current), registration(p.before))
      || !isDeepStrictEqual(installedState(installed), p.installed)
      || !isDeepStrictEqual(await this.io.manifest(record.appId, p.before.installedVersion!), p.manifest)) throw new Error('Restored release registration differs');
    for (const projection of p.projections) await this.io.verifyProjection(projection);
    await this.io.health(current);
  }
  async reopen() { /* Payload runtime remained running; lifecycle reservation releases after cleanup. */ }
  async cleanup(record: AppUpdateRecord) { this.workspace(record).remove(); }
}

/** Returns null for legacy/new payloads. A matching build with a broken installed
 * receipt fails; it must not silently fall back to a replacement update. */
export async function updateIdenticalProductRelease(
  store: AppUpdateJournalStore, before: InstallMetadata, installed: InstalledApp,
  manifest: AppManifest, selected: VerifiedProductRelease,
  reference: {path:string;repo:string;branch:string;digest:string}, io = runtimeIO,
): Promise<{success:true;previousVersion:string;newVersion:string;migrationsRun:0} | null> {
  const artifacts = before.nativeArtifacts ?? [];
  if (!artifacts.length || artifacts.some(a => !a.productRelease || !a.runtimeUUID)) return null;
  const originals = artifacts.map(a => verifyInstalledProductReceipt(a.productRelease!,
    {product:before.appId, source:a.sourceRepo, tag:a.releaseTag}));
  if (!originals.every(p => identicalProductPayloads(p, selected))) return null;
  const installedVersion = before.installedVersion;
  if (!installedVersion) throw new Error('Installed product release version is missing');
  const oldManifest = await io.manifest(before.appId, installedVersion);
  if (!await sameMarketInstallContract(manifest, oldManifest, before)) throw new Error('Identical product payload has a different install contract');
  // Keep the already accepted catalog presentation/source projection when only
  // the release label changes. Its exact original signed contract is unchanged.
  manifest = {...oldManifest, version:selected.release.version};
  const projections = artifacts.map(a => {
    const container = before.containers.find(c => c.name === a.containerName);
    if (!container || a.sha256 !== selected.build.assets.find(b => b.name === a.artifactName)?.sha256) throw new Error('Installed artifact binding differs');
    return {container:container.containerName, runtimeUUID:a.runtimeUUID!, receipt:a.productRelease!};
  });
  const native = manifest.containers.filter(c => c.type === 'lxd');
  if (native.length !== artifacts.length || native.some(c => !artifacts.some(a => a.containerName === c.name))) throw new Error('Incomplete installed product receipt set');
  const next = structuredClone(before), r = selected.release;
  next.productReleaseFloors = acceptProductSequence(before.productReleaseFloors, selected);
  next.installedVersion = r.version;
  next.manifestPath = reference.path; next.manifestRepo = reference.repo;
  next.manifestBranch = reference.branch; next.manifestDigest = reference.digest;
  next.nativeArtifacts = artifacts.map(a => ({...a,sourceRepo:r.source, releaseTag:r.tag, version:r.version, productRelease:productReceipt(selected)}));
  const targetProjections = projections.map(p => ({...p,receipt:productReceipt(selected)}));
  const resources: UpdateResource[] = [
    {kind:'app',scope:'market',name:before.appId,ownerAppId:before.appId,mutable:false},
    {kind:'metadata',scope:'market',name:before.appId,ownerAppId:before.appId,mutable:true},
    ...before.containers.map(c => ({kind:'container' as const,scope:'incus',name:c.containerName,ownerAppId:before.appId,mutable:false})),
  ];
  const provider = new ReleaseMetadataUpdateProvider(store.directory,
    {before, installed:installedState(installed), manifest:oldManifest, projections}, io);
  return runAppUpdateTransaction(store, {
    appId:before.appId,operationKind:'release-metadata',resources,
    originalRunning:Object.fromEntries(before.containers.map(c => [c.containerName,true])),
    metadataBeforeSHA256:updateDigest(JSON.stringify(before)),
    source:{manifestSHA256:updateDigest(JSON.stringify(oldManifest)),artifactSHA256:artifacts.map(a => a.sha256)},
    target:{manifestSHA256:updateDigest(JSON.stringify(manifest)),artifactSHA256:artifacts.map(a => a.sha256)},
  }, provider, async transaction => {
    for (let i=0;i<targetProjections.length;i++) await transaction.mutate(`publish-release-${i}`, () => io.publishProjection(targetProjections[i]));
    await transaction.mutate('publish-ui-manifest', () => io.syncManifest(before.appId, manifest));
    await transaction.mutate('publish-install-metadata', async () => {
      const current = await io.metadata(before.appId);
      if (!current || !isDeepStrictEqual(registration(current), registration(before))) throw new Error('Installed release registration changed');
      for (const key of fields) {
        if (Object.hasOwn(next, key)) Object.assign(current, {[key]:next[key]});
        else delete current[key];
      }
      current.productReleaseFloors = acceptProductSequence(current.productReleaseFloors, selected);
      await io.save(current);
    });
    await transaction.mutate('publish-provenance', () => io.provenance(before.appId, selected));
    transaction.verifying();
    for (const p of targetProjections) await transaction.mutate(`verify-release-${targetProjections.indexOf(p)}`, () => io.verifyProjection(p));
    await transaction.mutate('verify-existing-runtime-health', () => io.health(next));
    const saved = await io.metadata(before.appId), registered = await io.installed(before.appId);
    if (!saved || !registered || !isDeepStrictEqual(registration(saved),registration(next))
      || registered.installedVersion !== r.version || registered.installedTag !== r.tag
      || registered.installedBranch !== r.branch || registered.channelSource !== r.source
      || !isDeepStrictEqual(await io.manifest(before.appId,r.version),manifest)) throw new Error('Release metadata did not converge');
    return {value:{success:true,previousVersion:installedVersion,newVersion:r.version,migrationsRun:0},metadataDigest:updateDigest(JSON.stringify(saved))};
  });
}
