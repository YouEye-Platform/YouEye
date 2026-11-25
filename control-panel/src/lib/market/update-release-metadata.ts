import { isDeepStrictEqual } from 'node:util';
import type { AppManifest, InstallMetadata } from './types';
import type { InstalledApp, InstalledAppUpdateState } from './installed-apps';
import { AppUpdateWorkspace, updateDigest } from './update-workspace';
import { updateResourceKey, type AppUpdateRecord, type UpdateResource, type UpdateCheckpoint, type AppUpdateJournalStore } from './update-journal';
import { runAppUpdateTransaction, type AppUpdateProvider } from './update-transaction';
import type { InstalledProductReceipt, VerifiedProductRelease } from '../releases/product-release';
import { youeyeRequirementProblem } from './app-format/requires';
import { isNewer } from '../version';

const fields = ['installedVersion', 'nativeArtifacts', 'manifestPath', 'manifestRepo', 'manifestBranch', 'manifestDigest'] as const;
const installedFields = ['installedVersion', 'catalogVersion', 'updateAvailable', 'switchPending',
  'installedTag', 'installedBranch', 'channelSource', 'candidateVersion', 'candidateBranch', 'candidateTag'] as const;
function installedState(app: InstalledApp): InstalledAppUpdateState {
  return Object.fromEntries(installedFields.map(key => [key, app[key] ?? null])) as InstalledAppUpdateState;
}
function registration(metadata: InstallMetadata) {
  return Object.fromEntries(fields.map(key => [key, metadata[key]]));
}
/** A value as storage keeps it. A compiled manifest has own keys whose value is `undefined` (`requires`, `apiKey`,
 * `backup`…); the recovery plan and the registration are JSON, which drops them, so a manifest read from one is
 * compared with a compiled one in this form. */
const stored = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sameStored = (a: unknown, b: unknown) => isDeepStrictEqual(stored(a), stored(b));
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
  /** A market version installed now: installed-apps.json takes it, with the channel release tag and repository cleared. */
  catalogProvenance(appId: string, version: string): Promise<void>;
  manifest(appId: string, version: string): Promise<AppManifest>;
  syncManifest(appId: string, manifest: AppManifest): Promise<void>;
  verifyProjection(projection: Projection): Promise<void>;
  publishProjection(projection: Projection): Promise<void>;
  health(metadata: InstallMetadata): Promise<void>;
  /** Whether every container of the app runs (a stopped app takes the ordinary update instead). */
  running?(metadata: InstallMetadata): Promise<boolean>;
  /** The installed YouEye release, which a manifest's `requires.youeye` is checked against. */
  platformVersion?(): Promise<string>;
}
const runtimeIO: ReleaseMetadataIO = {
  metadata: async id => (await import('./metadata')).readInstallMetadata(id),
  save: async m => (await import('./metadata')).saveInstallMetadata(m),
  installed: async id => (await import('./installed-apps')).getInstalledApp(id),
  restoreInstalled: async (id, state) => (await import('./installed-apps')).restoreInstalledAppUpdateState(id, state),
  provenance: async (id, selected) => (await import('./installed-apps')).recordAppProvenance(id,
    {version:selected.release.version, tag:selected.release.tag, branch:null, source:selected.repository}),
  catalogProvenance: async (id, version) => (await import('./installed-apps')).recordCatalogAppUpdate(id, version),
  manifest: async (id, version) => (await import('./frozen-manifest')).readFrozenUpdateManifest(id, version),
  syncManifest: async (id, m) => (await import('./ui-manifest-sync')).syncAppManifestObjectToUI(id, m as unknown as Record<string, unknown>),
  verifyProjection: async p => (await import('../releases/product-projection')).verifyProductProjection(p.container, p.receipt, p.runtimeUUID),
  publishProjection: async p => {
    const api = await import('../releases/product-projection');
    if (await api.productRuntimeIdentity(p.container) !== p.runtimeUUID) throw new Error('Product runtime was replaced');
    if (await api.publishProductProjection(p.container, p.receipt) !== p.runtimeUUID) throw new Error('Product runtime was replaced');
  },
  running: async metadata => {
    const { containerState } = await import('../incus/snapshot');
    for (const c of metadata.containers) if (await containerState(c.containerName) !== 'Running') return false;
    return true;
  },
  platformVersion: async () => (await (await import('./platform-env')).getPlatformContext()).version,
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
      || !sameStored(await this.io.manifest(record.appId, p.before.installedVersion!), p.manifest)) throw new Error('Restored release registration differs');
    for (const projection of p.projections) await this.io.verifyProjection(projection);
    // A move to the market (no projections) touched no runtime: its rollback is verified by the records alone, so a
    // recovery right after a reboot, before Incus started the app, does not need the app to run.
    if (p.projections.length) await this.io.health(current);
  }
  async reopen() { /* Payload runtime remained running; lifecycle reservation releases after cleanup. */ }
  async cleanup(record: AppUpdateRecord) { this.workspace(record).remove(); }
}

