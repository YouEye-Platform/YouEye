import { ensureAppAdmission, getAdmissionPolicy, reserveAppUserData, saveResourceOwnership } from './store';
import { ensureIdentitySchema, identityCommand as command, identityRows as rows, identitySql as sql } from '@/lib/identity/store';
import { listInstalledApps, readInstallMetadata, saveInstallMetadata } from '@/lib/market/metadata';
import { getConfig, setConfig, buildForwardAuthHandler, resolveCaddyUpstreamDial } from '@/lib/caddy/client';
import { getIdentityConfig } from '@/lib/identity/config';
import { getContainerIP } from '@/lib/incus/container-ip';
import { reconcileAdmissionProjections } from './projection';
import type { InstallMetadata } from '@/lib/market/types';
import { isDeepStrictEqual } from 'node:util';
import { bindRuntimeOwnership, verifyRuntimeOwnership } from './runtime-ownership';
import type { ResourceOwnership } from '../../../../shared/admission';
import { withAppLifecycle } from '@/lib/market/update-admission';
import { readFrozenUpdateManifest } from '@/lib/market/frozen-manifest';
import { appServiceCredentials } from '@/lib/apps/service-credential-store';
import { isActiveAppCredential } from '../../../../shared/app-service-credential';

export const ADMISSION_HEADERS = ['X-YouEye-Username', 'X-YouEye-Groups', 'X-YouEye-Email', 'X-YouEye-Name', 'X-YouEye-Uid'];
export async function admissionForwardAuth() {
  const identity = await getIdentityConfig();
  return { upstreamDial: await resolveCaddyUpstreamDial(identity.containerName, identity.port),
    uri: '/forward-auth/caddy', copyHeaders: ADMISSION_HEADERS };
}
export async function bindInstalledAdmission(metadata: InstallMetadata, actorId?: string) {
  return withAppLifecycle(metadata.appId, () => bindInstalledAdmissionUnderLifecycle(metadata, actorId));
}
async function bindInstalledAdmissionUnderLifecycle(metadata: InstallMetadata, actorId?: string) {
  // Recover a newly declared namespace from the verified installed contract,
  // never from a mutable catalog or another runtime version.
  if (metadata.integration === 'native' && metadata.lifecycleState === 'active'
    && metadata.serviceCredentialState === 'ready' && !metadata.perUserData) {
    const manifest = await readFrozenUpdateManifest(metadata.appId, metadata.installedVersion);
    metadata.perUserData = manifest.data_ownership?.per_user;
  }
  const host = `${metadata.subdomain}.${metadata.domain}`.toLowerCase();
  const policy = await ensureAppAdmission({
    appId: metadata.appId, actorId, clientId: metadata.ssoClientId, installed: true,
    routes: [{ host }],
  });
  if (metadata.installationId && metadata.installationId !== policy.installationId) {
    throw new Error('Install metadata does not match admission ownership');
  }
  const metadataChanged = metadata.installationId !== policy.installationId || metadata.admissionOwnerId !== policy.ownerId;
  metadata.installationId = policy.installationId;
  // Owner here is app administration. Resource data owners are independent.
  metadata.admissionOwnerId = policy.ownerId;
  if (metadataChanged) await saveInstallMetadata(metadata);
  // Reserve declared namespaces, including principals added while uninstalled.
  // Existing contracts survive a later manifest omitting the declaration.
  // This is conservative inventory, not a claim that rows exist.
  await reserveAppUserData(policy.installationId, metadata.perUserData === 'identity_uuid');
  if (metadata.ssoClientId) {
    const clients = await rows<{ redirect_uris: string[]; backchannel_logout_uri: string | null }>(`
      SELECT redirect_uris, backchannel_logout_uri FROM identity_clients WHERE client_id = ${sql(metadata.ssoClientId)}`);
    const client = clients[0];
    // Only the tested native signed-logout endpoint is a machine exception.
    // An arbitrary manifest/client redirect URI is never a public route.
    for (const [method, uris] of [['POST', metadata.integration === 'native' && client?.backchannel_logout_uri
      ? [client.backchannel_logout_uri] : []]] as const) {
      for (const uri of uris) {
        const parsed = new URL(uri);
        if (parsed.hostname !== host || parsed.protocol !== 'https:' || parsed.pathname !== '/api/auth/backchannel-logout') continue;
        await command(`INSERT INTO admission_machine_callbacks (installation_id, host, path, method)
          VALUES (${sql(policy.installationId)}::uuid, ${sql(host)}, ${sql(parsed.pathname)}, ${sql(method)})
          ON CONFLICT DO NOTHING`);
      }
    }
  }
  for (const volume of metadata.storageVolumes || []) {
    // Existing shared-group mounts need a separately resolved share declaration;
    // never relabel an implicit group string as private or public ownership.
    if (volume.sharedGroup) {
      await command(`INSERT INTO admission_shares (share_key, owner_id)
        VALUES (${sql(volume.sharedGroup)}, ${sql(policy.ownerId)}::uuid)
        ON CONFLICT (share_key) DO NOTHING`);
      const [share] = await rows<{ id: string; owner_id: string }>(`
        SELECT id::text, owner_id::text FROM admission_shares
        WHERE share_key = ${sql(volume.sharedGroup)} AND deleted_at IS NULL`);
      if (!share) throw new Error('Deleted share identity cannot be recreated');
      const { bindSharedVolumeOwnership } = await import('@/lib/market/storage');
      await bindSharedVolumeOwnership(volume, share.id, share.owner_id);
      const existing = await rows(`SELECT resource_id FROM admission_resources
        WHERE installation_id = ${sql(policy.installationId)}::uuid AND resource_id = ${sql(`volume:${volume.name}`)}`);
      if (!existing.length) await saveResourceOwnership({
        schemaVersion: 1, appId: metadata.appId, installationId: policy.installationId,
        resourceId: `volume:${volume.name}`, scope: 'shared', enforcement: 'needs_review',
        ownerId: share.owner_id, identityUserId: null, uiUserId: null, shareId: share.id,
        consumerIds: [policy.installationId], state: 'active',
      });
      continue;
    }
    const resourceId = `volume:${volume.name}`;
    const existing = await rows<{ owner_id: string }>(`SELECT owner_id::text FROM admission_resources
      WHERE installation_id = ${sql(policy.installationId)}::uuid AND resource_id = ${sql(resourceId)}`);
    const dataOwner = existing[0]?.owner_id || policy.ownerId;
    const { bindAppVolumeOwnership } = await import('@/lib/market/storage');
    await bindAppVolumeOwnership(volume, policy.installationId, dataOwner);
    if (existing.length) continue;
    await saveResourceOwnership({
      schemaVersion: 1, appId: metadata.appId, installationId: policy.installationId,
      resourceId, scope: 'app_global', enforcement: 'needs_review',
      ownerId: policy.ownerId, identityUserId: null, uiUserId: null, shareId: null,
      consumerIds: [], state: 'active',
    });
  }
  for (const container of metadata.containers || []) {
    const resourceId = `runtime:${container.containerName}`;
    const existing = await rows<{ owner_id: string }>(`SELECT owner_id::text FROM admission_resources
      WHERE installation_id = ${sql(policy.installationId)}::uuid AND resource_id = ${sql(resourceId)}`);
    await bindRuntimeOwnership({ appId: metadata.appId, installationId: policy.installationId,
      ownerId: existing[0]?.owner_id || policy.ownerId, name: container.containerName });
    if (!existing.length) await saveResourceOwnership({
      schemaVersion: 1, appId: metadata.appId, installationId: policy.installationId, resourceId,
      scope: 'app_global', enforcement: 'needs_review', ownerId: policy.ownerId,
      identityUserId: null, uiUserId: null, shareId: null, consumerIds: [], state: 'active',
    });
  }
  if (metadata.databaseMode === 'shared') {
    const resourceId = `database:${metadata.databaseName || metadata.appId}`;
    const existing = await rows(`SELECT resource_id FROM admission_resources
      WHERE installation_id = ${sql(policy.installationId)}::uuid AND resource_id = ${sql(resourceId)}`);
    const [baseline] = await rows<{ actor_id: string }>(`SELECT actor_id::text FROM admission_audit
      WHERE installation_id = ${sql(policy.installationId)}::uuid AND action = 'owner_only_baseline'
      ORDER BY id LIMIT 1`);
    if (!existing.length && !baseline) throw new Error('Shared database needs original owner resolution');
    if (!existing.length) await saveResourceOwnership({
      schemaVersion: 1, appId: metadata.appId, installationId: policy.installationId, resourceId,
      scope: 'app_global', enforcement: 'needs_review', ownerId: baseline.actor_id,
      identityUserId: null, uiUserId: null, shareId: null, consumerIds: [], state: 'active',
    });
  }
  await saveInstallMetadata(metadata);
  if (metadata.enabled === false) {
    const { setAdmissionAppEnabled } = await import('./store');
    await setAdmissionAppEnabled(metadata.appId, policy.installationId, false);
  } else if (metadata.lifecycleState === 'active' && metadata.serviceCredentialState === 'ready') {
    const credential = await appServiceCredentials.projection(metadata.appId);
    const status = await appServiceCredentials.status(metadata.appId);
    if (credential && isActiveAppCredential(credential) && status?.pendingPublications === 0) {
      const { setAdmissionAppEnabled } = await import('./store');
      await setAdmissionAppEnabled(metadata.appId, policy.installationId, true);
    }
  }
  return policy;
}

