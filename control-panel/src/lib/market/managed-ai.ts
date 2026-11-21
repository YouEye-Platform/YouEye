import { readInstallMetadata, saveInstallMetadata } from './metadata';
import { randomUUID } from 'crypto';
import type { AppManifest, InstallConfig, InstallMetadata } from './types';
import { readInstalledAppManifest } from './frozen-manifest';
import { buildCanonicalContext, resolveEnvMapping } from './platform-env';
import { enforceConfigFilePermissions, writeConfigFileToStorage } from './config-writer';
import { getAppBridgeGatewayIP } from '@/lib/incus/app-network';
import { restartContainerAndWait } from '@/lib/infrastructure/oci-deployer';
import { containerRole } from '@/lib/apps/container-order';
import {
  addSystemProxyDevices,
  applyAppEgressAcl,
  getSystemServices,
  removeSystemProxyServiceDevices,
} from '@/lib/incus/app-network';
import { execCommand, incusRequest } from '@/lib/incus/server';
import { deleteAppSecret, readAppSecret, writeAppSecret } from '@/lib/infrastructure/secrets';
import {
  acknowledgePointerCredential,
  archivePointerManagedApp,
  changePointerManagedAppGroup,
  ensurePointerManagedApp,
  listPointerActorGroups,
  readPointerManagedApp,
  setPointerManagedAppEnabled,
  takeOverPointerManagedApp,
  type PointerManagedInstallation,
} from '@/lib/pointer/managed-apps';
import type { PointerLifecycleActor } from '@/lib/identity/tokens';
import { getUserById } from '@/lib/identity/store';
import { withAppLifecycle } from './update-admission';

function managedAIIconUrl(manifest: AppManifest): string | undefined {
  const value = manifest.metadata.iconUrl;
  if (!value) return undefined;
  return /^https:\/\//.test(value) || value.startsWith('/api/market/image?')
    ? value
    : undefined;
}

function containerEntries(meta: InstallMetadata) {
  return meta.containers
    .map((container) => ({ name: container.name, containerName: container.containerName, type: container.type }))
    .filter((container) => Boolean(container.containerName));
}

function connectionFromInstallation(
  ownerUserId: string,
  installation: PointerManagedInstallation
): NonNullable<InstallMetadata['aiConnection']> {
  if (!installation.routingOwner || !installation.selectedGroup || !installation.credential) {
    throw new Error('Pointer returned an incomplete managed application record');
  }
  return {
    externalInstallationId: installation.externalInstallationId,
    pointerInstallationId: installation.pointer.installationId,
    pointerInstanceId: installation.pointer.instanceId,
    ownerUserId,
    pointerOwnerId: installation.routingOwner.id,
    modelGroupId: installation.selectedGroup.id,
    groupName: installation.selectedGroup.name,
    keyPreview: installation.credential.preview,
    credentialSecret: 'pointer_api_key',
    defaultModel: 'default',
    state:
      installation.routingOwner.state !== 'active' || installation.drift.codes.includes('routing_owner_unavailable')
        ? 'needs_attention'
        : installation.state === 'active'
          ? 'active'
          : 'disabled',
  };
}

async function fetchInstalledAIManifest(meta: InstallMetadata): Promise<AppManifest> {
  const manifest = await readInstalledAppManifest(meta.appId);
  if (manifest.capabilities?.ai_api !== true) {
    throw new Error('This application does not declare AI Settings support');
  }
  return manifest;
}

export async function installedAppSupportsManagedAI(appId: string): Promise<boolean> {
  const meta = await readInstallMetadata(appId);
  if (!meta) throw new Error(`Unknown installed app: ${appId}`);
  const manifest = await readInstalledAppManifest(meta.appId);
  return manifest.capabilities?.ai_api === true;
}