/**
 * A native app installed before 0.6.20 from the box's channel: its record names a channel release (`manifestPath:
 * youeye-app.yaml` with the release repository and tag, a product release receipt in `nativeArtifacts`). From 0.6.20
 * native apps are Market apps (YE-142), and such a record moves to its market (`adoptNativeMarketManifest`).
 */
export function isChannelInstalledNative(meta: Pick<InstallMetadata, 'integration' | 'manifestPath' | 'nativeArtifacts'> | null | undefined): boolean {
  if (!meta || meta.integration !== 'native') return false;
  return meta.manifestPath === 'youeye-app.yaml'
    || (meta.nativeArtifacts ?? []).some((artifact) => Boolean(artifact.productRelease) || artifact.verification === 'product-release');
}

/**
 * What a native app runs, from its manifest: everything but its name for people (the version), what it needs of the
 * box (`requires`), where its package is downloaded from (`source.package`, checked separately by SHA-256), its listing
 * (text and pictures) and the frozen source text. Two manifests with the same runtime contract configure the same
 * running app the same way.
 */
export function runtimeContract(manifest: AppManifest): unknown {
  const { version: _version, requires: _requires, frozen: _frozen, detail: _detail, metadata, ...rest } = manifest;
  return stored({
    ...rest,
    metadata: { id: metadata.id, name: metadata.name, defaultSubdomain: metadata.defaultSubdomain },
    containers: manifest.containers.map((container) => container.source
      ? { ...container, source: { node: container.source.node } } : container),
  });
}

/**
 * Whether an installed native app's record does not name the market's manifest (`digest`, the market's frozen digest):
 * a channel record (before 0.6.20, YE-142), or a market record whose manifest the market has changed since (YE-194).
 * The same package under the same manifest is up to date.
 */
export function nativeManifestChanged(meta: Pick<InstallMetadata, 'integration' | 'manifestPath' | 'nativeArtifacts' | 'manifestDigest'> | null | undefined,
  digest: string | null | undefined): boolean {
  if (!meta || meta.integration !== 'native' || !digest) return false;
  return isChannelInstalledNative(meta) || meta.manifestDigest !== digest;
}

export type NativeMoveOutcome =
  | { moved: true; previousVersion: string; version: string; fromChannel: boolean }
  | { moved: false; reason: 'same-manifest' | 'no-package' | 'package-differs' | 'contract-differs' | 'needs-youeye' | 'older-version' | 'stopped'; detail: string };

/**
 * Whether a manifest for the package a native app runs names a lower version than its Market record (YE-212). A Market
 * record's version is the market's own name, so a lower one is never taken or offered, as for any app. A channel
 * record (before 0.6.20, YE-142) names a channel release, another scheme: its move to the market is not ordered by it.
 */
export function olderMarketVersion(meta: Pick<InstallMetadata, 'integration' | 'manifestPath' | 'nativeArtifacts' | 'installedVersion'> | null | undefined,
  version: string | null | undefined): boolean {
  if (!meta || meta.integration !== 'native' || !meta.installedVersion || !version || isChannelInstalledNative(meta)) return false;
  return isNewer(meta.installedVersion, version);
}

