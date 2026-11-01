import {prepareCopyAppDatabase} from './app-database';
import {createHash,randomBytes} from 'node:crypto';
import {writeCopyAppSecret} from './app-secret';
import {assertIndependentCopyLifecycle,withAppLifecycle} from '../market/update-admission';
import {independentIdentityRequest,type IndependentIdentityRequest} from './request';
import {withCopyJournal} from './journal';
import {inspectCopyApp,type CopyAppInventory} from './inventory';
import {readInstallMetadata,saveInstallMetadata} from '../market/metadata';
import {readFrozenUpdateManifest} from '../market/frozen-manifest';
import {identityRows,identitySql as sql,getClient} from '../identity/store';
import {incusRequest,incusDownloadFile,incusUploadFile} from '../incus/server';
import {waitForOperation} from '../incus/snapshot';
import {quiesceAppCredentialRuntime} from '../apps/service-credential-probe';
import {appServiceCredentials} from '../apps/service-credential-store';
import {operateAppCredential} from '../apps/service-credential-operations';
import {rewriteCredentialEnvironment} from '../apps/service-credential-runtime';
import {settingsService} from '../settings';
import type {CopyAdmissionBinding} from './admission';

type Journal={schema:'youeye.copy-app.v1';requestFingerprint:string;source:CopyAppInventory;destinationInstallation:string;jwt:string;databasePassword:string;revoked:boolean;ready:boolean};
const nativeRequest=(r:IndependentIdentityRequest)=>({request_id:r.requestId,source_hardware:r.sourceHardware,destination_hardware:r.destinationHardware,source_receipt_sha256:r.sourceReceiptSHA256,manifest_sha256:r.manifestSHA256});

/** Only native destination copy invokes this. Ordinary credential/install
 * coordinators still own all runtime writes, revocation, activation and probes. */
