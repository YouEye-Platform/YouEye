import test from 'node:test';
import assert from 'node:assert/strict';
import { safeLoginReturnTo } from '../src/lib/identity/login-return';

const fallback = 'https://auth.devvm.test/';
const allowed = ['https://auth.devvm.test', 'https://devvm.test', 'https://notes.devvm.test'];

test('login resumes at registered appliance origins', () => {
  assert.equal(safeLoginReturnTo('https://auth.devvm.test/application/o/authorize?client_id=youeye-ui', fallback, allowed),
    'https://auth.devvm.test/application/o/authorize?client_id=youeye-ui');
  assert.equal(safeLoginReturnTo('https://notes.devvm.test/private', fallback, allowed), 'https://notes.devvm.test/private');
});

test('login rejects outside, deceptive, insecure and malformed returns', () => {
  for (const value of [
    'https://example.com/collect', 'https://auth.devvm.test.example.com/',
    'https://auth.devvm.test@evil.test/', 'http://auth.devvm.test/',
    '//example.com/', 'javascript:alert(1)', 'https://auth.devvm.test/#fragment',
    'https://user:pass@auth.devvm.test/',
  ]) assert.equal(safeLoginReturnTo(value, fallback, allowed), fallback, value);
});