/**
 * Re-record an installed native app on its market's manifest when that manifest pins the very package the app runs
 * (`source.package.sha256` equal to every installed `standalone.tar`) and configures the same runtime
 * (`runtimeContract`): one metadata-only transaction. It serves two cases:
 * - a native app installed from the channel before 0.6.20 moves to its market (YE-142);
 * - a Market native app takes a new manifest its market published for the same package (a new version name, listing,
 *   `requires`; YE-194).
 * What it writes:
 * - the install record's manifest fields name the market's manifest (`apps/<id>/youeye-app.yaml`, the market's address
 *   and commit, its frozen digest), and the dashboard registration's frozen copy becomes the market's;
 * - `installedVersion` becomes the market's version; `nativeArtifacts` keeps every package (SHA-256, size) with
 *   `verification: 'manifest'`;
 * - installed-apps.json takes the market version with `installedTag` and `channelSource` cleared.
 * Nothing is downloaded or restarted; secrets, the app token, the sign-in client, volumes and the database are keyed by
 * the app id and are not touched; `sourceId`/`catalogKey` stay. The journal checkpoint and recovery are the ordinary
 * ones (`ReleaseMetadataUpdateProvider`): an interrupted transaction is rolled back to the record before and verified.
 * Anything else is not adopted here and says why: the same manifest is up to date, another package is an ordinary
 * update by version, another runtime contract is an ordinary update of the same package (it restarts the app with the
 * new configuration), a stopped app waits (the next check tries again). A manifest whose `requires.youeye` this box
 * does not meet waits for the YouEye update (YE-212: a YouEye update restarts the Control Panel, and the first check
 * after it takes the manifest), and a lower version name than a Market record's is never taken: the record keeps
 * naming what the box runs and can honour.
 */