/** Apply gates to the exact installed hosts and their existing route aliases. */
export async function reconcileInstalledAdmission() {
  await ensureIdentitySchema();
  await command(`UPDATE admission_outbox SET acknowledged_revision = 0`);
  const installed = await listInstalledApps();
  const config = await getConfig();
  const gate = await admissionForwardAuth();
  let changed = false;
  const bindings: Array<{ metadata: InstallMetadata; routes: Array<{ host: string; pathPrefix: string }> }> = [];
  for (const metadata of installed) {
    if (metadata.lifecycleState && metadata.lifecycleState !== 'active') continue;
    const binding = { metadata, routes: [] as Array<{ host: string; pathPrefix: string }> };
    bindings.push(binding);
    const addresses = new Set<string>();
    for (const container of metadata.containers || []) {
      addresses.add(`${container.containerName}.youeye`);
      const ip = await getContainerIP(container.containerName);
      if (ip) addresses.add(ip);
    }
    for (const server of Object.values(config.apps?.http?.servers || {})) {
      for (const route of server.routes || []) {
        const hosts = route.match?.flatMap(match => match.host || []) || [];
        const belongs = hosts.includes(`${metadata.subdomain}.${metadata.domain}`)
          || (String(route['@id'] || '').startsWith(`app-${metadata.appId}-`))
          || route.handle?.some((handler: any) => handler.handler === 'reverse_proxy'
            && handler.upstreams?.some((upstream: any) => addresses.has(upstream.dial?.split(':')[0])));
        if (!belongs || !hosts.length) continue;
        const prefixes = route.match?.flatMap(match => match.path || ['/*']) || ['/*'];
        binding.routes.push(...hosts.flatMap(host =>
          prefixes.map(prefix => ({ host, pathPrefix: prefix.replace(/\/\*$/, '') || '/' }))));
        const existing = route.handle || [];
        const applicationHandlers = existing.filter((handler: any) => handler.handler !== 'headers'
          || !handler.request?.delete?.includes('X-YouEye-User')).filter((handler: any) =>
          !(handler.handler === 'reverse_proxy' && handler.rewrite?.uri === '/forward-auth/caddy'));
        const handlers = [
          { handler: 'headers', request: { delete: ['X-YouEye-App', 'X-YouEye-User', ...ADMISSION_HEADERS] } },
          buildForwardAuthHandler(gate.upstreamDial, gate.uri, gate.copyHeaders), ...applicationHandlers,
        ];
        if (JSON.stringify(existing) !== JSON.stringify(handlers)) {
          route.handle = handlers;
          changed = true;
        }
      }
    }
  }
  // Install the fail-closed gate first. A missing owner, unresolved resource or
  // failed registry write then yields denial rather than retaining an old gate.
  if (changed) {
    await setConfig(config);
    const applied = await getConfig();
    if (!isDeepStrictEqual(applied.apps?.http?.servers, config.apps?.http?.servers)) {
      throw new Error('Installed admission routes did not read back from the gateway');
    }
  }
  for (const binding of bindings) {
    await bindInstalledAdmission(binding.metadata);
    await ensureAppAdmission({ appId: binding.metadata.appId, routes: binding.routes, installed: true });
  }
}

