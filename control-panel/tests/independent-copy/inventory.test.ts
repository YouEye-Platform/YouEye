import {expect,test} from 'bun:test';
import {inspectCopyApp,inspectCopyClients,COPY_NATIVE_APPS} from '../../src/lib/copy/inventory';
import {copyPlatformDigest,readCopyPlatformInventory} from '../../src/lib/copy/platform-inventory';
function fixture(appId='notes'){
 const metadata:any={appId,installationId:'fixture-install',integration:'native',lifecycleState:'active',serviceCredentialState:'ready',enableSSO:true,ssoClientId:`youeye-app-${appId}`,containers:[{containerName:`app-${appId}`}],desiredState:'running'};
 const manifest:any={metadata:{id:appId},secrets:[{name:'jwt_secret',file:'secrets/jwt_secret'},{name:'db_password',file:'secrets/db_password'}],containers:[{name:'main',type:'lxd'}],configFiles:[],env_mapping:{JWT_SECRET:'${secret.jwt_secret}',IDENTITY_CLIENT_ID:'${sso.client_id}',IDENTITY_CLIENT_SECRET:'${sso.client_secret}',YOUEYE_APP_TOKEN:'${youeye.app_token}',YOUEYE_APP_ID:'${app.id}'}};
 if(['search','wiki'].includes(appId)){manifest.database={mode:'none'};manifest.secrets=manifest.secrets.filter((s:any)=>s.name!=='db_password');metadata.databaseMode='none';}
 else{manifest.database={mode:'shared',name:`ye_${appId}`,user:`ye_${appId}`};manifest.env_mapping.DATABASE_URL='${database.url}';Object.assign(metadata,{databaseMode:'shared',databaseName:`ye_${appId}`,databaseUser:`ye_${appId}`,databasePasswordFile:'secrets/db_password'});}
 return {metadata,manifest};
}
test('copy inventory accepts the six native authority layouts and preserves stopped intent',()=>{
 for(const appId of COPY_NATIVE_APPS){const {metadata,manifest}=fixture(appId);metadata.desiredState='stopped';const result=inspectCopyApp(metadata,manifest);expect(result.desiredState).toBe('stopped');expect(result.containers).toEqual([`app-${appId}`]);expect(result.manifestSHA256).toHaveLength(64);}
});
test('copy refuses unknown apps, additional secrets, runtime authority overrides and unfinished work',()=>{
 const modifications=[({metadata}:any)=>metadata.appId='unknown',({manifest}:any)=>manifest.secrets.push({name:'provider',file:'.external'}),({manifest}:any)=>manifest.containers[0].environment={JWT_SECRET:'inherited'},({metadata}:any)=>metadata.lifecycleOperation={state:'partial'},({metadata}:any)=>metadata.storageVolumes=[{attachmentOnly:true}],({metadata}:any)=>metadata.ssoClientId='foreign',({manifest}:any)=>manifest.configFiles=[{template:'secret=${sso.client_secret}'}]];
 for(const mutate of modifications){const f=fixture();mutate(f);expect(()=>inspectCopyApp(f.metadata,f.manifest)).toThrow('Independent copy');}
});
test('client inventory requires exact local clients without silently deleting additional clients',()=>{
 const f=fixture(),app=inspectCopyApp(f.metadata,f.manifest),clients=['youeye-ui','youeye-app-notes','youeye-control'];
 expect(inspectCopyClients([app],clients)).toEqual([...clients].sort());
 expect(()=>inspectCopyClients([app],[...clients,'external'])).toThrow('adapter');
 expect(()=>inspectCopyClients([app],clients.slice(1))).toThrow('adapter');
 expect(()=>inspectCopyClients([app],[...clients,clients[0]])).toThrow('adapter');
});

test('platform inventory survives native JSON key ordering and rejects changed source authority',()=>{
 const source={schema:'youeye.copy-platform-inventory.v1',sourceDomain:'source.example.test',apps:[],clientIds:['youeye-control','youeye-ui'],pointer:'local-data-without-provider-authority',names:{fingerprint:'source-public-fingerprint',fqdn:'source.example.test'}};
 const sha256=copyPlatformDigest(source);
 const reordered=Object.fromEntries(Object.entries(source).reverse());
 expect(readCopyPlatformInventory({...reordered,sha256}).sha256).toBe(sha256);
 expect(()=>readCopyPlatformInventory({...source,sourceDomain:'different.example.test',sha256})).toThrow('binding');
 expect(()=>readCopyPlatformInventory({...source,privateKey:'unsupported',sha256})).toThrow('inventory');
});
