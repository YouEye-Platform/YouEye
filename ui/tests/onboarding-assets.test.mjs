import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = fs.readFileSync(new URL("../src/middleware.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
runInNewContext(code, {
  exports, process: { env: {} }, URL, TextEncoder,
  require(id) {
    if (id === "jose") return { jwtVerify: async () => { throw Error("No session"); } };
    if (id === "next/server") return { NextResponse: {
      next: () => ({ next: true }),
      json: (body, options) => ({ body, status: options.status }),
      redirect: (url) => ({ redirect: url.href }),
    } };
    throw Error(`Unexpected middleware dependency ${id}`);
  },
});
const request = (path) => ({
  nextUrl: new URL(path, "https://server.test"),
  url: new URL(path, "https://server.test").href,
  headers: new Headers(), cookies: { get: () => undefined },
});

test("first-start and CP-only sessions can fetch pinned lettering without dashboard sign-in", async () => {
  for (const path of ["/mytitle/fonts/abrilfatface.ttf", "/onboarding-fonts/IBMPlexSans-Regular.woff2"]) {
    assert.deepEqual(await exports.middleware(request(path)), { next: true });
  }
});
test("the static lettering exception leaves private pages and APIs protected", async () => {
  for (const path of ["/mytitle/private", "/onboarding-fonts-private", "/timeline"]) {
    assert.match((await exports.middleware(request(path))).redirect, /\/login\?redirect=/);
  }
  assert.equal((await exports.middleware(request("/api/v1/timeline"))).status, 401);
});