export async function adoptNativeMarketManifest(
  store: AppUpdateJournalStore, before: InstallMetadata, installed: InstalledApp,
  manifest: AppManifest, reference: {path:string;repo:string;branch:string;digest:string}, io = runtimeIO,
): Promise<NativeMoveOutcome> {
  const no = (reason: Extract<NativeMoveOutcome, {moved:false}>['reason'], detail: string): NativeMoveOutcome => ({ moved: false, reason, detail });
  if (!nativeManifestChanged(before, reference.digest)) return no('same-manifest', `${before.appId} already runs the market's manifest`);
  const fromChannel = isChannelInstalledNative(before);
  const lxd = manifest.containers.filter(c => c.type === 'lxd');
  const pkg = lxd.length === 1 ? lxd[0].source?.package : undefined;
  if (!pkg || manifest.integration !== 'native') return no('no-package', `the market's ${before.appId} names no native package`);
  const artifacts = before.nativeArtifacts ?? [];
  if (!artifacts.length || artifacts.some(a => a.sha256 !== pkg.sha256)) {
    return no('package-differs', `the market's ${before.appId} ${manifest.version} is another package than the installed one`);
  }
  if (artifacts.length !== 1 || artifacts[0].containerName !== lxd[0].name) {
    return no('contract-differs', `the installed package record of ${before.appId} does not match the market's container`);
  }
  // What the ordinary update would refuse is not recorded either (YE-212): the record would name a manifest this box
  // cannot honour, or a version below the one it holds.
  const requirement = io.platformVersion ? youeyeRequirementProblem(manifest.requires, await io.platformVersion()) : null;
  if (requirement) return no('needs-youeye', `the market's ${before.appId} ${manifest.version}: ${requirement}`);
  if (!fromChannel && olderMarketVersion(before, manifest.version)) {
    return no('older-version', `the market's ${before.appId} ${manifest.version} is older than the installed ${before.installedVersion}`);
  }
  // Adoption checks the running app's health: a stopped app (the owner stopped it) is adopted at a later check.
  if (io.running && !await io.running(before)) return no('stopped', `${before.appId} is stopped; it moves to its market once it runs`);
  const installedVersion = before.installedVersion;
  if (!installedVersion) throw new Error('Installed native app version is missing');
  const oldManifest = await io.manifest(before.appId, installedVersion);
  if (!isDeepStrictEqual(runtimeContract(manifest), runtimeContract(oldManifest))) {
    return no('contract-differs', `the market's ${before.appId} configures the app differently than the installed copy`);
  }
  if (!manifest.frozen || reference.digest !== manifest.frozen.digest) throw new Error('Market manifest reference differs from its frozen digest');
  const version = manifest.version;
  const next = structuredClone(before);
  next.installedVersion = version;
  next.manifestPath = reference.path; next.manifestRepo = reference.repo;
  next.manifestBranch = reference.branch; next.manifestDigest = reference.digest;
  next.nativeArtifacts = artifacts.map(a => ({ containerName: a.containerName, sourceRepo: pkg.url, releaseTag: version, version,
    artifactName: a.artifactName, sha256: a.sha256, bytes: a.bytes, verification: 'manifest' as const }));
  const resources: UpdateResource[] = [
    {kind:'app',scope:'market',name:before.appId,ownerAppId:before.appId,mutable:false},
    {kind:'metadata',scope:'market',name:before.appId,ownerAppId:before.appId,mutable:true},
    ...before.containers.map(c => ({kind:'container' as const,scope:'incus',name:c.containerName,ownerAppId:before.appId,mutable:false})),
  ];
  const provider = new ReleaseMetadataUpdateProvider(store.directory,
    {before, installed:installedState(installed), manifest:oldManifest, projections:[]}, io);
  const result = await runAppUpdateTransaction(store, {
    appId:before.appId,operationKind:'release-metadata',resources,
    originalRunning:Object.fromEntries(before.containers.map(c => [c.containerName,true])),
    metadataBeforeSHA256:updateDigest(JSON.stringify(before)),
    source:{manifestSHA256:updateDigest(JSON.stringify(oldManifest)),artifactSHA256:artifacts.map(a => a.sha256)},
    target:{manifestSHA256:updateDigest(JSON.stringify(manifest)),artifactSHA256:artifacts.map(a => a.sha256)},
  }, provider, async transaction => {
    await transaction.mutate('publish-ui-manifest', () => io.syncManifest(before.appId, manifest));
    await transaction.mutate('publish-install-metadata', async () => {
      const current = await io.metadata(before.appId);
      if (!current || !isDeepStrictEqual(registration(current), registration(before))) throw new Error('Installed release registration changed');
      for (const key of fields) {
        if (Object.hasOwn(next, key)) Object.assign(current, {[key]:next[key]});
        else delete current[key];
      }
      await io.save(current);
    });
    await transaction.mutate('publish-provenance', () => io.catalogProvenance(before.appId, version));
    transaction.verifying();
    await transaction.mutate('verify-existing-runtime-health', () => io.health(next));
    const saved = await io.metadata(before.appId), registered = await io.installed(before.appId);
    // The installed copy is rebuilt from the registration's frozen source, so it is the market's manifest as its text
    // says (the listing's pictures named as in the manifest), not the copy the market resolved them in: compare the
    // frozen source, its digest and version, and the runtime contract.
    const copy = await io.manifest(before.appId, version);
    if (!saved || !registered || !isDeepStrictEqual(registration(saved),registration(next))
      || registered.installedVersion !== version || registered.installedTag !== null || registered.channelSource !== null
      || copy.version !== version || copy.frozen?.digest !== manifest.frozen!.digest || copy.frozen?.manifest !== manifest.frozen!.manifest
      || !isDeepStrictEqual(copy.frozen?.setups ?? {}, manifest.frozen!.setups ?? {})
      || !isDeepStrictEqual(runtimeContract(copy), runtimeContract(manifest))) throw new Error('Market manifest adoption did not converge');
    return {value:{success:true as const,previousVersion:installedVersion,newVersion:version,migrationsRun:0 as const},metadataDigest:updateDigest(JSON.stringify(saved))};
  });
  return { moved: true, previousVersion: result.previousVersion, version: result.newVersion, fromChannel };
}