async function applyAIEnvironment(
  meta: InstallMetadata,
  manifest: AppManifest,
  actor: PointerLifecycleActor,
  credential: string,
  connection: NonNullable<InstallMetadata['aiConnection']>
) {
  const gateway = await getAppBridgeGatewayIP(meta.appId);
  if (!gateway) throw new Error('The application network gateway is unavailable');
  const config: InstallConfig = {
    appId: meta.appId,
    subdomain: meta.subdomain,
    domain: meta.domain,
    aiSettings: {
      enabled: true,
      modelGroupId: connection.modelGroupId,
      ownerUserId: actor.id,
      ownerDisplayName: actor.name,
      runtimeCredential: credential,
    },
  };
  const context = await buildCanonicalContext(manifest, config, undefined, undefined, undefined, true);
  const aiMapping = Object.fromEntries(
    Object.entries(manifest.env_mapping || {}).filter(([, template]) => template.includes('${ai.'))
  );
  if (Object.keys(aiMapping).length === 0) {
    throw new Error('The application manifest has no AI environment mapping');
  }
  const environment = resolveEnvMapping(aiMapping, context);
  const containers = containerEntries(meta);

  await addSystemProxyDevices(
    meta.appId,
    await getSystemServices({
      needsSharedDb: meta.databaseMode === 'shared',
      needsSSO: meta.hasSSO ?? meta.enableSSO,
      needsAI: true,
    })
  );
  await applyAppEgressAcl(
    meta.appId,
    containers.map((container) => container.containerName),
    {
      needsSharedDb: meta.databaseMode === 'shared',
      needsSSO: meta.hasSSO ?? meta.enableSSO,
      needsAI: true,
    }
  );

  for (const container of containers) {
    if (container.type === 'lxd') {
      const entries = Object.entries(environment);
      const shell = [
        'set -eu',
        `file=/etc/${container.containerName}.env`,
        'tmp=$(mktemp)',
        'test ! -f "$file" || cp "$file" "$tmp"',
        ...entries.flatMap(([name], index) => [
          `sed -i '/^${name}=/d' "$tmp"`,
          `printf '%s=%s\\n' '${name}' "$YE_AI_VALUE_${index}" >> "$tmp"`,
        ]),
        'install -m 600 "$tmp" "$file"',
        'rm -f "$tmp"',
      ].join('; ');
      const result = await execCommand(
        container.containerName,
        ['/bin/sh', '-c', shell],
        {
          environment: Object.fromEntries(entries.map(([, value], index) => [`YE_AI_VALUE_${index}`, value])),
          timeout: 15_000,
        }
      );
      if (result.exitCode !== 0) throw new Error('The application AI environment file could not be updated');
    } else {
      const response = await incusRequest<{ config?: Record<string, string> }>(
        'GET',
        `/1.0/instances/${container.containerName}`
      );
      if (response.type === 'error') throw new Error('The application container configuration is unavailable');
      const patch = Object.fromEntries(
        Object.entries(environment).map(([name, value]) => [`environment.${name}`, value])
      );
      const updated = await incusRequest(
        'PATCH',
        `/1.0/instances/${container.containerName}`,
        { config: patch }
      );
      if (updated.type === 'error') throw new Error('The application AI environment could not be updated');
    }
  }

  const updatedConfigFiles: Array<{ containerName: string; configFile: AppManifest['configFiles'][number] }> = [];
  for (const configFile of manifest.configFiles.filter((file) =>
    file.path.includes('${ai.') || file.template.includes('${ai.')
  )) {
    const target = containers.find((container) => container.name === configFile.container);
    if (!target) throw new Error('The application configuration targets an unknown container');
    await writeConfigFileToStorage(
      target.containerName,
      configFile,
      context,
      target.type === 'oci'
        ? meta.storageVolumes?.filter((volume) => volume.containerName === target.containerName)
        : undefined,
    );
    updatedConfigFiles.push({ containerName: target.containerName, configFile });
  }

  if (meta.desiredState !== 'stopped' && meta.enabled !== false) {
    for (const container of containers) {
      await restartContainerAndWait(container.containerName, 60, { role: containerRole(meta.containers, container.containerName) });
    }
    for (const configFile of updatedConfigFiles) {
      await enforceConfigFilePermissions(configFile.containerName, configFile.configFile, context);
    }
  }
}

export async function getManagedAIStatus(
  appId: string,
  actor: PointerLifecycleActor
) {
  return withAppLifecycle(appId, async () => {
    const meta = await readInstallMetadata(appId);
    if (!meta) throw new Error(`Unknown installed app: ${appId}`);
    const manifest = await fetchInstalledAIManifest(meta);
    const groups = await listPointerActorGroups(actor);
    if (!meta.aiConnection) {
      return { supported: true, enabled: false, connection: null, installation: null, groups };
    }
    const installation = await readPointerManagedApp(meta.aiConnection.externalInstallationId, actor);
    meta.aiConnection = connectionFromInstallation(meta.aiConnection.ownerUserId, installation);
    await saveInstallMetadata(meta);
    return {
      supported: manifest.capabilities?.ai_api === true,
      enabled: installation.state === 'active',
      connection: meta.aiConnection,
      installation,
      groups,
    };
  });
}


export async function enableManagedAI(
  appId: string,
  actor: PointerLifecycleActor,
  groupId: string
) {
  return withAppLifecycle(appId, () => enableManagedAILocked(appId, actor, groupId));
}

