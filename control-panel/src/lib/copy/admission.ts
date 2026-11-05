import {randomUUID} from 'node:crypto';
import {assertIndependentCopyLifecycle} from '../market/update-admission';
import {ensureIdentitySchema,identityCommand,identityRows,identitySql as sql,withIdentityAppLifecycle} from '../identity/store';
import {independentIdentityRequest,type IndependentIdentityRequest} from './request';
import type {CopyAppInventory} from './inventory';

export interface CopyAdmissionBinding {app_id:string;source_installation_id:string;destination_installation_id:string}
/** Rebind only machine-local installation references. The same transaction
 * preserves principal/group UUIDs, grants, owners and per-user data mappings. */
export async function prepareIndependentAdmission(input:IndependentIdentityRequest,apps:CopyAppInventory[]):Promise<CopyAdmissionBinding[]>{
 const {request,fingerprint}=independentIdentityRequest(input);
 assertIndependentCopyLifecycle({request_id:request.requestId,source_hardware:request.sourceHardware,destination_hardware:request.destinationHardware,source_receipt_sha256:request.sourceReceiptSHA256,manifest_sha256:request.manifestSHA256});
 if(new Set(apps.map(a=>a.appId)).size!==apps.length||apps.some(a=>!request.clientIds.includes(a.clientId)||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(a.appId)||!/^[a-f0-9-]{36}$/.test(a.installationId)))throw Error('Exact native app copy inventory required');
 return withIdentityAppLifecycle(async()=>{
  await ensureIdentitySchema();
  const changes=apps.map(a=>({...a,destination:randomUUID()}));
  try{await identityCommand(`BEGIN;
   SELECT pg_advisory_xact_lock(hashtext('youeye-admission-lifecycle'));
   LOCK TABLE admission_policies IN SHARE ROW EXCLUSIVE MODE;
   SET CONSTRAINTS ALL DEFERRED;
   SELECT set_config('youeye.independent_copy_request',${sql(request.requestId)},true);
   DO $copy_admission$
   DECLARE bound admission_copy_bindings; current_policy admission_policies;
   BEGIN
    IF NOT EXISTS(SELECT 1 FROM identity_copy_preparations WHERE request_id=${sql(request.requestId)} AND fingerprint=${sql(fingerprint)}) THEN RAISE EXCEPTION 'Copy identity step required'; END IF;
    IF (SELECT count(*) FROM admission_policies WHERE state<>'deleted')<>${apps.length} THEN RAISE EXCEPTION 'App inventory changed'; END IF;
    ${changes.map(a=>`
    SELECT * INTO bound FROM admission_copy_bindings WHERE request_id=${sql(request.requestId)} AND app_id=${sql(a.appId)};
    IF FOUND THEN
     IF bound.source_installation_id<>${sql(a.installationId)}::uuid OR bound.completed_at IS NULL
       OR NOT EXISTS(SELECT 1 FROM admission_policies WHERE installation_id=bound.destination_installation_id AND app_id=bound.app_id)
       THEN RAISE EXCEPTION 'Copy admission receipt differs'; END IF;
    ELSE
     SELECT * INTO current_policy FROM admission_policies WHERE app_id=${sql(a.appId)} FOR UPDATE;
     IF NOT FOUND OR current_policy.installation_id<>${sql(a.installationId)}::uuid OR current_policy.state NOT IN ('ready','pending') THEN RAISE EXCEPTION 'Copy app ownership changed'; END IF;
     IF EXISTS(SELECT 1 FROM admission_resources WHERE installation_id=current_policy.installation_id AND (declaration->>'scope'='shared' OR jsonb_array_length(COALESCE(declaration->'consumerIds','[]'::jsonb))>0)) THEN RAISE EXCEPTION 'Shared resources need a native copy adapter'; END IF;
     INSERT INTO admission_copy_bindings(request_id,app_id,source_installation_id,destination_installation_id)
       VALUES(${sql(request.requestId)},${sql(a.appId)},${sql(a.installationId)}::uuid,${sql(a.destination)}::uuid);
     UPDATE admission_policies SET installation_id=${sql(a.destination)}::uuid,state='pending',revision=revision+1,updated_at=now() WHERE installation_id=${sql(a.installationId)}::uuid;
     UPDATE admission_clients SET installation_id=${sql(a.destination)}::uuid WHERE installation_id=${sql(a.installationId)}::uuid;
     UPDATE admission_routes SET installation_id=${sql(a.destination)}::uuid WHERE installation_id=${sql(a.installationId)}::uuid;
     UPDATE admission_machine_callbacks SET installation_id=${sql(a.destination)}::uuid WHERE installation_id=${sql(a.installationId)}::uuid;
     UPDATE admission_resources SET installation_id=${sql(a.destination)}::uuid,declaration=jsonb_set(declaration,'{installationId}',to_jsonb(${sql(a.destination)}::text)) WHERE installation_id=${sql(a.installationId)}::uuid;
     UPDATE admission_user_data_contracts SET installation_id=${sql(a.destination)}::uuid WHERE installation_id=${sql(a.installationId)}::uuid;
     UPDATE admission_audit SET installation_id=${sql(a.destination)}::uuid WHERE installation_id=${sql(a.installationId)}::uuid;
     DELETE FROM admission_outbox WHERE installation_id=${sql(a.installationId)}::uuid;
     INSERT INTO admission_audit(installation_id,actor_id,action,revision,details)
      VALUES(${sql(a.destination)}::uuid,current_policy.owner_id,'independent_copy',current_policy.revision+1,jsonb_build_object('requestId',${sql(request.requestId)},'sourceInstallationId',${sql(a.installationId)}));
     UPDATE admission_copy_bindings SET completed_at=now() WHERE request_id=${sql(request.requestId)} AND app_id=${sql(a.appId)};
    END IF;`).join('\n')}
    -- Inherited logout work must never call source endpoints.
    UPDATE admission_logout_outbox SET queued=true;
   END $copy_admission$;
   COMMIT;`);}catch{throw Error('Independent app ownership requires native reconciliation');}
  return identityRows<CopyAdmissionBinding>(`SELECT app_id,source_installation_id::text,destination_installation_id::text FROM admission_copy_bindings WHERE request_id=${sql(request.requestId)} ORDER BY app_id`);
 });
}
