import {generateKeyPair,randomBytes} from 'node:crypto';
import {promisify} from 'node:util';
import {assertIndependentCopyLifecycle} from '../market/update-admission';
import {ensureIdentitySchema,identityCommand,identityRows,withIdentityAppLifecycle,identitySql as sql,identitySqlJson as sqlJson} from './store';

import {independentIdentityRequest,type IndependentIdentityRequest} from '../copy/request';
export {independentIdentityRequest,type IndependentIdentityRequest} from '../copy/request';

/** Internal native-copy step, not a browser/admin reset action. The coordinator
 * holds platform quarantine plus all identity/app lifecycle gates, has positively
 * inventoried every client and will rewrite/probe its protected runtime config.
 * This step deliberately does not claim complete copy or app readiness.
 */
export async function prepareIndependentIdentity(input:IndependentIdentityRequest){
  const {request}=independentIdentityRequest(input);
  assertIndependentCopyLifecycle({request_id:request.requestId,source_hardware:request.sourceHardware,destination_hardware:request.destinationHardware,source_receipt_sha256:request.sourceReceiptSHA256,manifest_sha256:request.manifestSHA256});
  return withIdentityAppLifecycle(()=>prepareIndependentIdentityUnderLifecycle(request));
}
async function prepareIndependentIdentityUnderLifecycle(input:IndependentIdentityRequest){
  const {request,fingerprint}=independentIdentityRequest(input);
  await ensureIdentitySchema();
  const existing=await identityRows<{fingerprint:string}>(`SELECT fingerprint FROM identity_copy_preparations WHERE request_id=${sql(request.requestId)}`);
  if(existing.length){if(existing[0].fingerprint!==fingerprint)throw new Error('Independent identity request conflict');return {requestId:request.requestId,state:'authority-prepared' as const};}
  const {privateKey}=await promisify(generateKeyPair)('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  const jwt=randomBytes(48).toString('hex');
  const replacements=request.clientIds.map(clientId=>({clientId,secret:randomBytes(32).toString('hex')}));
  try{
    await identityCommand(`BEGIN;
      SELECT pg_advisory_xact_lock(hashtext('youeye-independent-identity'));
      LOCK TABLE identity_clients IN SHARE ROW EXCLUSIVE MODE;
      DO $copy_identity$
      DECLARE prior text;
      BEGIN
        SELECT fingerprint INTO prior FROM identity_copy_preparations WHERE request_id=${sql(request.requestId)};
        IF FOUND THEN
          IF prior<>${sql(fingerprint)} THEN RAISE EXCEPTION 'Independent identity request conflict'; END IF;
          RETURN;
        END IF;
        IF (SELECT COALESCE(jsonb_agg(client_id ORDER BY client_id),'[]'::jsonb) FROM identity_clients)<>${sqlJson(request.clientIds)} THEN
          RAISE EXCEPTION 'Identity client inventory changed';
        END IF;
        INSERT INTO identity_copy_preparations(request_id,fingerprint,source_hardware,destination_hardware)
          VALUES(${sql(request.requestId)},${sql(fingerprint)},${sql(request.sourceHardware)},${sql(request.destinationHardware)});
        UPDATE identity_sessions SET revoked_at=COALESCE(revoked_at,now());
        UPDATE identity_refresh_families SET revoked_at=COALESCE(revoked_at,now());
        UPDATE identity_refresh_tokens SET revoked_at=COALESCE(revoked_at,now());
        UPDATE identity_auth_codes SET used_at=COALESCE(used_at,now());
        UPDATE identity_setup_handoffs SET used_at=COALESCE(used_at,now());
        UPDATE identity_appliance_claim SET operation_session_id=NULL,operation_expires_at=NULL;
        -- Never send inherited back-channel requests to the source's clients.
        UPDATE identity_logout_deliveries SET delivered_at=COALESCE(delivered_at,now());
        INSERT INTO identity_revoked_before(user_id,revoked_before) SELECT id,now() FROM identity_users
          ON CONFLICT(user_id) DO UPDATE SET revoked_before=GREATEST(identity_revoked_before.revoked_before,EXCLUDED.revoked_before);
        DELETE FROM identity_secrets WHERE purpose LIKE 'oauth-rs256-retired:%';
        INSERT INTO identity_secrets(purpose,secret) VALUES('jwt',${sql(jwt)}),('oauth-rs256-private-key',${sql(privateKey)})
          ON CONFLICT(purpose) DO UPDATE SET secret=EXCLUDED.secret,created_at=now();
        ${replacements.map(({clientId,secret})=>`UPDATE identity_clients SET client_secret=${sql(secret)},updated_at=now() WHERE client_id=${sql(clientId)} AND client_secret<>'';`).join('\n')}
      END $copy_identity$;
      COMMIT;`);
  }catch{
    // SQL errors can contain protected literals. The coordinator receives only
    // a bounded reconciliation error and retains the original immutable key.
    throw new Error('Independent identity authority requires reconciliation');
  }
  return {requestId:request.requestId,state:'authority-prepared' as const};
}
