import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const uiRoot = process.env.UI_ROOT || join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(uiRoot, path), "utf8");
const exists = (path) => existsSync(join(uiRoot, path));

test("timeline info cards render app-declared surfaces through UnifiedEmbed", () => {
  const timelineInfoCard = read("src/components/timeline/timeline-info-card.tsx");
  const deriveTarget = read("src/lib/timeline/derive-info-card-url.ts");

  assert.match(timelineInfoCard, /import \{ UnifiedEmbed \}/);
  assert.match(timelineInfoCard, /kind="info-card"/);
  assert.match(timelineInfoCard, /fetch\("\/api\/v1\/apps\/surfaces"\)/);
  assert.match(timelineInfoCard, /surface\.kind === "info-card"/);
  assert.match(timelineInfoCard, /new URL\(match\.surface\.embed_path, match\.surface\.app_url\)/);
  assert.match(timelineInfoCard, /url\.searchParams\.set\("url", match\.targetUrl\)/);

  assert.match(deriveTarget, /deriveInfoCardTargetUrl/);
  assert.match(deriveTarget, /https:\/\/en\.wikipedia\.org\/wiki/);
  assert.doesNotMatch(deriveTarget, /\/api\/cards|\/api\/inter-app\/provide/);
});

test("host-side JSON info-card route and renderer are removed", () => {
  const middleware = read("src/middleware.ts");
  assert.equal(exists("src/app/api/v1/apps/info-card/route.ts"), false);
  assert.equal(exists("src/app/api/v1/apps/info-cards/route.ts"), false);
  assert.equal(exists("src/components/info-cards/use-info-card.ts"), false);
  assert.equal(exists("src/components/info-cards/info-card.tsx"), false);
  assert.doesNotMatch(middleware, /\/api\/v1\/apps\/info-card"/);
});

test("the unified surfaces endpoint carries info-card provider fields", () => {
  const surfacesRoute = read("src/app/api/v1/apps/surfaces/route.ts");
  assert.match(surfacesRoute, /app_url: publicAppUrl/);
  assert.match(surfacesRoute, /surface_id: surface\.id/);
  assert.match(surfacesRoute, /embed_path: surface\.embedPath/);
  assert.match(surfacesRoute, /triggers: surface\.triggers/);
});
