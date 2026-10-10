/** Explicit disposable appliance acceptance; never runs during the ordinary suite. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appUpdatePostgresCatalogQuery } from '../../src/lib/market/update-postgres';
import { execCommand, incusUploadFile } from '../../src/lib/incus/server';

export async function verifyAppUpdatePostgresCatalog() {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const database = `ye_update_catalog_${suffix}`;
  const ownerRole = `ye_update_owner_${suffix}`;
  const otherRole = `ye_update_other_${suffix}`;
  const file = `/var/lib/postgresql/youeye-catalog-${suffix}.sql`;
  let rolesCreated = false;
  let databaseCreated = false;
  async function sql(target: string, statement: string) {
    await incusUploadFile('youeye-postgres', file, Buffer.from(statement), {mode:'0600'});
    const result = await execCommand('youeye-postgres', ['psql', '--no-psqlrc', '--no-password', '-U', 'youeye', '-d', target,
      '-v', 'ON_ERROR_STOP=1', '-A', '-t', '--file', file], { timeout: 30_000 });
    assert.equal(result.exitCode, 0, 'Disposable PostgreSQL catalog statement failed');
    return result.stdout;
  }
  async function observation() {
    return JSON.parse((await sql(database, appUpdatePostgresCatalogQuery({ database, ownerRole }))).trim());
  }
  try {
    // Atomic role creation refuses any existing name. Neither login has a password.
    await sql('youeye', `BEGIN; CREATE ROLE ${ownerRole} LOGIN; CREATE ROLE ${otherRole} LOGIN; COMMIT;`);
    rolesCreated = true;
    await sql('youeye', `CREATE DATABASE ${database} OWNER ${ownerRole};`);
    databaseCreated = true;
    await sql(database, `SET ROLE ${ownerRole}; CREATE TABLE public.items (id integer PRIMARY KEY, value text);
      CREATE FUNCTION public.catalog_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
      CREATE TRIGGER catalog_trigger BEFORE INSERT ON public.items FOR EACH ROW EXECUTE FUNCTION public.catalog_trigger();`);
    const ordinary = await observation();
    assert.deepEqual(ordinary.foreignOwners, []);
    assert.ok(!ordinary.foreignWriters.includes(otherRole), 'Invoker trigger EXECUTE does not grant table writes');
    await sql(database, `SET ROLE ${ownerRole}; ALTER FUNCTION public.catalog_trigger() SECURITY DEFINER;`);
    const privileged = await observation();
    assert.ok(privileged.foreignWriters.includes(otherRole), 'Privileged trigger EXECUTE remains an independent writer');
    await sql(database, `SET ROLE ${ownerRole}; ALTER FUNCTION public.catalog_trigger() SECURITY INVOKER;
      GRANT INSERT ON TABLE public.items TO ${otherRole};`);
    assert.ok((await observation()).foreignWriters.includes(otherRole), 'Actual DML privileges remain foreign writers');
    await sql(database, `SET ROLE ${ownerRole}; REVOKE INSERT ON TABLE public.items FROM ${otherRole};`);
    assert.ok(!(await observation()).foreignWriters.includes(otherRole));
    // Existing live sessions verify PostgreSQL inet projection against concrete runtime IPs.
    const native = JSON.parse((await sql('ye_cinema', appUpdatePostgresCatalogQuery({database:'ye_cinema',ownerRole:'ye_cinema'}))).trim());
    const sessions = native.sessions.filter((session: {role:string;address:string|null}) => session.role === 'ye_cinema' && session.address);
    assert.ok(sessions.length > 0, 'Expected the retained native app connection');
    const state = await execCommand('app-cinema', ['hostname','-I'], {timeout:10_000});
    assert.equal(state.exitCode,0);
    const addresses = state.stdout.trim().split(/\s+/);
    assert.ok(sessions.every((session:{address:string}) => !session.address.includes('/') && addresses.includes(session.address)));
    return {invokerTriggerPassed:true,securityDefinerRejected:true,foreignDMLRejected:true,exactNativeAddressPassed:true};
  } finally {
    if (databaseCreated) await sql('youeye', `DROP DATABASE ${database} WITH (FORCE);`);
    if (rolesCreated) await sql('youeye', `DROP ROLE ${ownerRole}; DROP ROLE ${otherRole};`);
    const removed = await execCommand('youeye-postgres',['rm','--',file],{timeout:10_000});
    assert.equal(removed.exitCode,0,'Disposable catalog input cleanup failed');
  }
}
