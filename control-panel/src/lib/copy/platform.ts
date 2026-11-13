import {createHash} from 'node:crypto';
import {verifyIndependentPlatformServices} from './verify';
import {retainIndependentSourceHistory} from './source-history';
import {lstat,unlink} from 'node:fs/promises';
import {withIndependentCopyLifecycle} from '../market/update-admission';
import {withCopyJournal} from './journal';
import {independentIdentityRequest} from './request';
import {copyPlatformDigest,readCopyPlatformInventory} from './platform-inventory';
import {prepareIndependentIdentity} from '../identity/copy';
import {prepareIndependentAdmission} from './admission';
import {prepareIndependentApp} from './app-runtime';
import {readFrozenUpdateManifest} from '../market/frozen-manifest';
import {readInstallMetadata} from '../market/metadata';
import type {AppManifest} from '../market/types';
import {reconfigure} from '../reconfigure';
import {readReconfigureJournal} from '../reconfigure/journal';
import {settingsService} from '../settings';
import {tlsStorage} from '../acme/storage';
import {removeExternalCert} from '../caddy/client';
import {parseNamesBundle,applyBundleIdentity,NAMES_IMPORT_FILE_PATH} from '../youeye-names/bundle';
import {getStoredInstallIdentity,validateStoredIdentity} from '../youeye-names/identity';
import {NAMES_LIFECYCLE_FILE_PATH,writeNamesLifecycleState} from '../youeye-names/state';
import {validateCertificateMaterial} from '../youeye-names/certificate';
import {identityRows,identitySql as sql} from '../identity/store';

type NativeRequest={request_id:string;source_hardware:string;destination_hardware:string;source_receipt_sha256:string;manifest_sha256:string};
type Journal={schema:'youeye.copy-platform.v1';fingerprint:string;inventorySHA256:string;domain:string;namesFingerprint:string;bundleSHA256:string;sourceHistoryRetained:boolean;identityPrepared:boolean;sourceAuthorityRemoved:boolean;domainApplied:boolean;appsPrepared:boolean};
export type CopyPlatformStep='identity'|'domain'|'apps'|'verify';

/** Invoked only by the authenticated native copy endpoint. Its protected
 * source inventory and imported destination bundle remain immutable on retry.
 * An intermediate success never releases the host/network copy reservation. */
