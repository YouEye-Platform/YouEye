import {
  acceptProductSequence, productReceipt, type InstalledProductReceipt, type VerifiedProductRelease,
} from '../releases/product-release';
import type { ResolvedInfrastructureRelease } from '../infrastructure/release-resolver';
import type { StagedMarketNativeArtifact } from '../market/native-artifact';
import type { PointerReleaseState } from './release-metadata';

export interface PointerInitialInstallIO {
  read(): Promise<PointerReleaseState>;
  resolve(): Promise<VerifiedProductRelease | null>;
  stage(selected: VerifiedProductRelease): Promise<StagedMarketNativeArtifact>;
  deploy(artifact?: StagedMarketNativeArtifact): Promise<void>;
  configure(): Promise<void>;
  healthy(): Promise<boolean>;
  publish(receipt: InstalledProductReceipt): Promise<string>;
  verify(receipt: InstalledProductReceipt, runtimeUUID: string): Promise<void>;
  save(state: PointerReleaseState): Promise<void>;
  recordLegacy(): Promise<void>;
  cleanup(): Promise<void>;
}

/** The selected URL can be a Product descriptor, never an archive substitute.
 * Finish authentication and archive staging before touching an existing runtime.
 * A failed deployment retains persistent data but acquires no installed receipt.
 */
export async function installPointerRelease(
  release: ResolvedInfrastructureRelease,
  channel: { source: string; branch: string; artifact_sha256?: string },
  io: PointerInitialInstallIO,
): Promise<void> {
  try {
    const before = await io.read();
    const selected = await io.resolve();
    let artifact: StagedMarketNativeArtifact | undefined;
    let floors = before.floors;
    if (selected) {
      const r = selected.release;
      const primary = selected.build.assets.find(a => a.name === 'standalone.tar');
      if (r.product !== 'pointer' || r.source !== channel.source || r.branch !== channel.branch
        || r.tag !== release.tag || r.version !== release.version || selected.build.kind !== 'native'
        || !primary || channel.artifact_sha256 && primary.sha256 !== channel.artifact_sha256) {
        throw new Error('Pointer product release differs from selected channel');
      }
      floors = acceptProductSequence(before.floors, selected);
      artifact = await io.stage(selected);
      if (!artifact.productRelease || artifact.signature.status === 'unsigned'
        || artifact.containerName !== 'youeye-pointer' || artifact.artifactSHA256 !== primary.sha256
        || artifact.sourceRepo !== r.source || artifact.tag !== r.tag || artifact.version !== r.version) {
        throw new Error('Pointer staged runtime differs from verified product release');
      }
    } else {
      if (before.installed) throw new Error('Installed Pointer requires signed product metadata');
      if (new URL(release.url).pathname.split('/').at(-1) !== 'standalone.tar') {
        throw new Error('Pointer release descriptor cannot be installed as a runtime archive');
      }
    }
    await io.deploy(artifact);
    await io.configure();
    if (!(await io.healthy())) throw new Error('YouEye AI service did not become ready after managed configuration');
    if (selected) {
      const receipt = productReceipt(selected);
      const runtimeUUID = await io.publish(receipt);
      await io.verify(receipt, runtimeUUID);
      await io.save({schema:'youeye.installed-pointer.v1', installed:{receipt,runtimeUUID,acceptedAt:new Date().toISOString()}, floors});
    } else {
      await io.recordLegacy();
    }
  } finally {
    await io.cleanup();
  }
}
