import { execCommand } from '../incus/server';
import { getContainerName } from '../market/engine-helpers';
import type { AppManifest, ContainerMeta } from '../market/types';
import { containerState, stopContainerOrForce, stopTimeoutSec } from '../incus/snapshot';
import { containerTargets, orderContainers, type ContainerRole } from './container-order';

/**
 * These stops must succeed (uninstall, restore, copy, revocation): clean first, forced after the timeout. With the
 * app's recorded `containers`, its containers stop in stop order (the database last) with their role's timeout;
 * names it does not list stop afterwards, in the given order, with the default timeout.
 */
export async function quiesceAppCredentialRuntime(names: string[], containers?: ContainerMeta[]): Promise<void> {
  const known = orderContainers(containerTargets(containers), 'stop').filter(target => names.includes(target.name));
  const ordered: Array<{ name: string; role?: ContainerRole }> = [
    ...known,
    ...names.filter(name => !known.some(target => target.name === name)).map(name => ({ name })),
  ];
  let failed = false;
  for (const { name, role } of ordered) {
    try {
      await stopContainerOrForce(name, { timeoutSec: stopTimeoutSec(role) });
      if (await containerState(name) !== 'Stopped') failed = true;
    } catch { failed = true; }
  }
  if (failed) throw new Error('App runtime quiescence requires repair');
}

/** Prove the supported native contract using protected runtime configuration. */
export async function probeNativeAppCredential(appId: string, manifest: AppManifest): Promise<void> {
  for (const spec of manifest.containers) {
    const mapping = { ...manifest.env_mapping, ...spec.environment };
    if (spec.type !== 'lxd'
      || !Object.values(mapping).some(value => value.includes('${youeye.app_token}'))) continue;
    if (mapping.YOUEYE_APP_TOKEN !== '${youeye.app_token}'
      || mapping.YOUEYE_APP_ID !== '${app.id}'
      || mapping.YOUEYE_GATEWAY !== '${youeye.gateway_url}') {
      throw new Error('Native service credential contract requires repair');
    }
    const name = getContainerName(appId, spec.name, manifest.containers.length);
    const result = await execCommand(name, [
      'node', `--env-file=/etc/${name}.env`, '-e',
      '(async()=>{const deadline=Date.now()+20000;while(Date.now()<deadline){try{const r=await fetch(process.env.YOUEYE_GATEWAY+"/credential-probe",{headers:{Authorization:"Bearer "+process.env.YOUEYE_APP_TOKEN,"X-YouEye-App":process.env.YOUEYE_APP_ID},signal:AbortSignal.timeout(Math.min(5000,deadline-Date.now()))});await r.body?.cancel();process.exit(r.ok?0:1)}catch{if(Date.now()>=deadline)break;await new Promise(resolve=>setTimeout(resolve,500))}}process.exit(1)})()',
    ], { timeout: 25_000 });
    if (result.exitCode !== 0) throw new Error('Native app credential probe failed');
  }
}
