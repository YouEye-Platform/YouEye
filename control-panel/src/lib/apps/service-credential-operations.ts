import { withAppLifecycle } from '../market/update-admission';
import { appServiceCredentials } from './service-credential-store';
import { runAppCredentialLifecycle, type AppCredentialLifecycleAction } from './service-credential-lifecycle';
import { publishCredential, probeCredential, markCredentialReady } from './service-credential-bridge';
import { rewriteCredentialEnvironment, assertPrivateCredentialConfig } from './service-credential-runtime';
import { probeNativeAppCredential, quiesceAppCredentialRuntime } from './service-credential-probe';
import { readInstallMetadata, saveInstallMetadata } from '../market/metadata';
import { readFrozenUpdateManifest } from '../market/frozen-manifest';
import { bindInstalledAdmission } from '../admission/lifecycle';
import { reconcileAdmissionProjections } from '../admission/projection';
import { buildCanonicalContext, resolveEnvMapping } from '../market/platform-env';
import { getContainerName } from '../market/engine-helpers';
import { resolveEnvironment } from '../market/variables';
import { writeAllConfigFiles } from '../market/config-writer';
import { readSecret } from '../infrastructure/secrets';
import { withAppNetworkOperationLock } from '../incus/app-network';
import { beginContainerMaintenance } from '../maintenance/container-maintenance';
import { incusDownloadFile, incusUploadFile, incusRequest } from '../incus/server';
import { startContainer, waitForRunning, waitForOperation } from '../incus/snapshot';

