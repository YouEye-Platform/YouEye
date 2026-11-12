import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { APP_SERVICE_CREDENTIAL_SCHEMA } from "../../shared/app-service-credential";
import {
  hashToken,
  validateRegisteredAppBearer,
} from "../src/lib/auth/app-bearer";

test("valid Bearer authenticates only the unique enabled registration", async () => {
  const secret = randomBytes(32).toString("base64url");
  const verifier = hashToken(secret);
  let lookedUp = false;
  const result = await validateRegisteredAppBearer(
    new Headers({ authorization: `Bearer ${secret}` }),
    async hash => {
      assert.ok(hash === verifier && hash !== secret);
      lookedUp = true;
      return [{ appId: "wiki", enabled: true, ready: true, projection: {
        schema: APP_SERVICE_CREDENTIAL_SCHEMA, appId: "wiki",
        installationId: "12345678-1234-4234-8234-123456789abc",
        generation: 1, revision: 2, status: "active", verifierHash: verifier,
        createdAt: "2026-01-01T00:00:00.000Z", rotatedAt: null,
        revokedAt: null, expiresAt: null,
      } }];
    },
  );
  assert.ok(lookedUp);
  assert.deepEqual(result, { appId: "wiki" });
});

test("missing, bare, malformed and duplicate Authorization never reach the verifier store", async () => {
  const secret = randomBytes(32).toString("base64url");
  let lookups = 0;
  for (const value of [
    null, secret, `Basic ${secret}`, "Bearer ", `Bearer  ${secret}`,
    `Bearer\t${secret}`, `Bearer Bearer ${secret}`, `Bearer ${secret}, Bearer other`,
  ]) {
    const headers = new Headers();
    if (value !== null) headers.set("authorization", value);
    assert.ok(await validateRegisteredAppBearer(headers, async () => {
      lookups++;
      return [{ appId: "wiki", enabled: true }];
    }) === null);
  }
  const repeated = new Headers();
  repeated.append("authorization", `Bearer ${secret}`);
  repeated.append("authorization", `Bearer ${secret}`);
  assert.ok(await validateRegisteredAppBearer(repeated, async () => {
    lookups++;
    return [{ appId: "wiki", enabled: true }];
  }) === null);
  assert.equal(lookups, 0);
});

test("random tokens, disabled/unknown registrations and colliding hashes deny authentication", async () => {
  const headers = new Headers({ authorization: "Bearer fixture" });
  for (const records of [
    [],
    [{ appId: "wiki", enabled: false }],
    [{ appId: "wiki", enabled: null }],
    [{ appId: "../wiki", enabled: true }],
    [{ appId: "wiki", enabled: true }, { appId: "ye-wiki", enabled: true }],
    [{ appId: "wiki", enabled: true }, { appId: "notes", enabled: false }],
  ]) {
    assert.ok(await validateRegisteredAppBearer(headers, async () => records) === null);
  }
});

test("verifier-store failure denies without logging or exposing foreign error details", async () => {
  const result = await validateRegisteredAppBearer(
    new Headers({ authorization: "Bearer fixture" }),
    async () => { throw new Error("fixture-private-verifier-detail"); },
  );
  assert.ok(result === null);
});

test("only current active unexpired matching projection authenticates", async () => {
  const headers = new Headers({ authorization: "Bearer fixture" });
  const valid = {
    schema: APP_SERVICE_CREDENTIAL_SCHEMA, appId: "wiki",
    installationId: "12345678-1234-4234-8234-123456789abc",
    generation: 1, revision: 2, status: "active", verifierHash: hashToken("fixture"),
    createdAt: "2026-01-01T00:00:00.000Z", rotatedAt: null,
    revokedAt: null, expiresAt: null,
  };
  for (const projection of [
    undefined, null, {}, { ...valid, status: "prepared" },
    { ...valid, status: "revoked", revokedAt: "2026-01-02T00:00:00.000Z" },
    { ...valid, expiresAt: "2026-01-02T00:00:00.000Z" },
    { ...valid, appId: "notes" }, { ...valid, verifierHash: hashToken("old") },
  ]) {
    assert.ok(await validateRegisteredAppBearer(headers, async () => [
      { appId: "wiki", enabled: true, ready: true, projection },
    ]) === null);
  }
});

test("probe can prove an unready current generation without opening service data or identity aliases", async () => {
  const headers = new Headers({ authorization: 'Bearer fixture', 'x-youeye-app': 'wiki' });
  const lookup = async () => [{
    appId: 'wiki', enabled: true, ready: false, projection: {
      schema: APP_SERVICE_CREDENTIAL_SCHEMA, appId: 'wiki',
      installationId: '12345678-1234-4234-8234-123456789abc',
      generation: 1, revision: 2, status: 'active', verifierHash: hashToken('fixture'),
      createdAt: '2026-01-01T00:00:00.000Z', rotatedAt: null, revokedAt: null, expiresAt: null,
    },
  }];
  assert.equal(await validateRegisteredAppBearer(headers, lookup), null);
  assert.deepEqual(await validateRegisteredAppBearer(headers, lookup, 'probe'), { appId: 'wiki' });
  for (const claim of ['ye-wiki', 'notes', 'wiki, wiki', '']) {
    headers.set('x-youeye-app', claim);
    assert.equal(await validateRegisteredAppBearer(headers, lookup, 'probe'), null);
  }
  headers.set('x-youeye-app', 'wiki');
  headers.set('x-ui-bridge-token', 'fixture');
  assert.equal(await validateRegisteredAppBearer(headers, lookup, 'probe'), null);
});
