import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function page(session: unknown) {
  const root = process.env.CONTROL_PANEL_ROOT || process.cwd();
  const source = readFileSync(path.join(root, 'src/app/onboarding/page.tsx'), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  }}).outputText;
  const exports: {default?: () => Promise<unknown>} = {};
  runInNewContext(code, {exports, require(id: string) {
    if (id === 'react/jsx-runtime') return require(id);
    if (id === 'next/navigation') return {redirect(url: string) {throw Error('redirect:' + url);}};
    if (id === '@/lib/auth/session') return {async getSession() {return session;}};
    if (id === '@/components/onboarding/onboarding-client') return {OnboardingClient() {}};
    throw Error('Unexpected onboarding dependency ' + id);
  }});
  return exports.default!;
}

test('onboarding reauthenticates an ended CP session through its routed SSO endpoint', async () => {
  // Middleware may accept an unexpired JWT whose authoritative ID session has
  // ended. Root /login belongs to UI and loops if its newer session is valid.
  await assert.rejects(page(null)(), /^Error: redirect:\/settings\/api\/auth\/sso\?redirect=\/onboarding$/);
});
test('onboarding retains recovery-session exclusion and ordinary-user rendering', async () => {
  for (const authMethod of ['pam', 'cli']) {
    await assert.rejects(page({authMethod})(), /^Error: redirect:\/settings$/);
  }
  const element = await page({authMethod: 'sso', username: 'ordinary'})() as {props: {username: string}};
  assert.equal(element.props.username, 'ordinary');
});