export async function prepareIndependentApp(input:IndependentIdentityRequest,source:CopyAppInventory){
 const {request,fingerprint}=independentIdentityRequest(input);
 assertIndependentCopyLifecycle(nativeRequest(request));
 return withAppLifecycle(source.appId,()=>withCopyJournal(request.requestId,source.appId,async journal=>{
  const binding=(await identityRows<CopyAdmissionBinding>(`SELECT app_id,source_installation_id::text,destination_installation_id::text FROM admission_copy_bindings WHERE request_id=${sql(request.requestId)} AND app_id=${sql(source.appId)} AND completed_at IS NOT NULL`))[0];
  if(!binding||binding.source_installation_id!==source.installationId||!source.serviceCredential)throw Error('Exact copied app binding and source credential required');
  const metadata=await readInstallMetadata(source.appId);
  if(!metadata||![binding.source_installation_id,binding.destination_installation_id].includes(metadata.installationId??''))throw Error('Copied app metadata ownership changed');
  const manifest=await readFrozenUpdateManifest(source.appId,metadata.installedVersion);
  if(createHash('sha256').update(JSON.stringify(manifest)).digest('hex')!==source.manifestSHA256)throw Error('Copied app manifest changed');
  let record=await journal.read() as Journal|null;
  if(record){
   if(record.schema!=='youeye.copy-app.v1'||record.requestFingerprint!==fingerprint||JSON.stringify(record.source)!==JSON.stringify(source)||record.destinationInstallation!==binding.destination_installation_id||!/^[a-f0-9]{96}$/.test(record.jwt)||source.database&&!/^[a-f0-9]{96}$/.test(record.databasePassword))throw Error('Copied app journal differs');
  }else{
   const observed=inspectCopyApp(metadata,manifest);
   if(observed.installationId!==source.installationId||observed.clientId!==source.clientId||JSON.stringify(observed.containers)!==JSON.stringify(source.containers))throw Error('Copied app source layout differs');
   const credential=await appServiceCredentials.status(source.appId);
   if(!credential||credential.status!=='active'||credential.installationId!==source.serviceCredential.installationId||credential.revision!==source.serviceCredential.revision||credential.pendingPublications)throw Error('Copied app service authority differs');
   record={schema:'youeye.copy-app.v1',requestFingerprint:fingerprint,source,destinationInstallation:binding.destination_installation_id,jwt:randomBytes(48).toString('hex'),databasePassword:source.database?randomBytes(48).toString('hex'):'',revoked:false,ready:false};
   await journal.write(record);
  }
  // A retained ready journal is evidence only after the live credential and
  // runtime probe below have been reconciled again; it never short-circuits it.
  await quiesceAppCredentialRuntime(source.containers);
  const resources=await identityRows<{resource_id:string;owner_id:string}>(`SELECT resource_id,owner_id::text FROM admission_resources WHERE installation_id=${sql(binding.destination_installation_id)}::uuid`);
  const ownerFor=(name:string)=>{const owner=resources.find(r=>r.resource_id===name)?.owner_id;if(!owner)throw Error('Copied runtime data owner is unresolved');return owner;};
  for(const name of source.containers)await rebindResource(`/1.0/instances/${encodeURIComponent(name)}`,source.appId,binding,ownerFor(`runtime:${name}`));
  for(const volume of metadata.storageVolumes??[]){
   if(volume.attachmentOnly||volume.sharedGroup||volume.shareId||volume.pool!=='default')throw Error('Copied volume requires a supported native adapter');
   await rebindResource(`/1.0/storage-pools/${encodeURIComponent(volume.pool)}/volumes/custom/${encodeURIComponent(volume.name)}`,source.appId,binding,ownerFor(`volume:${volume.name}`));
   volume.installationId=binding.destination_installation_id;
  }
  metadata.installationId=binding.destination_installation_id;
  metadata.serviceCredentialState='pending';metadata.serviceCredentialDesiredState=source.desiredState;metadata.desiredState='stopped';metadata.enabled=false;
  await saveInstallMetadata(metadata);
  if(!record.revoked){
   await operateAppCredential(source.appId,{action:'revoke',expectedRevision:source.serviceCredential.revision});
   record.revoked=true;await journal.write(record);
  }
  await writeCopyAppSecret(source.appId,record.jwt);
  if(source.database)await prepareCopyAppDatabase(source,record.databasePassword);
  const client=await getClient(source.clientId);if(!client?.client_secret)throw Error('Copied app identity client unavailable');
  const settings=await settingsService.getRaw();if(typeof settings.domain!=='string'||settings.domain!==metadata.domain)throw Error('Reconcile the copied app domain before its credentials');
  for(const name of source.containers){
   const path=`/etc/${name}.env`,before=await incusDownloadFile(name,path);
   let input=before.toString('utf8');
   if(source.database){const rows=input.split('\n').filter(line=>line.startsWith('DATABASE_URL='));if(rows.length!==1)throw Error('Copied database environment differs');const url=new URL(rows[0].slice('DATABASE_URL='.length));if(!['postgres:','postgresql:'].includes(url.protocol)||url.username!==source.database.role||url.pathname!=='/'+source.database.name||!url.password)throw Error('Copied database binding differs');url.password=record.databasePassword;input=rewriteCredentialEnvironment(input,{DATABASE_URL:url.toString()});}
   const after=Buffer.from(rewriteCredentialEnvironment(input,{JWT_SECRET:record.jwt,IDENTITY_CLIENT_ID:source.clientId,IDENTITY_CLIENT_SECRET:client.client_secret}));
   await incusUploadFile(name,path,after,{mode:'0600'});
   if(!after.equals(await incusDownloadFile(name,path)))throw Error('Copied runtime authority did not read back');
  }
  await operateAppCredential(source.appId,{action:'reinstall',expectedRevision:source.serviceCredential.revision+1});
  const accepted=await appServiceCredentials.status(source.appId);
  if(!accepted||accepted.status!=='active'||accepted.installationId===source.serviceCredential.installationId||accepted.revision!==source.serviceCredential.revision+3||accepted.pendingPublications!==0)throw Error('Independent app service authority is not ready');
  record.ready=true;await journal.write(record);
  return {appId:source.appId,sourceInstallationId:source.installationId,installationId:binding.destination_installation_id,serviceInstallationId:accepted.installationId,revision:accepted.revision,state:'ready' as const};
 }));
}

async function rebindResource(path:string,appId:string,binding:CopyAdmissionBinding,ownerId:string){
 const read=await incusRequest<{config:Record<string,string>;description?:string}>('GET',path);
 const config=read.metadata?.config;
 if(read.type==='error'||!config||config['user.youeye.app_id']!==appId||config['user.youeye.data_owner_id']!==ownerId||![binding.source_installation_id,binding.destination_installation_id].includes(config['user.youeye.installation_id']))throw Error('Copied resource has foreign ownership');
 if(config['user.youeye.installation_id']!==binding.destination_installation_id){
  const volume=path.startsWith('/1.0/storage-pools/');
  const write=await incusRequest(volume?'PUT':'PATCH',path,{...(volume?{description:read.metadata?.description??''}:{}),config:{...(volume?config:{}),'user.youeye.installation_id':binding.destination_installation_id}});
  if(write.type==='error')throw Error('Copied resource rebind failed');
  if(write.type==='async'&&write.operation)await waitForOperation(write.operation,60);
 }
 const after=await incusRequest<{config:Record<string,string>}>('GET',path);
 if(after.type==='error'||after.metadata?.config?.['user.youeye.installation_id']!==binding.destination_installation_id||after.metadata?.config?.['user.youeye.data_owner_id']!==ownerId)throw Error('Copied resource ownership did not read back');
}