async function enableManagedAILocked(
  appId: string,
  actor: PointerLifecycleActor,
  groupId: string
) {
  const meta = await readInstallMetadata(appId);
  if (!meta) throw new Error(`Unknown installed app: ${appId}`);
  const manifest = await fetchInstalledAIManifest(meta);
  if (meta.aiConnection) {
    const credential = await readAppSecret(appId, 'pointer_api_key');
    if (!credential) throw new Error('The protected application AI credential needs recovery');
    let installation = await readPointerManagedApp(meta.aiConnection.externalInstallationId, actor);
    if (installation.routingOwner?.externalSubject !== actor.id) {
      throw new Error('Take over this app’s AI connection before enabling it');
    }
    if (installation.selectedGroup?.id !== groupId) {
      installation = await changePointerManagedAppGroup({
        actor,
        externalInstallationId: meta.aiConnection.externalInstallationId,
        groupId,
      });
    }
    // Re-enabling an existing connection must also converge its current AI
    // mapping, including distinct utility aliases, without replacing its key.
    await applyAIEnvironment(meta, manifest, actor, credential,
      connectionFromInstallation(actor.id, installation));
    installation = await setPointerManagedAppEnabled(
      meta.aiConnection.externalInstallationId,
      true,
      actor
    );
    meta.aiConnection = connectionFromInstallation(actor.id, installation);
    await saveInstallMetadata(meta);
    return meta.aiConnection;
  }

  const groups = await listPointerActorGroups(actor);
  const group = groups.find((candidate) => candidate.id === groupId);
  if (!group || group.enabledModelCount === 0) throw new Error('The selected AI model group is unavailable');
  const externalInstallationId = `market:${appId}:${randomUUID()}`;
  meta.aiConnectionPending = { externalInstallationId, ownerUserId: actor.id };
  await saveInstallMetadata(meta);
  let provisioned = false;
  try {
    const ensured = await ensurePointerManagedApp({
      actor,
      externalInstallationId,
      appId,
      displayName: manifest.metadata.name,
      appVersion: manifest.version,
      groupId,
      iconUrl: managedAIIconUrl(manifest),
    });
    provisioned = true;
    const delivery = ensured.credentialDelivery;
    if (!delivery?.credential) throw new Error('Pointer did not provide the application credential');
    await writeAppSecret(appId, 'pointer_api_key', delivery.credential);
    if (await readAppSecret(appId, 'pointer_api_key') !== delivery.credential) {
      throw new Error('The protected application credential did not read back exactly');
    }
    await acknowledgePointerCredential({ actor, externalInstallationId, deliveryId: delivery.id });
    const activated = await readPointerManagedApp(externalInstallationId, actor);
    const connection = connectionFromInstallation(actor.id, activated);
    await applyAIEnvironment(meta, manifest, actor, delivery.credential, connection);
    meta.aiConnection = connection;
    delete meta.aiConnectionPending;
    await saveInstallMetadata(meta);
    return connection;
  } catch (error) {
    if (provisioned) await archivePointerManagedApp(externalInstallationId, actor).catch(() => undefined);
    await deleteAppSecret(appId, 'pointer_api_key').catch(() => undefined);
    await removeSystemProxyServiceDevices(appId, ['pointer-inference-proxy']).catch(() => undefined);
    delete meta.aiConnectionPending;
    await saveInstallMetadata(meta).catch(() => undefined);
    throw error;
  }
}

export async function disableManagedAI(appId: string, actor: PointerLifecycleActor) {
  return withAppLifecycle(appId, () => disableManagedAILocked(appId, actor));
}

async function disableManagedAILocked(appId: string, actor: PointerLifecycleActor) {
  const meta = await readInstallMetadata(appId);
  if (!meta?.aiConnection) throw new Error('This app has no AI Settings connection');
  const installation = await setPointerManagedAppEnabled(
    meta.aiConnection.externalInstallationId,
    false,
    actor
  );
  meta.aiConnection = connectionFromInstallation(meta.aiConnection.ownerUserId, installation);
  await saveInstallMetadata(meta);
  return meta.aiConnection;
}

export async function changeManagedAIGroup(
  appId: string,
  actor: PointerLifecycleActor,
  groupId: string
) {
  return withAppLifecycle(appId, () => changeManagedAIGroupLocked(appId, actor, groupId));
}

