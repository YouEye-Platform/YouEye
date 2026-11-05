import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = join(import.meta.dirname, "..");

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

test("launch requirements derive internet permissions from manifest proxy scopes", () => {
  const scopes = read("src/lib/internet/scopes.ts");
  const launch = read("src/app/api/v1/apps/[appId]/launch-requirements/route.ts");
  const bridge = read("src/app/api/ui-bridge/app-launch-permissions/route.ts");

  assert.match(scopes, /collectInternetPermissions/);
  assert.match(scopes, /permissionForInternetHost/);
  assert.match(launch, /collectInternetPermissions\(manifest\)/);
  assert.match(bridge, /collectInternetPermissions\(manifest\)/);
});

test("internet proxy validates app token, user permission, scope, and SSRF guards", () => {
  const route = read("src/app/api/apps/v1/internet/route.ts");
  const middleware = read("src/middleware.ts");

  assert.match(middleware, /"\/api\/apps\/v1\/internet"/);
  assert.match(route, /validateAppToken\(request\)/);
  assert.match(route, /resolveServiceAuth\(request\)/);
  assert.match(route, /findInternetScope\(manifest, targetUrl, request\.method\)/);
  assert.match(route, /checkPermission\(serviceUser\.id, sourceAppId, permissionForInternetHost\(scope\.host\)\)/);
  assert.match(route, /assertPublicHost\(targetUrl\.hostname\)/);
  assert.match(route, /redirect: "manual"/);
  assert.match(route, /Upstream redirect leaves allowed internet scope/);
  assert.doesNotMatch(route, /http:\/\/youeye-ui\.youeye/);
});
