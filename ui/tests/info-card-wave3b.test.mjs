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
  assert.match(timelineInfoCard, /fetch\("\/api\/v1\/apps\/info-cards"\)/);
  assert.match(timelineInfoCard, /new URL\(match\.card\.embed_path, match\.provider\.app_url\)/);
  assert.match(timelineInfoCard, /url\.searchParams\.set\("url", match\.targetUrl\)/);

  assert.match(deriveTarget, /deriveInfoCardTargetUrl/);
  assert.match(deriveTarget, /https:\/\/en\.wikipedia\.org\/wiki/);
  assert.doesNotMatch(deriveTarget, /\/api\/cards|\/api\/inter-app\/provide/);
});

test("host-side JSON info-card route and renderer are removed", () => {
  const middleware = read("src/middleware.ts");
  assert.equal(exists("src/app/api/v1/apps/info-card/route.ts"), false);
  assert.equal(exists("src/components/info-cards/use-info-card.ts"), false);
  assert.equal(exists("src/components/info-cards/info-card.tsx"), false);
  assert.doesNotMatch(middleware, /\/api\/v1\/apps\/info-card"/);
});

test("plural provider list remains live for Search/link-handler consumers", () => {
  const providerRoute = read("src/app/api/v1/apps/info-cards/route.ts");
  assert.match(providerRoute, /getInfoCardProviders/);
  assert.match(providerRoute, /app_url/);
  assert.match(providerRoute, /embed_path/);
});
