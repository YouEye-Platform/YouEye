import test from 'node:test';
import assert from 'node:assert/strict';
import { safeLoginReturnTo, selectLoginReturnTo } from '../src/lib/identity/login-return';

const fallback = 'https://auth.devvm.test/';
const allowed = ['https://auth.devvm.test', 'https://devvm.test', 'https://notes.devvm.test'];

test('login resumes at registered appliance origins', () => {
  assert.equal(safeLoginReturnTo('https://auth.devvm.test/application/o/authorize?client_id=youeye-ui', fallback, allowed),
    'https://auth.devvm.test/application/o/authorize?client_id=youeye-ui');
  assert.equal(safeLoginReturnTo('https://notes.devvm.test/private', fallback, allowed), 'https://notes.devvm.test/private');
});

test('login preserves a valid query when the submitted return is missing or rejected', () => {
  const dashboard = 'https://devvm.test/';
  const authorize = 'https://auth.devvm.test/application/o/authorize?client_id=youeye-ui&state=example';
  for (const value of [null, '', 'https://evil.test/', '//evil.test/', 'https://auth.devvm.test/#fragment']) {
    assert.equal(selectLoginReturnTo(value, authorize, dashboard, allowed), authorize);
  }
  assert.equal(selectLoginReturnTo('https://notes.devvm.test/private', authorize, dashboard, allowed), 'https://notes.devvm.test/private');
});

test('missing or rejected form and query destinations fall back to the dashboard', () => {
  const dashboard = 'https://devvm.test/';
  const rejected = [null, '', 'https://evil.test/', 'https://devvm.test.evil.test/',
    'https://evil.test@devvm.test/', 'http://devvm.test/', '//devvm.test/',
    '/application/o/authorize', 'javascript:alert(1)', 'https://devvm.test/#fragment'];
  for (const form of rejected) for (const query of rejected) {
    assert.equal(selectLoginReturnTo(form, query, dashboard, allowed), dashboard);
  }
});

test('login rejects outside, deceptive, insecure and malformed returns', () => {
  for (const value of [
    'https://example.com/collect', 'https://auth.devvm.test.example.com/',
    'https://auth.devvm.test@evil.test/', 'http://auth.devvm.test/',
    '//example.com/', 'javascript:alert(1)', 'https://auth.devvm.test/#fragment',
    'https://user:pass@auth.devvm.test/',
  ]) assert.equal(safeLoginReturnTo(value, fallback, allowed), fallback, value);
});
