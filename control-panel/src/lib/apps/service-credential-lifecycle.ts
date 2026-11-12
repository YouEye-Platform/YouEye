/**
 * Credential lifecycle ordering, independent of a container transport.
 * Production integration must supply the shared container-maintenance lease
 * and protected manifest/config writers. This module never patches guest env.
 */
import type { AppCredentialProjection } from '../../../../shared/app-service-credential';
import { AppServiceCredentialStore, type AppCredentialStatusView } from './service-credential-store';

export interface AppCredentialLifecycleEffects {
  /** Must coordinate with app update, uninstall, restore and watchdog recovery. */
  withMaintenance<T>(action: () => Promise<T>): Promise<T>;
  markPending(): Promise<void>;
  quiesce(): Promise<void>;
  /** Must write only server runtime configuration, using the existing installer. */
  writeRuntime(secret: string, credential: AppCredentialProjection): Promise<void>;
  publish(credential: AppCredentialProjection, expectedRevision: number): Promise<void>;
  restart(): Promise<void>;
  /** Must perform an actual scoped service request and verify installation/generation. */
  probe(credential: AppCredentialProjection): Promise<void>;
  markReady(status: AppCredentialStatusView): Promise<void>;
  markRevoked(status: AppCredentialStatusView): Promise<void>;
}

export type AppCredentialLifecycleAction =
  | { action: 'provision' }
  | { action: 'reconcile' }
  | { action: 'rotate'; expectedRevision: number }
  | { action: 'reinstall'; expectedRevision: number }
  | { action: 'revoke'; expectedRevision: number };

/**
 * Installer-only adoption, after resource ownership preflight and while holding
 * the app lifecycle lock. A kept-data uninstall leaves a revocation tombstone:
 * deliberate installation replaces that identity without resetting revisions.
 * Ordinary rendering and reconciliation must keep using their denying paths.
 */
export async function prepareCredentialForAppInstall(
  appId: string,
  store: AppServiceCredentialStore,
): Promise<AppCredentialProjection> {
  await store.recoverAbandonedOperation(appId);
  const current = await store.projection(appId);
  return current?.status === 'revoked'
    ? store.prepareReinstall(appId, current.revision)
    : store.provisionForInstall(appId);
}

/** Failures retain pending/maintenance state; there is no old-secret rollback. */
export async function runAppCredentialLifecycle(
  appId: string,
  operation: AppCredentialLifecycleAction,
  store: AppServiceCredentialStore,
  effects: AppCredentialLifecycleEffects,
): Promise<AppCredentialStatusView> {
  try {
    return await effects.withMaintenance(async () => {
      try {
        await effects.markPending();
        await effects.quiesce();
        await store.recoverAbandonedOperation(appId);
        let credential = await store.projection(appId);
        const priorStatus = await store.status(appId);
        if (operation.action === 'provision') {
          credential = await store.provisionForInstall(appId);
        } else if (operation.action === 'rotate') {
          // An identical retry after activation must not start another rotation.
          if (!(credential?.status === 'active'
            && priorStatus?.operationKind === 'rotate'
            && credential.revision === operation.expectedRevision + 2)) {
            credential = await store.prepareRotation(appId, operation.expectedRevision);
          }
        } else if (operation.action === 'reinstall') {
          if (!(credential?.status === 'active'
            && priorStatus?.operationKind === 'reinstall'
            && credential.revision === operation.expectedRevision + 2)) {
            credential = await store.prepareReinstall(appId, operation.expectedRevision);
          }
        } else if (operation.action === 'revoke') {
          credential = await store.revoke(appId, operation.expectedRevision);
          await effects.publish(credential, credential.revision - 1);
          const status = await store.status(appId);
          if (!status) throw new Error('Credential status unavailable');
          await effects.markRevoked(status);
          return status;
        }
        if (!credential || credential.status === 'revoked') {
          throw new Error('App credential requires repair');
        }
        await effects.writeRuntime(await store.runtimeSecret(appId), credential);
        if (credential.status === 'prepared') {
          await effects.publish(credential, credential.revision - 1);
          credential = await store.activate(appId, credential.revision);
        }
        await effects.publish(credential, credential.revision - 1);
        await effects.restart();
        await effects.probe(credential);
        const status = await store.status(appId);
        if (!status) throw new Error('Credential status unavailable');
        await effects.markReady(status);
        return status;
      } catch {
        // A failed restart/probe/readiness write must stop writers before the
        // maintenance lease is released. Durable pending metadata remains.
        try { await effects.markPending(); } finally { await effects.quiesce(); }
        throw new Error('App service integration requires reconciliation');
      }
    });
  } catch {
    // No foreign exception text: runtime writers/transports may include secrets.
    throw new Error('App service integration requires reconciliation');
  }
}