/** Deliberate authenticated lifecycle action; no browser-visible secret values. */
export async function operateAppCredential(appId: string, operation: AppCredentialLifecycleAction) {
  return withAppLifecycle(appId, () => withAppNetworkOperationLock(appId, `credential:${operation.action}`, async () => {
    const metadata = await readInstallMetadata(appId);
    if (!metadata || metadata.lifecycleState !== 'active') throw new Error('Installed app is unavailable');
    const manifest = await readFrozenUpdateManifest(appId, metadata.installedVersion);
    assertPrivateCredentialConfig(manifest.configFiles);
    if (manifest.metadata.id !== appId) throw new Error('Installed app identity mismatch');
    const names = manifest.containers.map(spec => getContainerName(appId, spec.name, manifest.containers.length));
    const installedNames = metadata.containers.map(spec => typeof spec === 'string' ? spec : spec.containerName);
    if (names.length !== installedNames.length || names.some(name => !installedNames.includes(name))) {
      throw new Error('Installed app runtime identity mismatch');
    }
    const intendedState = metadata.serviceCredentialDesiredState ?? metadata.desiredState ?? 'running';
    const lease = beginContainerMaintenance(names, { operation: `credential:${appId}` });
    try {
      await appServiceCredentials.recoverAbandonedOperation(appId);
      const before = await appServiceCredentials.status(appId);
      if ('expectedRevision' in operation) {
        const identical = before?.operationKind === operation.action
          && before.revision === operation.expectedRevision + (operation.action === 'revoke' ? 1 : 2)
          && before.status === (operation.action === 'revoke' ? 'revoked' : 'active');
        const preparedRetry = operation.action !== 'revoke'
          && before?.operationKind === operation.action && before.status === 'prepared'
          && before.revision === operation.expectedRevision + 1;
        if (before?.revision !== operation.expectedRevision && !identical && !preparedRetry) {
          throw new Error('App credential revision conflict');
        }
        if (identical && metadata.serviceCredentialState === (operation.action === 'revoke' ? 'revoked' : 'ready')
          && before?.pendingPublications === 0) return before;
      }
      return await runAppCredentialLifecycle(appId, operation, appServiceCredentials, {
        async withMaintenance(action) { return action(); },
        async markPending() {
          metadata.serviceCredentialState = 'pending';
          metadata.serviceCredentialDesiredState = intendedState;
          metadata.enabled = false;
          metadata.desiredState = 'stopped';
          await saveInstallMetadata(metadata);
          await bindInstalledAdmission(metadata);
          await reconcileAdmissionProjections();
          if ((await appServiceCredentials.projection(appId))?.status === 'active') {
            await markCredentialReady(appId, false);
          }
        },
        async quiesce() {
          await quiesceAppCredentialRuntime(names);
        },
        async writeRuntime(secret) {
          const secrets: Record<string, string> = {};
          for (const definition of manifest.secrets) {
            const value = await readSecret(`app-${appId}`, definition.file);
            if (!value) throw new Error('Protected app configuration requires repair');
            secrets[definition.name] = value;
          }
          const ctx = await buildCanonicalContext(manifest, {
            appId, subdomain: metadata.subdomain, domain: metadata.domain,
          }, undefined, secrets.db_password, secret, metadata.usePerAppBridge === true);
          ctx.secrets = secrets;
          const common = Object.fromEntries(Object.entries(manifest.env_mapping ?? {})
            .filter(([, template]) => /\$\{(?:integration\.(?:app_token|gateway_url)|app\.id)\}/.test(template)));
          for (let i = 0; i < manifest.containers.length; i++) {
            const spec = manifest.containers[i];
            const name = names[i];
            const local = Object.fromEntries(Object.entries(spec.environment ?? {})
              .filter(([, template]) => /\$\{(?:integration\.(?:app_token|gateway_url)|app\.id)\}/.test(template)));
            const replacements = { ...resolveEnvMapping(common, ctx), ...resolveEnvironment(local, ctx) };
            if (Object.values(replacements).some(value => value.includes('${'))) {
              throw new Error('Unresolved app credential runtime mapping');
            }
            // Reject browser-public injection for both OCI and native runtimes.
            rewriteCredentialEnvironment('', replacements);
            if (spec.type === 'lxd' && Object.keys(replacements).length) {
              const file = `/etc/${name}.env`;
              const old = await incusDownloadFile(name, file);
              const data = Buffer.from(rewriteCredentialEnvironment(old.toString('utf8'), replacements));
              if (!data.equals(old)) await incusUploadFile(name, file, data, { mode: '0600' });
              if (!data.equals(await incusDownloadFile(name, file))) throw new Error('Runtime configuration mismatch');
            } else if (Object.keys(replacements).length) {
              const config = Object.fromEntries(Object.entries(replacements).map(([key, value]) => [`environment.${key}`, value]));
              const changed = await incusRequest('PATCH', `/1.0/instances/${name}`, { config });
              if (changed.type === 'error') throw new Error('Runtime configuration requires repair');
              if (changed.type === 'async' && changed.operation) await waitForOperation(changed.operation, 60);
              const readback = await incusRequest<{ config: Record<string, string> }>('GET', `/1.0/instances/${name}`);
              if (readback.type === 'error' || Object.entries(config)
                .some(([key, value]) => readback.metadata?.config?.[key] !== value)) {
                throw new Error('Runtime configuration mismatch');
              }
            }
            const tokenFiles = manifest.configFiles.filter(file => file.container === spec.name
              && file.template.includes('${integration.app_token}'));
            if (tokenFiles.length) await writeAllConfigFiles(tokenFiles, spec.name, name, ctx, metadata.storageVolumes);
          }
        },
        publish: credential => publishCredential(credential),
        async restart() {
          for (const name of names) { await startContainer(name); await waitForRunning(name); }
        },
        async probe() {
          await probeCredential(appId);
          await probeNativeAppCredential(appId, manifest);
        },
        async markReady() {
          await markCredentialReady(appId);
          if (intendedState === 'stopped') await quiesceAppCredentialRuntime(names);
          metadata.serviceCredentialState = 'ready';
          metadata.desiredState = intendedState;
          metadata.enabled = intendedState === 'running';
          await saveInstallMetadata(metadata);
          await bindInstalledAdmission(metadata);
          await reconcileAdmissionProjections();
        },
        async markRevoked() {
          metadata.serviceCredentialState = 'revoked';
          metadata.enabled = false;
          metadata.desiredState = 'stopped';
          await saveInstallMetadata(metadata);
          await bindInstalledAdmission(metadata);
          await reconcileAdmissionProjections();
        },
      });
    } catch (error) {
      lease.markFailed('App service integration requires reconciliation');
      throw error;
    } finally { lease.release(); }
  }));
}
