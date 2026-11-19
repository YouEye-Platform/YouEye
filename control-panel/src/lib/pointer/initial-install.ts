import {
  acceptProductSequence, installedProductRelease, productReceipt, type InstalledProductReceipt, type ProductSequenceFloors, type VerifiedProductRelease,
} from '../releases/product-release';
import type { StagedMarketNativeArtifact } from '../market/native-artifact';
import { builtPointerRelease, type PointerReleaseState } from './release-metadata';

interface PointerDeployIO {
  read(): Promise<PointerReleaseState>;
  /** The `pointer` product of the box's channel index. */
  resolve(): Promise<VerifiedProductRelease>;
  stage(selected: VerifiedProductRelease): Promise<StagedMarketNativeArtifact>;
  deploy(artifact: StagedMarketNativeArtifact): Promise<void>;
  save(state: PointerReleaseState): Promise<void>;
  cleanup(): Promise<void>;
}

interface PointerConfigureIO {
  configure(): Promise<void>;
  healthy(): Promise<boolean>;
  publish(receipt: InstalledProductReceipt): Promise<string>;
  verify(receipt: InstalledProductReceipt, runtimeUUID: string): Promise<void>;
}

export interface PointerInitialInstallIO extends PointerDeployIO, PointerConfigureIO {}

export interface PointerBuildIO extends PointerDeployIO {
  /** Keep the service disabled until setup supplies the platform issuer. */
  defer(): Promise<void>;
  /** The deployed runtime's Incus identity. */
  identity(): Promise<string>;
}

export interface PointerActivateIO extends PointerConfigureIO {
  read(): Promise<PointerReleaseState>;
  identity(): Promise<string>;
  save(state: PointerReleaseState): Promise<void>;
}

/** Finish authentication and archive staging before touching an existing runtime. */
async function deployVerifiedPointer(io: PointerDeployIO): Promise<{ selected: VerifiedProductRelease; floors: ProductSequenceFloors }> {
  const before = await io.read();
  const selected = await io.resolve();
  const r = selected.release;
  const primary = selected.build.assets.find(a => a.name === 'standalone.tar');
  if (r.product !== 'pointer' || selected.build.kind !== 'native' || !primary) {
    throw new Error('Pointer product release is not a native Pointer build');
  }
  const floors = acceptProductSequence(before.floors, selected,
    installedProductRelease(before.installed?.receipt ?? before.built?.receipt, 'pointer'));
  const artifact = await io.stage(selected);
  if (artifact.verification.status !== 'product-release'
    || artifact.containerName !== 'youeye-pointer' || artifact.artifactSHA256 !== primary.sha256
    || artifact.sourceRepo !== selected.repository || artifact.tag !== r.tag || artifact.version !== r.version) {
    throw new Error('Pointer staged runtime differs from verified product release');
  }
  await io.deploy(artifact);
  return { selected, floors };
}

/** Configure, health-check and publish a deployed runtime, then accept it as installed. */
async function acceptConfiguredPointer(io: PointerConfigureIO & { save(state: PointerReleaseState): Promise<void> },
  receipt: InstalledProductReceipt, floors: ProductSequenceFloors, expectedRuntime?: string): Promise<void> {
  await io.configure();
  if (!(await io.healthy())) throw new Error('YouEye AI service did not become ready after managed configuration');
  const runtimeUUID = await io.publish(receipt);
  if (expectedRuntime && runtimeUUID !== expectedRuntime) throw new Error('Pointer runtime was replaced after it was built');
  await io.verify(receipt, runtimeUUID);
  await io.save({schema:'youeye.installed-pointer.v1', installed:{receipt,runtimeUUID,acceptedAt:new Date().toISOString()}, built:null, floors});
}

/** Full install: deploy, configure, publish. A failed deployment retains
 * persistent data but acquires no installed receipt. */
export async function installPointerRelease(io: PointerInitialInstallIO): Promise<void> {
  try {
    const { selected, floors } = await deployVerifiedPointer(io);
    await acceptConfiguredPointer(io, productReceipt(selected), floors);
  } finally {
    await io.cleanup();
  }
}

/**
 * First boot: deploy the verified release with its service disabled and record
 * the stage `built`. Setup later configures it (`activateBuiltPointerRelease`).
 * Nothing is recorded unless the runtime is fully deployed and deferred.
 */
export async function buildPointerRelease(io: PointerBuildIO): Promise<void> {
  try {
    const { selected, floors } = await deployVerifiedPointer(io);
    await io.defer();
    const runtimeUUID = await io.identity();
    await io.save({schema:'youeye.installed-pointer.v1', installed:null,
      built:{receipt:productReceipt(selected), runtimeUUID, builtAt:new Date().toISOString()}, floors});
  } finally {
    await io.cleanup();
  }
}

/**
 * `built` → configure → healthy → publish → installed. Returns false (and
 * changes nothing) when there is no built record for the current runtime, so
 * the caller falls back to recreating it.
 */
export async function activateBuiltPointerRelease(io: PointerActivateIO): Promise<boolean> {
  const state = await io.read();
  if (!builtPointerRelease(state) || !state.built) return false;
  if (await io.identity() !== state.built.runtimeUUID) return false;
  await acceptConfiguredPointer(io, state.built.receipt, state.floors, state.built.runtimeUUID);
  return true;
}

export type PointerPromoteIO = Pick<PointerActivateIO, 'read' | 'identity' | 'healthy' | 'verify' | 'save'>;

/**
 * A `built` record whose runtime was already configured and published (activation stopped after `publish`,
 * before `save`): once the runtime is healthy and its published projection matches the built receipt, record it
 * `installed`. Returns false (and changes nothing) when there is no built record for the current runtime.
 */
export async function promoteBuiltPointerRelease(io: PointerPromoteIO): Promise<boolean> {
  const state = await io.read();
  if (!builtPointerRelease(state) || !state.built) return false;
  const runtimeUUID = await io.identity();
  if (runtimeUUID !== state.built.runtimeUUID) return false;
  if (!(await io.healthy())) throw new Error('YouEye AI service did not become ready after managed configuration');
  await io.verify(state.built.receipt, runtimeUUID);
  await io.save({schema:'youeye.installed-pointer.v1', installed:{receipt:state.built.receipt,runtimeUUID,acceptedAt:new Date().toISOString()}, built:null, floors:state.floors});
  return true;
}
