import {
  acceptProductSequence, productReceipt, type InstalledProductReceipt, type VerifiedProductRelease,
} from '../releases/product-release';
import type { StagedMarketNativeArtifact } from '../market/native-artifact';
import type { PointerReleaseState } from './release-metadata';

export interface PointerInitialInstallIO {
  read(): Promise<PointerReleaseState>;
  /** The `pointer` product of the box's channel index. */
  resolve(): Promise<VerifiedProductRelease>;
  stage(selected: VerifiedProductRelease): Promise<StagedMarketNativeArtifact>;
  deploy(artifact: StagedMarketNativeArtifact): Promise<void>;
  configure(): Promise<void>;
  healthy(): Promise<boolean>;
  publish(receipt: InstalledProductReceipt): Promise<string>;
  verify(receipt: InstalledProductReceipt, runtimeUUID: string): Promise<void>;
  save(state: PointerReleaseState): Promise<void>;
  cleanup(): Promise<void>;
}

/** Finish authentication and archive staging before touching an existing runtime.
 * A failed deployment retains persistent data but acquires no installed receipt.
 */
export async function installPointerRelease(io: PointerInitialInstallIO): Promise<void> {
  try {
    const before = await io.read();
    const selected = await io.resolve();
    const r = selected.release;
    const primary = selected.build.assets.find(a => a.name === 'standalone.tar');
    if (r.product !== 'pointer' || selected.build.kind !== 'native' || !primary) {
      throw new Error('Pointer product release is not a native Pointer build');
    }
    const floors = acceptProductSequence(before.floors, selected);
    const artifact = await io.stage(selected);
    if (artifact.verification.status !== 'product-release'
      || artifact.containerName !== 'youeye-pointer' || artifact.artifactSHA256 !== primary.sha256
      || artifact.sourceRepo !== selected.repository || artifact.tag !== r.tag || artifact.version !== r.version) {
      throw new Error('Pointer staged runtime differs from verified product release');
    }
    await io.deploy(artifact);
    await io.configure();
    if (!(await io.healthy())) throw new Error('YouEye AI service did not become ready after managed configuration');
    const receipt = productReceipt(selected);
    const runtimeUUID = await io.publish(receipt);
    await io.verify(receipt, runtimeUUID);
    await io.save({schema:'youeye.installed-pointer.v1', installed:{receipt,runtimeUUID,acceptedAt:new Date().toISOString()}, floors});
  } finally {
    await io.cleanup();
  }
}
