import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {changePointerIdentity} from '../src/lib/pointer/identity-rename';

const require = createRequire(import.meta.url);
test('actual reconfigure rejects occupied Pointer identity before configuration, journal or route writes', async () => {
  const root = process.env.CONTROL_PANEL_ROOT || process.cwd();
  const source = readFileSync(path.join(root, 'src/lib/reconfigure/index.ts'), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  }}).outputText;
  const events: string[] = [];
  let held = false;
  const writes = () => assert.fail('No mutation is permitted before the identity guard');
  const exports: {reconfigure?: (input: unknown, report: (event: unknown) => void) => Promise<unknown>} = {};
  runInNewContext(code, {exports, URL, process: {env: {
    IDENTITY_URL: 'https://id.first.test', CONTROL_EXTERNAL_URL: 'https://control.first.test',
  }}, console, require(id: string) {
    if (id === '@/lib/settings') return {settingsService: {
      async getRaw() {return {domain: 'first.test', subdomains: {identity: 'id', control: 'control'}};}, setRaw: writes,
    }};
    if (id === './journal') return {processStartTime: 1, async readReconfigureJournal() {return null;}, saveReconfigureJournal: writes};
    if (id === '@/lib/market/metadata') return {async listInstalledApps() {return [];}, saveInstallMetadata: writes};
    if (id === '@/lib/identity/config') return {identityConfigFromSettings(raw: any) {
      return {externalUrl: 'https://' + raw.subdomains.identity + '.' + raw.domain};
    }};
    if (id === '@/lib/market/update-admission') return {async withAppLifecycle(app: string, work: () => Promise<unknown>) {
      assert.equal(app, 'pointer'); events.push('admission'); held=true;
      try {return await work();} finally {held=false; events.push('release');}
    }};
    if (id === '@/lib/pointer/identity-rename') return {changePointerIdentity};
    if (id === '@/lib/pointer/identity-transition') return {async transitionPointerIdentity(change: any, check: boolean) {
      assert.ok(held); assert.equal(check, true);
      assert.equal(change.oldIssuer, 'https://id.first.test'); assert.equal(change.newIssuer, 'https://id.next.test');
      events.push('guard'); throw Error('Destination actor domain occupied');
    }};
    if (id === '@/lib/identity/store') return {invalidatePublicOidcState: writes};
    if (id === '@/lib/dns-providers/config') return {async getByoDnsProviderConfig() {return null;}};
    if (id === '@/lib/caddy/client') return {setDomain: writes, setConfig: writes, ensureIdentityRoute: writes};
    if (id === 'node:dns/promises') return {default: {async resolve4() {return [];}}};
    if (id.startsWith('node:')) return require(id);
    return {};
  }});
  await assert.rejects(exports.reconfigure!({domain: 'next.test'}, () => {}), /Destination actor domain occupied/);
  assert.deepEqual(events, ['admission', 'guard', 'release']);
});
