import {createPublicKey} from 'node:crypto';
import {getClient,getOAuthSigningKeySnapshot} from '../identity/store';
import {execCommand,incusDownloadFile} from '../incus/server';
import {readInstallMetadata} from '../market/metadata';
import {readFrozenUpdateManifest} from '../market/frozen-manifest';
import {appServiceCredentials} from '../apps/service-credential-store';
import {probeCredential} from '../apps/service-credential-bridge';
import {probeNativeAppCredential} from '../apps/service-credential-probe';
import {containerState} from '../incus/snapshot';
import {tlsStorage} from '../acme/storage';
import {validateCertificateMaterial} from '../youeye-names/certificate';
import type {NamesBundle} from '../youeye-names/bundle';
import type {CopyPlatformInventory} from './platform-inventory';

/** Real current service observations, separate from the phase journal. Never
 * return credentials, private signing material or a foreign response body. */
export async function verifyIndependentPlatformServices(inventory:CopyPlatformInventory,bundle:NamesBundle){
 const cp=await getClient('youeye-control'),ui=await getClient('youeye-ui');
 if(!cp?.client_secret||cp.client_secret!==process.env.IDENTITY_CLIENT_SECRET||!ui?.client_secret)throw Error('Copied platform OAuth authority is not loaded');
 const pid=await execCommand('youeye-ui',['systemctl','show','youeye-ui','--property=MainPID','--value'],{timeout:10000});
 if(pid.exitCode!==0||!/^[1-9][0-9]*$/.test(pid.stdout.trim()))throw Error('Copied UI process unavailable');
 const environment=await execCommand('youeye-ui',['cat',`/proc/${pid.stdout.trim()}/environ`],{timeout:10000});
 if(environment.exitCode!==0||!environment.stdout.split('\0').includes('IDENTITY_CLIENT_SECRET='+ui.client_secret))throw Error('Copied UI has not loaded its OAuth authority');
 const snapshot=await getOAuthSigningKeySnapshot();if(snapshot.retired.length)throw Error('Inherited signing keys remain');
 const expected=createPublicKey(snapshot.active).export({format:'jwk'});
 const response=await fetch('http://127.0.0.1:3001/oauth/jwks',{redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('Copied identity service unavailable');
 const served=await response.json();if(!Array.isArray(served.keys)||served.keys.length!==1||served.keys[0].n!==expected.n||served.keys[0].e!==expected.e)throw Error('Copied identity service has not loaded its signing authority');
 const certificate=await tlsStorage.getCert();if(!certificate)throw Error('Copied TLS authority unavailable');
 const actual=validateCertificateMaterial({certificateChain:certificate.certPem,privateKeyPem:certificate.keyPem,fqdn:bundle.fqdn});
 if(actual.fingerprint!==bundle.certificate.fingerprint)throw Error('Copied TLS authority differs from destination bundle');
 for(const app of inventory.apps){
  const metadata=await readInstallMetadata(app.appId),credential=await appServiceCredentials.observeCopyStatus(app.appId);
  if(!metadata||metadata.installationId===app.installationId||metadata.domain!==bundle.fqdn||metadata.serviceCredentialState!=='ready'||metadata.desiredState!==app.desiredState||!credential||credential.status!=='active'||credential.installationId===app.serviceCredential.installationId||credential.revision!==app.serviceCredential.revision+3||credential.pendingPublications!==0)throw Error('Independent app authority is not ready');
  const client=await getClient(app.clientId);if(!client?.client_secret)throw Error('Independent app OAuth authority unavailable');
  for(const name of app.containers){
   const env=(await incusDownloadFile(name,`/etc/${name}.env`)).toString('utf8');
   if(!env.split('\n').includes('IDENTITY_CLIENT_SECRET='+client.client_secret))throw Error('Independent app OAuth configuration differs');
   if(await containerState(name)!==(app.desiredState==='running'?'Running':'Stopped'))throw Error('Independent app running intent differs');
  }
  await probeCredential(app.appId);
  if(app.desiredState==='running')await probeNativeAppCredential(app.appId,await readFrozenUpdateManifest(app.appId,metadata.installedVersion));
 }
 return {domain:bundle.fqdn,certificateFingerprint:actual.fingerprint};
}
