import {inspectCopyAppDatabase} from './app-database';
import {appUpdateJournalStore} from '../market/update-admission';
import {updateNeedsRecovery} from '../market/update-journal';
import {lstat,readdir} from 'node:fs/promises';
import {listInstalledApps,listRetainedApps} from '../market/metadata';
import {readFrozenUpdateManifest} from '../market/frozen-manifest';
import {identityRows} from '../identity/store';
import {settingsService} from '../settings';
import {execCommand} from '../incus/server';
import {readReconfigureJournal} from '../reconfigure/journal';
import {appServiceCredentials} from '../apps/service-credential-store';
import {inspectCopyApp,inspectCopyClients,CopyInventoryError} from './inventory';
import {copyPlatformDigest,readCopyPlatformInventory} from './platform-inventory';
import {getStoredInstallIdentity} from '../youeye-names/identity';
import {readNamesLifecycleState} from '../youeye-names/state';

async function populatedDirectory(path:string):Promise<boolean>{
 try{const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw new CopyInventoryError('Unsupported copy integration path');return (await readdir(path)).length>0;}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}

/** No secrets leave this read-only inventory. New integrations must provide a
 * supported native disposition; an empty/unavailable observation is not proof. */
export async function inspectInstalledCopyInventory(){
 if(appUpdateJournalStore().list().some(updateNeedsRecovery))throw new CopyInventoryError('Complete app update recovery before copying');
 const installed=await listInstalledApps();
 if((await listRetainedApps()).some(m=>m.retainedRoots?.state!=='adopted'))throw new CopyInventoryError('Retained app data requires an independent copy adapter');
 if(await readReconfigureJournal())throw new CopyInventoryError('Complete the pending server URL change before copying');
 const settings=await settingsService.getRaw();
 if(!settings.setup_completed||typeof settings.domain!=='string'||!settings.domain)throw new CopyInventoryError('Configured source platform required for independent copy');
 if(settings.smtp_host||settings.smtp_username||settings.dns_provider_config)throw new CopyInventoryError('Configured SMTP or external DNS provider requires an independent copy disposition');
 for(const [key,allowed] of Object.entries({tls_cert_file:['/var/lib/youeye/config/tls/external-cert.pem'],tls_key_file:['/var/lib/youeye/config/tls/external-key.enc','/var/lib/youeye/config/tls/external-key.pem'],tls_acme_account_key_file:['/var/lib/youeye/config/tls/acme-account-key.enc','/var/lib/youeye/config/tls/acme-account-key.pem']})){
  const value=(settings as Record<string,unknown>)[key];if(value&&!allowed.includes(String(value)))throw new CopyInventoryError('Custom TLS authority storage requires a copy adapter');
 }
 const namesState=await readNamesLifecycleState();
 if(namesState?.provisioning||namesState?.status==='renewing'||namesState&&namesState.fqdn!==settings.domain)throw new CopyInventoryError('Names work must settle on the current source domain before copying');
 let names=null;
 try{const identity=await getStoredInstallIdentity();names={fingerprint:identity.fingerprint,fqdn:namesState?.fqdn??null};}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'||namesState)throw new CopyInventoryError('Source Names authority inventory is unavailable');}
 // Provider accounts include OAuth/device-flow authority, even if disabled.
 // Reject it before source shutdown; do not silently discard it in a copy.
 const pointer=await execCommand('youeye-postgres',['psql','-U','youeye','-d','pointer','-qAt','-v','ON_ERROR_STOP=1','-c',
  "BEGIN READ ONLY; SELECT (SELECT count(*) FROM provider_accounts)+(SELECT count(*) FROM provider_keys)+(SELECT count(*) FROM provider_oauth_device_flows); COMMIT;"],{timeout:15000});
 if(pointer.exitCode!==0||pointer.stdout.trim()!=='0')throw new CopyInventoryError('Pointer provider authority is present or its inventory is unavailable');
 if(await populatedDirectory('/var/lib/youeye/pointer/runtime/engine'))throw new CopyInventoryError('Pointer engine state requires an independent copy disposition');
 const apps=[];
 for(const metadata of installed.sort((a,b)=>a.appId.localeCompare(b.appId))){
  const app=inspectCopyApp(metadata,await readFrozenUpdateManifest(metadata.appId,metadata.installedVersion));
  if(app.database)await inspectCopyAppDatabase(app);
  const credential=await appServiceCredentials.observeCopyStatus(app.appId);
  if(!credential||credential.status!=='active'||credential.pendingPublications!==0)throw new CopyInventoryError('Native app service authority must settle before copying');
  app.serviceCredential={installationId:credential.installationId,revision:credential.revision};apps.push(app);
 }
 const clients=await identityRows<{client_id:string}>('SELECT client_id FROM identity_clients ORDER BY client_id');
 const clientIds=inspectCopyClients(apps,clients.map(c=>c.client_id));
 const body={schema:'youeye.copy-platform-inventory.v1' as const,sourceDomain:settings.domain,apps,clientIds,pointer:'local-data-without-provider-authority' as const,names};
 return readCopyPlatformInventory({...body,sha256:copyPlatformDigest(body)});
}