async function changeManagedAIGroupLocked(
  appId: string,
  actor: PointerLifecycleActor,
  groupId: string
) {
  const meta = await readInstallMetadata(appId);
  if (!meta?.aiConnection) throw new Error('This app has no AI Settings connection');
  const installation = await changePointerManagedAppGroup({
    actor,
    externalInstallationId: meta.aiConnection.externalInstallationId,
    groupId,
  });
  meta.aiConnection = connectionFromInstallation(meta.aiConnection.ownerUserId, installation);
  await saveInstallMetadata(meta);
  return meta.aiConnection;
}

export async function takeOverManagedAI(
  appId: string,
  actor: PointerLifecycleActor,
  groupId: string
) {
  return withAppLifecycle(appId, () => takeOverManagedAILocked(appId, actor, groupId));
}

async function takeOverManagedAILocked(
  appId: string,
  actor: PointerLifecycleActor,
  groupId: string
) {
  const meta = await readInstallMetadata(appId);
  if (!meta?.aiConnection) throw new Error('This app has no AI Settings connection');
  const installation = await takeOverPointerManagedApp({
    actor,
    externalInstallationId: meta.aiConnection.externalInstallationId,
    groupId,
  });
  meta.aiConnection = connectionFromInstallation(actor.id, installation);
  await saveInstallMetadata(meta);
  return meta.aiConnection;
}

/**
 * A kept app after a server restore. The restore put the backup's Pointer database back but did not reinstall the
 * app, so the app still holds the AI key it was given last, and Pointer keeps only key hashes. A connection made
 * (or made again) after the backup is unknown to the restored Pointer, and the app's AI requests are refused.
 *
 * - Pointer still has the app's key: the model group and the enabled state the owner chose after the backup are
 *   applied again (the group only while it exists with models).
 * - Otherwise the backup's record (if any) is archived and the app gets a new connection for the same owner, in
 *   its group (or the owner's default group when that one is gone), in the state it had: a new key is written
 *   into the app.
 */
export async function reconcileKeptManagedAI(appId: string): Promise<'none' | 'kept' | 'reconnected'> {
  return withAppLifecycle(appId, async () => {
    const meta = await readInstallMetadata(appId);
    const saved = meta?.aiConnection;
    if (!meta || !saved) return 'none';
    const credential = await readAppSecret(appId, 'pointer_api_key');
    const current = await readPointerManagedApp(saved.externalInstallationId).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes('(installation_not_found)')) return null;
      throw error;
    });
    if (current && credential && current.app.id === appId && current.state !== 'archived'
      && current.pointer.installationId === saved.pointerInstallationId
      && current.credential && !current.credential.revoked && current.credential.preview === saved.keyPreview) {
      if (current.selectedGroup?.id !== saved.modelGroupId) {
        // The model group the owner chose after the backup. Still there with models: chosen again. Gone (or its owner
        // gone): the restored group stays, which answers the app's requests.
        const user = await getUserById(saved.ownerUserId);
        const actor: PointerLifecycleActor | null = user?.is_active
          ? { id: user.id, name: user.name || user.username, isAdmin: user.is_admin } : null;
        const group = actor && (await listPointerActorGroups(actor))
          .find((candidate) => candidate.id === saved.modelGroupId && candidate.enabledModelCount > 0);
        if (actor && group) {
          await changePointerManagedAppGroup({ actor, externalInstallationId: saved.externalInstallationId, groupId: group.id });
        } else {
          console.warn(`[managed-ai] ${appId}: AI model group ${saved.modelGroupId} is not available; it keeps the restored one`);
        }
      }
      if (saved.state === 'disabled' && current.state === 'active') {
        await setPointerManagedAppEnabled(saved.externalInstallationId, false);
      } else if (saved.state === 'active' && current.state === 'disabled') {
        await setPointerManagedAppEnabled(saved.externalInstallationId, true);
      }
      return 'kept';
    }
    const user = await getUserById(saved.ownerUserId);
    if (!user?.is_active) throw new Error(`The owner of ${appId}'s AI connection is not on this server`);
    const actor: PointerLifecycleActor = { id: user.id, name: user.name || user.username, isAdmin: user.is_admin };
    const groups = await listPointerActorGroups(actor);
    const group = groups.find((candidate) => candidate.id === saved.modelGroupId && candidate.enabledModelCount > 0)
      ?? groups.find((candidate) => candidate.isDefault && candidate.enabledModelCount > 0);
    if (!group) throw new Error(`No AI model group is available for ${appId}`);
    if (current && current.state !== 'archived') await archivePointerManagedApp(saved.externalInstallationId);
    delete meta.aiConnection;
    await saveInstallMetadata(meta);
    await enableManagedAILocked(appId, actor, group.id);
    if (saved.state === 'disabled') await disableManagedAILocked(appId, actor);
    return 'reconnected';
  });
}
