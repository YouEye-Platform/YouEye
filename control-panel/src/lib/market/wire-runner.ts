/**
 * Connection wiring.
 *
 * When an app→app connection is approved (by a bundle or by the owner), the consumer's
 * `connects[].setup` file (`for: connect:<app>`) configures the two apps to talk to each other,
 * e.g. register Sonarr as an application in Prowlarr. It runs through the setup runner with
 * `${peer.*}` (the connected app) and `${self.*}` (the consumer) values; only its `http` steps
 * with `target: peer` reach the connected app, and only its primary container's API.
 *
 * Both apps' manifests come from their frozen installed copies, never the live catalog. An app's
 * API key (`${peer.api_key}`, `${self.api_key}`) is the secret its frozen manifest's `api_key:`
 * names, read from that app's own secret store.
 *
 * Non-fatal: a wiring failure is logged and never breaks connection approval; setup steps are
 * idempotent, so re-running is safe.
 */

import { readAppSecret } from '@/lib/infrastructure/secrets';
import { connectionInterface } from '@/lib/incus/connection-nic';
import { loadBridges } from '../bridges/store';
import { readFrozenUpdateManifest } from './frozen-manifest';
import { describeErrorChainForLog } from './install-tracker';
import { readInstallMetadata } from './metadata';
import { setupContainers } from './setup-context';
import { runSetup, setupFor, type SetupTransport } from './setup-runner';
import type { AppManifest, InstallMetadata, VariableContext } from './types';

export interface WiringDeps {
  readManifest(appId: string): Promise<AppManifest>;
  readMetadata(appId: string): Promise<InstallMetadata | null>;
  /** Whether the from→to connection is approved and active. */
  isApproved(fromAppId: string, toAppId: string): Promise<boolean>;
  /** One secret from an installed app's secret store (null when it has none by that name). */
  readSecret(appId: string, name: string): Promise<string | null>;
  transport?: SetupTransport;
}

async function readSecrets(deps: WiringDeps, manifest: AppManifest, appId: string): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};
  for (const secret of manifest.secrets) {
    const value = await deps.readSecret(appId, secret.name);
    if (value) secrets[secret.name] = value;
  }
  return secrets;
}

const defaultDeps: WiringDeps = {
  readManifest: (appId) => readFrozenUpdateManifest(appId),
  readMetadata: readInstallMetadata,
  async isApproved(fromAppId, toAppId) {
    return (await loadBridges()).some((bridge) => bridge.from === fromAppId && bridge.to === toAppId
      && bridge.approved && bridge.active);
  },
  readSecret: readAppSecret,
};

interface Endpoint {
  container: string;
  port: number;
  values: { host: string; url: string; api_key?: string };
}

/**
 * An app's primary container as seen on `network`'s bridge (the peer's network for both ends):
 * the peer on its own eth0, the consumer on its connection NIC (`iface`). The transport accepts
 * only an address inside that network's lease (see `appContainerAddress`).
 */
async function endpoint(
  appId: string, manifest: AppManifest, meta: InstallMetadata, deps: WiringDeps, network: string, iface?: string,
): Promise<Endpoint> {
  const primary = manifest.containers.find((spec) => spec.primary) ?? manifest.containers[0];
  if (!primary?.port) throw new Error(`${appId} has no primary container port`);
  const container = setupContainers(manifest, meta)[primary.name];
  const io = deps.transport ?? (await import('./setup-transport')).incusSetupTransport;
  const host = await io.address(container, network, iface);
  let apiKey: string | undefined;
  if (manifest.apiKey) {
    apiKey = (await deps.readSecret(appId, manifest.apiKey.secret)) || undefined;
    if (!apiKey) console.warn(`[wire] ${appId}: its API key secret "${manifest.apiKey.secret}" is missing`);
  }
  return {
    container,
    port: primary.port,
    values: { host, url: `http://${host}:${primary.port}`, ...(apiKey ? { api_key: apiKey } : {}) },
  };
}

/**
 * Run the consumer's (`from`) connect setup for `to`, if it declares one: its `steps:` when the
 * connection becomes active, its `remove:` steps (`options.remove`) before it is deactivated or
 * deleted. Returns whether a setup ran (and any error); never throws. Apps without a setup file
 * for the target are a no-op; a connection that is not approved and active is refused.
 */
export async function runConnectionWiring(
  fromAppId: string,
  toAppId: string,
  deps: WiringDeps = defaultDeps,
  options: { remove?: boolean } = {},
): Promise<{ ran: boolean; error?: string }> {
  const action = options.remove ? 'unwire' : 'wire';
  let fromManifest: AppManifest;
  try {
    fromManifest = await deps.readManifest(fromAppId);
  } catch {
    return { ran: false };
  }
  const want = fromManifest.wants.find((w) => w.appId === toAppId);
  if (!want?.setup) return { ran: false };
  // Nothing to undo: skip the address lookups (the consumer may already be stopped for its uninstall).
  if (options.remove && !(setupFor(fromManifest, `connect:${toAppId}`)?.remove?.length)) return { ran: false };

  try {
    if (!(await deps.isApproved(fromAppId, toAppId))) {
      return { ran: false, error: `connection ${fromAppId} → ${toAppId} is not approved` };
    }
    const [fromMeta, toMeta] = await Promise.all([deps.readMetadata(fromAppId), deps.readMetadata(toAppId)]);
    if (!fromMeta || !toMeta) return { ran: false, error: 'endpoint not installed' };
    const toManifest = await deps.readManifest(toAppId);
    const [self, peer] = await Promise.all([
      endpoint(fromAppId, fromManifest, fromMeta, deps, toAppId, connectionInterface(toAppId)),
      endpoint(toAppId, toManifest, toMeta, deps, toAppId),
    ]);
    const variables: Partial<VariableContext> = {
      app: {
        id: fromAppId,
        name: fromManifest.metadata.name,
        subdomain: fromMeta.subdomain,
        fqdn: `${fromMeta.subdomain}.${fromMeta.domain}`,
        url: `https://${fromMeta.subdomain}.${fromMeta.domain}`,
      } as VariableContext['app'],
      secret: await readSecrets(deps, fromManifest, fromAppId),
      self: self.values as VariableContext['self'],
      peer: { id: toAppId, ...peer.values } as VariableContext['peer'],
    };
    const ran = await runSetup(fromManifest, `connect:${toAppId}`, {
      appId: fromAppId,
      containers: setupContainers(fromManifest, fromMeta),
      variables,
      peer: { appId: toAppId, container: peer.container, port: peer.port },
      remove: options.remove,
      transport: deps.transport,
    });
    if (ran) console.log(`[wire] ${options.remove ? 'Unwired' : 'Wired'} ${fromAppId} → ${toAppId}`);
    return { ran };
  } catch (err) {
    console.error(`[wire] Failed to ${action} ${fromAppId} → ${toAppId}: ${describeErrorChainForLog(err)}`);
    return { ran: false, error: `Could not ${action} ${fromAppId} → ${toAppId}` };
  }
}
