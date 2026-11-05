/**
 * Connection wire-runner.
 *
 * When an app→app connection is approved — by a bundle's auto-approve OR a user approving a
 * suggestion for two separately-installed apps — the consumer's `want.wire` recipe runs to
 * configure the apps to actually talk to each other (e.g. register Sonarr as an Application
 * in Prowlarr). This is a GENERAL capability: the recipe lives on the app's `want`, so it
 * works for individually-installed apps too; a bundle only *enables* the connection.
 *
 * API-key-only model: each app declares `apiKey: { file, pattern }` (how to read its key
 * from its running container); recipes call the apps' REST APIs with that key. No web-UI
 * auth is mutated. Recipes interpolate ${wire.from.*} / ${wire.to.*} (host, port, apiKey, url).
 *
 * Non-fatal + idempotent: a wiring failure is logged and never breaks connection approval;
 * recipes re-assert config so re-running is safe.
 */

import { fetchManifest } from './catalog';
import { readInstallMetadata } from './metadata';
import { runSteps } from './sso-engine';
import { resolveVariables } from './variables';
import { execShell } from '../incus/server';
import { getContainerIP } from '../incus/container-ip';
import type { AppManifest, InstallMetadata, VariableContext } from './types';

function containerOf(meta: InstallMetadata | null, appId: string): string {
  return meta?.containers?.[0]?.containerName || `app-${appId}`;
}

/** Read an app's API key from its running container, per the manifest's `apiKey` declaration. */
async function resolveApiKey(appId: string, manifest: AppManifest, container: string): Promise<string | undefined> {
  const spec = manifest.apiKey;
  if (!spec) return undefined;
  try {
    const { stdout } = await execShell(container, `cat ${spec.file}`, { timeout: 10_000 });
    return new RegExp(spec.pattern).exec(stdout)?.[1];
  } catch (err) {
    console.warn(`[wire] Failed to read API key for ${appId} (${spec.file}):`, err);
    return undefined;
  }
}

interface WireEndpoint { id: string; host: string; port?: number; apiKey?: string; url?: string }

async function resolveEndpoint(appId: string): Promise<WireEndpoint | null> {
  const meta = await readInstallMetadata(appId);
  if (!meta) return null;
  const container = containerOf(meta, appId);
  const host = (await getContainerIP(container)) || container;
  let manifest: AppManifest | null = null;
  try { manifest = await fetchManifest(appId); } catch { /* native/repo app — no manifest here */ }
  const port = manifest?.containers?.[0]?.port;
  const apiKey = manifest ? await resolveApiKey(appId, manifest, container) : undefined;
  return { id: appId, host, port, apiKey, url: port ? `http://${host}:${port}` : `http://${host}` };
}

/**
 * Run the wire recipe for a from→to connection, if the consumer (`from`) declares one for
 * `to`. Returns whether a recipe ran (and any error). Safe to call on every connection
 * approval — apps without a `want.wire` for the target are a no-op.
 */
export async function runConnectionWiring(fromAppId: string, toAppId: string): Promise<{ ran: boolean; error?: string }> {
  let fromManifest: AppManifest;
  try {
    fromManifest = await fetchManifest(fromAppId);
  } catch {
    return { ran: false };
  }
  const want = fromManifest.wants?.find((w) => w.appId === toAppId);
  if (!want?.wire) return { ran: false };

  try {
    const [from, to] = await Promise.all([resolveEndpoint(fromAppId), resolveEndpoint(toAppId)]);
    if (!from || !to) return { ran: false, error: 'endpoint not installed' };

    const ctx: Partial<VariableContext> = { wire: { from, to } };

    // CLI steps run in the provider (`to`) container — the app that typically needs a local
    // config tweak (e.g. qBittorrent local-subnet auth bypass). Then the API steps.
    const toContainer = containerOf(await readInstallMetadata(toAppId), toAppId);
    for (const step of want.wire.cli?.steps ?? []) {
      await execShell(toContainer, resolveVariables(step.exec, ctx), { timeout: step.timeout });
    }
    await runSteps(want.wire.api?.steps ?? [], ctx);

    console.log(`[wire] Wired ${fromAppId} → ${toAppId}`);
    return { ran: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[wire] Failed to wire ${fromAppId} → ${toAppId}:`, msg);
    return { ran: false, error: msg };
  }
}