export async function retainAdmissionOnUninstall(appId: string, keepData: boolean) {
  await ensureIdentitySchema();
  const policy = await getAdmissionPolicy(appId);
  if (!policy) throw new Error('Application ownership must be resolved before cleanup');
  await command(`BEGIN;
    SELECT pg_advisory_xact_lock(hashtext('youeye-admission-lifecycle'));
    UPDATE admission_policies SET state = ${sql(keepData ? 'retained' : 'deleted')},
      revision = revision + 1, updated_at = now()
      WHERE app_id = ${sql(appId)} AND state <> ${sql(keepData ? 'retained' : 'deleted')};
    UPDATE admission_resources SET state = ${sql(keepData ? 'retained' : 'deleted')},
      declaration = jsonb_set(declaration, '{state}', ${sql(JSON.stringify(keepData ? 'retained' : 'deleted'))}::jsonb)
      WHERE installation_id = ${sql(policy.installationId)}::uuid AND state <> 'quarantined';
    DELETE FROM admission_routes WHERE installation_id = ${sql(policy.installationId)}::uuid;
    COMMIT;`);
}

export async function verifyAdmissionCleanup(metadata: InstallMetadata, keepData: boolean, restoreReplacement = false) {
  const policy = await getAdmissionPolicy(metadata.appId);
  if (!policy || metadata.installationId !== policy.installationId) {
    throw new Error('Cleanup requires the matching immutable installation identity');
  }
  const resources = await rows<{ resource_id: string; owner_id: string; state: string; declaration: ResourceOwnership }>(`
    SELECT resource_id, owner_id::text, state, declaration FROM admission_resources
    WHERE installation_id = ${sql(policy.installationId)}::uuid`);
  if (!keepData && resources.some(r => r.state === 'quarantined')) {
    throw new Error('Quarantined data requires a separate explicit disposition');
  }
  for (const container of metadata.containers || []) {
    const resource = resources.find(r => r.resource_id === `runtime:${container.containerName}`);
    if (!resource) throw new Error('Cleanup runtime has unresolved data ownership');
    const { runtimeExists } = await import('./retained-runtime');
    if (keepData && !await runtimeExists(container.containerName)) {
      const { verifyPreviouslyRetainedRoot } = await import('./retained-data');
      await verifyPreviouslyRetainedRoot(metadata, container.containerName);
    } else {
      // Validated restore replacement may resume after deletion. Only an exact
      // Incus 404 is accepted; policy, resource and volume ownership still apply.
      await verifyRuntimeOwnership({ appId: metadata.appId, installationId: policy.installationId,
        ownerId: resource.owner_id, name: container.containerName }, restoreReplacement && !keepData);
    }
  }
  for (const volume of metadata.storageVolumes || []) {
    if (volume.attachmentOnly || volume.sharedGroup) continue;
    if (volume.installationId !== policy.installationId || !resources.some(r =>
      r.resource_id === `volume:${volume.name}` && r.owner_id === volume.dataOwnerId)) {
      throw new Error('Cleanup volume has unknown or foreign data ownership');
    }
  }
  const { verifyAppStorageOwnership } = await import('@/lib/market/storage');
  await verifyAppStorageOwnership(metadata.storageVolumes || []);
}
