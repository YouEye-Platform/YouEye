import {createHash} from 'node:crypto';
import type {AppManifest,InstallMetadata} from '../market/types';
import {getContainerName} from '../market/engine-helpers';

/** Deliberately explicit: an arbitrary app sharing a familiar name is not a
 * supported credential layout. The installed frozen manifest defines the shape. */
export class CopyInventoryError extends Error {}
export const COPY_NATIVE_APPS = ['cinema','notes','search','translate','weather','wiki'] as const;
export interface CopyAppInventory {
  appId:string;
  installationId:string;
  clientId:string;
  manifestSHA256:string;
  containers:string[];
  desiredState:'running'|'stopped';
  database?:{name:string;role:string};
  serviceCredential?:{installationId:string;revision:number};
}
export function inspectCopyApp(metadata:InstallMetadata,manifest:AppManifest):CopyAppInventory {
  const fail=(reason:string):never=>{throw new CopyInventoryError(`Independent copy cannot prepare ${metadata.appId}: ${reason}`);};
  if(!(COPY_NATIVE_APPS as readonly string[]).includes(metadata.appId)||manifest.metadata.id!==metadata.appId
    ||metadata.integration!=='native'||metadata.lifecycleState!=='active'||metadata.serviceCredentialState!=='ready')fail('supported active native installation required');
  if(!metadata.installationId||!metadata.enableSSO||metadata.ssoClientId!==`youeye-app-${metadata.appId}`)fail('exact local installation and identity client required');
  if(metadata.retainedRoots||metadata.lifecycleOperation&&metadata.lifecycleOperation.state!=='completed'
    ||metadata.forwardAuthEnabled||metadata.aiConnection||metadata.aiConnectionPending)fail('retained work or additional integration needs a copy adapter');
  if(metadata.storageVolumes?.some(v=>v.attachmentOnly||v.sharedGroup||v.shareId)||metadata.databaseMode==='own')fail('foreign or separately managed data needs a copy adapter');
  const secrets=manifest.secrets.map(s=>`${s.name}:${s.file}`).sort();
  if(!secrets.includes('jwt_secret:secrets/jwt_secret')||secrets.some(s=>!['jwt_secret:secrets/jwt_secret','db_password:secrets/db_password'].includes(s))||new Set(secrets).size!==secrets.length)fail('unhandled secret layout');
  let database:CopyAppInventory['database'];
  if(manifest.database?.mode==='shared'){
   const {name, user}=manifest.database;
   if(!name||!user||!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)||!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(user)||['youeye','youeye_ui','pointer','postgres','template0','template1'].includes(name)||['youeye','postgres'].includes(user)||metadata.databaseMode!=='shared'||metadata.databaseName!==name||metadata.databaseUser!==user||metadata.databasePasswordFile!=='secrets/db_password'||!secrets.includes('db_password:secrets/db_password')||manifest.env_mapping?.DATABASE_URL!=='${database.url}')fail('exact native shared database binding required');
   database={name:name!,role:user!};
  }else if(metadata.databaseMode==='shared'||metadata.databaseName||metadata.databaseUser||secrets.includes('db_password:secrets/db_password'))fail('database authority requires a copy adapter');
  const required={JWT_SECRET:'${secret.jwt_secret}',IDENTITY_CLIENT_ID:'${sso.client_id}',IDENTITY_CLIENT_SECRET:'${sso.client_secret}',YOUEYE_APP_TOKEN:'${youeye.app_token}',YOUEYE_APP_ID:'${app.id}'};
  if(Object.entries(required).some(([key,value])=>manifest.env_mapping?.[key]!==value))fail('unhandled authority environment');
  if(manifest.containers.length!==1||manifest.containers[0].type!=='lxd'||manifest.containers[0].environment&&Object.keys(manifest.containers[0].environment).some(key=>key in required))fail('unhandled container authority override');
  const containers=manifest.containers.map(c=>getContainerName(metadata.appId,c.name,manifest.containers.length));
  const installed=metadata.containers.map(c=>c.containerName);
  if(containers.length!==installed.length||containers.some(n=>!installed.includes(n)))fail('runtime inventory differs');
  if(manifest.configFiles.some(c=>/\$\{(?:sso\.|secret\.jwt_secret|youeye\.app_token)/.test(c.template)))fail('additional authority-bearing configuration needs a copy adapter');
  return {appId:metadata.appId,installationId:metadata.installationId!,clientId:metadata.ssoClientId!,...(database?{database}:{}),manifestSHA256:createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),containers,desiredState:metadata.desiredState??'running'};
}

export function inspectCopyClients(apps:CopyAppInventory[],clientIds:string[]):string[] {
  const expected=['youeye-control','youeye-ui',...apps.map(a=>a.clientId)].sort();
  if(new Set(clientIds).size!==clientIds.length||JSON.stringify([...clientIds].sort())!==JSON.stringify(expected))throw new CopyInventoryError('Independent copy requires an adapter for unknown or missing identity clients');
  return expected;
}