export async function prepareIndependentPlatform(native:NativeRequest,inventoryInput:unknown,bundleInput:unknown,step:CopyPlatformStep){
 const inventory=readCopyPlatformInventory(inventoryInput),bundle=parseNamesBundle(bundleInput);
 if(bundle.fqdn===inventory.sourceDomain||bundle.identity.fingerprint===inventory.names?.fingerprint)throw Error('Copy requires an independent Names domain and identity');
 const imported=validateStoredIdentity(bundle.identity).identity;
 const {request,fingerprint}=independentIdentityRequest({requestId:native.request_id,sourceHardware:native.source_hardware,destinationHardware:native.destination_hardware,sourceReceiptSHA256:native.source_receipt_sha256,manifestSHA256:native.manifest_sha256,clientIds:inventory.clientIds});
 const bundleSHA256=copyPlatformDigest(bundle);
 return withIndependentCopyLifecycle(native,()=>withCopyJournal(request.requestId,'platform',async journal=>{
  let record=await journal.read() as Journal|null;
  if(record){if(record.schema!=='youeye.copy-platform.v1'||record.fingerprint!==fingerprint||record.inventorySHA256!==inventory.sha256||record.domain!==bundle.fqdn||record.namesFingerprint!==imported.fingerprint||record.bundleSHA256!==bundleSHA256)throw Error('Independent platform request differs from retained preparation');}
  else{
   if(step!=='identity')throw Error('Native copy identity step must run first');
   const current=await settingsService.getRaw();if(current.domain!==inventory.sourceDomain)throw Error('Copied source domain differs');
   record={schema:'youeye.copy-platform.v1',fingerprint,inventorySHA256:inventory.sha256,domain:bundle.fqdn,namesFingerprint:imported.fingerprint,bundleSHA256,sourceHistoryRetained:false,identityPrepared:false,sourceAuthorityRemoved:false,domainApplied:false,appsPrepared:false};
   await journal.write(record);
  }
  if(step==='identity'){
   if(!record.sourceHistoryRetained){retainIndependentSourceHistory(native);record.sourceHistoryRetained=true;await journal.write(record);}
   await prepareIndependentIdentity(request);record.identityPrepared=true;await journal.write(record);
   return {requestId:request.requestId,phase:'identity-prepared',quarantineRequired:true};
  }
  if(!record.identityPrepared)throw Error('Native identity preparation required');
  const prepared=await identityRows<{fingerprint:string}>(`SELECT fingerprint FROM identity_copy_preparations WHERE request_id=${sql(request.requestId)}`);
  if(prepared.length!==1||prepared[0].fingerprint!==fingerprint)throw Error('Native identity preparation receipt differs');
  if(step==='domain'){
   if(record.domainApplied&&!await readReconfigureJournal()){
    const current=await settingsService.getRaw(),identity=await getStoredInstallIdentity();
    if(current.domain!==bundle.fqdn||identity.fingerprint!==imported.fingerprint)throw Error('Prepared copied domain changed');
    return {requestId:request.requestId,phase:'domain-prepared',domain:bundle.fqdn,quarantineRequired:true};
   }
   const manifests=new Map<string,AppManifest>();
   for(const app of inventory.apps){
    const metadata=await readInstallMetadata(app.appId);if(!metadata||metadata.installationId!==app.installationId)throw Error('Reconfigure copied apps before rebinding installation identity');
    const manifest=await readFrozenUpdateManifest(app.appId,metadata.installedVersion);
    if(createHash('sha256').update(JSON.stringify(manifest)).digest('hex')!==app.manifestSHA256)throw Error('Copied installed manifest changed');
    manifests.set(app.appId,manifest);
   }
   if(!record.sourceAuthorityRemoved){
    // The new deployment secret intentionally cannot decrypt inherited TLS
    // keys. Discard only the known copied authority, without contacting or
    // revoking the source registration. No ordinary source data is removed.
    await removeExternalCert();await tlsStorage.revertToInternal();
    await settingsService.setRaw({tls_acme_account_key_file:''});
    for(const path of ['/var/lib/youeye/config/tls/acme-account-key.enc','/var/lib/youeye/config/tls/external-cert.pem','/var/lib/youeye/config/tls/external-key.enc',NAMES_LIFECYCLE_FILE_PATH,NAMES_IMPORT_FILE_PATH])await removeCopiedAuthorityFile(path);
    await applyBundleIdentity(bundle);
    record.sourceAuthorityRemoved=true;await journal.write(record);
   }
   await reconfigure({domain:bundle.fqdn,tls:'names-bundle',namesBundle:bundle,namesIdentity:imported,installedManifests:manifests,beforeRestart:async()=>{
    const active=await tlsStorage.getCert();if(!active)throw Error('Copied Names certificate unavailable');
    const validated=validateCertificateMaterial({certificateChain:active.certPem,privateKeyPem:active.keyPem,fqdn:bundle.fqdn});
    const now=new Date().toISOString();
    await writeNamesLifecycleState({schemaVersion:1,service:bundle.service,name:bundle.name,fqdn:bundle.fqdn,status:'healthy',provisioning:null,termsVersion:bundle.consent.termsVersion,certificateTransparencyAcceptedAt:bundle.consent.certificateTransparencyAcceptedAt,certificate:{fingerprint:validated.fingerprint,provider:bundle.certificate.provider,issuedAt:validated.issuedAt,expiresAt:validated.expiresAt},lastBrokerContactAt:now,lastHeartbeatAt:null,nextCheckAt:new Date(Date.now()+6*60*60*1000).toISOString(),lastError:null});
    record!.domainApplied=true;await journal.write(record);
   }},()=>{});
   return {requestId:request.requestId,phase:'domain-restart-pending',domain:bundle.fqdn,quarantineRequired:true};
  }
  if(!record.domainApplied||await readReconfigureJournal())throw Error('Copied domain service restart must settle first');
  if((await settingsService.getRaw()).domain!==bundle.fqdn||(await getStoredInstallIdentity()).fingerprint!==imported.fingerprint)throw Error('Copied domain or Names authority changed');
  if(step==='apps'){
   await prepareIndependentAdmission(request,inventory.apps);
   const apps=[];for(const app of inventory.apps)apps.push(await prepareIndependentApp(request,app));
   record.appsPrepared=true;await journal.write(record);
   return {requestId:request.requestId,phase:'apps-prepared',apps,quarantineRequired:true};
  }
  if(!record.appsPrepared)throw Error('Copied app authority preparation required');
  // Native final verification separately observes actual signed service bytes,
  // process credentials, installed membership, host identity and product health.
  const services=await verifyIndependentPlatformServices(inventory,bundle);
  return {requestId:request.requestId,phase:'platform-prepared',...services,inventorySHA256:inventory.sha256,quarantineRequired:true};
 }));
}

async function removeCopiedAuthorityFile(path:string){
 try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw Error('Copied authority has unsupported storage');await unlink(path);}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
