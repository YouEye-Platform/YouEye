import type {CopyAppInventory} from './inventory';
import {execCommand} from '../incus/server';
import {writeCopyAppSecret} from './app-secret';

export async function inspectCopyAppDatabase(app:CopyAppInventory){
 const db=app.database;if(!db)throw Error('Exact copied app database required');
 if(!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(db.name)||!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(db.role)||['youeye','postgres'].includes(db.role))throw Error('Unsupported copied database identity');
 const result=await execCommand('youeye-postgres',['psql','--no-psqlrc','-U','youeye','-d','postgres','-qAt','-v','ON_ERROR_STOP=1','-c',
  `SELECT count(*) FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname='${db.name}' AND r.rolname='${db.role}' AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolbypassrls AND (SELECT count(*) FROM pg_database WHERE datdba=r.oid)=1 AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)`],{timeout:15000});
 if(result.exitCode!==0||result.stdout.trim()!=='1')throw Error('Copied app database ownership or authority requires an adapter');
}

/** Invoked under the exact native/app lifecycle admission with app writers
 * stopped. Change only the recorded machine role password; never recreate a
 * database, owner, grant or user row. The protected parent journal owns replay. */
export async function prepareCopyAppDatabase(app:CopyAppInventory,password:string){
 if(!/^[a-f0-9]{96}$/.test(password))throw Error('Prepared database credential required');
 await inspectCopyAppDatabase(app);const db=app.database!;
 const encoded=Buffer.from(password).toString('base64');
 const result=await execCommand('youeye-postgres',['psql','--no-psqlrc','-U','youeye','-d','postgres','-qAt','-v','ON_ERROR_STOP=1','-c',
  `DO $copy$ BEGIN EXECUTE format('ALTER ROLE %I PASSWORD %L','${db.role}',convert_from(decode(current_setting('youeye.copy_password'),'base64'),'UTF8')); END $copy$;`],{environment:{PGOPTIONS:`-c youeye.copy_password=${encoded}`},timeout:15000});
 if(result.exitCode!==0)throw Error('Copied database credential requires reconciliation');
 const probe=await execCommand('youeye-postgres',['psql','--no-psqlrc','-h','127.0.0.1','-U',db.role,'-d',db.name,'-qAt','-v','ON_ERROR_STOP=1','-c','SELECT 1'],{environment:{PGPASSWORD:password},timeout:15000});
 if(probe.exitCode!==0||probe.stdout.trim()!=='1')throw Error('Copied database credential failed authentication');
 await writeCopyAppSecret(app.appId,password,'database');
}
