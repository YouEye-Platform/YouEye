import type { AppManifest, InstallConfig, InstallMetadata } from '@/lib/market/types';
import type { AppUpdateRecord } from '@/lib/market/update-journal';
import { updateDigest } from '@/lib/market/update-workspace';

/** Recover only a manifest actually applied by this installation's committed update. */
export function verifyRetainedNativeManifestUpdate(
  metadata: InstallMetadata, config: InstallConfig, exactManifest: AppManifest,
  yaml: string, record: AppUpdateRecord | undefined,
): void {
  const artifacts = metadata.nativeArtifacts ?? [];
  const sameDigests = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  if (metadata.integration !== 'native' || exactManifest.integration !== 'native'
    || exactManifest.metadata.id !== metadata.appId || exactManifest.version !== metadata.installedVersion
    || config.manifestDigest !== `sha256:${updateDigest(yaml)}`
    || !record || record.appId !== metadata.appId || !record.commit || !record.cleanupComplete
    || record.rollbackVerifiedAt || record.phase !== 'cleanup'
    || !Number.isFinite(Date.parse(metadata.installedAt))
    || Date.parse(metadata.installedAt) > Date.parse(record.createdAt)
    || record.target.manifestSHA256 !== updateDigest(JSON.stringify(exactManifest))
    || artifacts.length !== metadata.containers.length || !artifacts.length
    || metadata.containers.some(c => c.type !== 'lxd'
      || !artifacts.some(a => a.containerName === c.name)
      || !record.resources.some(r => r.kind === 'container' && r.name === c.containerName && r.ownerAppId === metadata.appId))
    || artifacts.some(a => a.version !== metadata.installedVersion || !a.releaseTag
      || !a.sourceRepo || !a.signature?.startsWith('verified-') || !a.signatureKeyId
      || a.releaseTag !== artifacts[0].releaseTag || a.sourceRepo !== artifacts[0].sourceRepo)
    || !sameDigests(record.target.artifactSHA256, artifacts.map(a => a.sha256))) {
    throw new Error('Retained native manifest recovery lacks matching committed update evidence');
  }
}
