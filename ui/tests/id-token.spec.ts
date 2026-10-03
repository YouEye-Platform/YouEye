import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { verifyIdentityToken } from "../src/lib/auth/id-token";

test("uses internal JWKS transport and retains signature, issuer and audience checks", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.url, "/oauth/jwks");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const internalUrl = `http://127.0.0.1:${address.port}`;
    const discovery = {
      issuer: "https://log.unresolvable.invalid/application/o/youeye-ui/",
      jwks_uri: "https://log.unresolvable.invalid/oauth/jwks",
    };
    const token = await new SignJWT({ sub: "user-1" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(discovery.issuer)
      .setAudience("youeye-ui")
      .setExpirationTime("5m")
      .sign(privateKey);

    const verified = await verifyIdentityToken(token, discovery, "youeye-ui", internalUrl);
    assert.equal(verified.payload.sub, "user-1");
    assert.equal(requests, 1);

    await assert.rejects(verifyIdentityToken(token, { ...discovery, issuer: "https://other.invalid/" }, "youeye-ui", internalUrl));
    await assert.rejects(verifyIdentityToken(token, discovery, "another-client", internalUrl));
    const { privateKey: wrongKey } = await generateKeyPair("RS256");
    const forged = await new SignJWT({ sub: "user-1" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(discovery.issuer)
      .setAudience("youeye-ui")
      .setExpirationTime("5m")
      .sign(wrongKey);
    await assert.rejects(verifyIdentityToken(forged, discovery, "youeye-ui", internalUrl));
    await assert.rejects(verifyIdentityToken(token, { ...discovery, jwks_uri: "https://log.unresolvable.invalid/other" }, "youeye-ui", internalUrl));
  } finally {
    server.close();
  }
});
