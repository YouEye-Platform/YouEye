import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const uiRoot = process.env.UI_ROOT || join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(uiRoot, path), "utf8");

test("UI normalizes only explicit versioned app surface declarations", () => {
  const normalizer = read("src/lib/surfaces/normalize.ts");
  const appManagement = read("src/lib/db/queries/app-management.ts");
  const widgetsRoute = read("src/app/api/v1/apps/widgets/route.ts");
  const surfacesRoute = read("src/app/api/v1/apps/surfaces/route.ts");
  const manifestRoute = read("src/app/api/v1/apps/[appId]/manifest/route.ts");
  const timelineRoute = read("src/app/api/v1/timeline/route.ts");
  const notificationsRoute = read("src/app/api/v1/notifications/route.ts");
  const notificationItem = read("src/components/notifications/notification-item.tsx");
  const notificationsList = read("src/components/notifications/notifications-list.tsx");

  assert.match(normalizer, /export function normalizeAppSurfaces/);
  assert.match(normalizer, /SURFACE_KINDS/);
  assert.match(normalizer, /settings-panel/);
  assert.match(normalizer, /"notification"/);
  assert.doesNotMatch(normalizer, /legacyWidgetToSurface|legacyInfoCardToSurface|legacyTimelineEmbedToSurface/);
  assert.doesNotMatch(normalizer, /capabilities\.notifications|legacySource|launcher/);

  assert.match(appManagement, /getAppSurfaceDeclarations/);
  assert.match(appManagement, /normalizeAppSurfaces/);
  assert.match(appManagement, /liveManifest/);
  assert.match(appManagement, /app\.manifest/);
  assert.match(appManagement, /surfaceSchemaVersion/);
  assert.match(appManagement, /"settings-panel"/);
  assert.doesNotMatch(appManagement, /"launcher"/);
  assert.match(appManagement, /getInfoCardProviders/);
  assert.match(appManagement, /surface\.kind === "info-card"/);
  assert.match(appManagement, /endpoint: surface\.embedPath/);
  assert.match(appManagement, /timeline_cards/);
  assert.match(appManagement, /getNotificationSurfaceMap/);
  assert.match(appManagement, /item\.kind === "notification"/);

  assert.match(widgetsRoute, /getAppSurfaceDeclarations/);
  assert.match(widgetsRoute, /surface\.kind === "widget"/);
  assert.match(widgetsRoute, /surface\.placement === "dashboard"/);
  assert.match(widgetsRoute, /embed_path: w\.embedPath/);

  assert.match(surfacesRoute, /surfaces: declarations\.flatMap/);
  assert.doesNotMatch(surfacesRoute, /legacy_source|legacySource/);

  assert.match(manifestRoute, /validateBridgeAuth/);
  assert.match(manifestRoute, /X-UI-Bridge-Token/);
  assert.match(manifestRoute, /export async function POST/);
  assert.match(manifestRoute, /updateAppManifest\(appId, manifest/);

  assert.match(timelineRoute, /entriesWithSurfaceEmbeds/);
  assert.match(timelineRoute, /timeline_cards/);
  assert.match(timelineRoute, /embed_path: surface\.embed_path/);

  assert.match(notificationsRoute, /getNotificationSurfaceMap/);
  assert.match(notificationsRoute, /notification_surfaces/);
  assert.match(notificationsRoute, /surface/);
  assert.match(notificationItem, /NotificationSurfaceEmbed/);
  assert.match(notificationsList, /NotificationItem/);
});

test("normalizer source rejects launcher and legacy-only projections", () => {
  const normalizer = read("src/lib/surfaces/normalize.ts");
  assert.match(normalizer, /SURFACE_KINDS\.has\(kind\)/);
  assert.match(normalizer, /SURFACE_PLACEMENTS\.has\(placement\)/);
  assert.match(normalizer, /Array\.isArray\(manifest\.surfaces\)/);
  assert.doesNotMatch(normalizer, /manifest\.widgets|manifest\.info_cards|manifest\.timeline_embeds|capabilities\.notifications/);
});

test("canonical notification surfaces are explicit only", () => {
  const appManagement = read("src/lib/db/queries/app-management.ts");
  assert.match(appManagement, /item\.kind === "notification"/);
  assert.match(appManagement, /item\.placement === "notification-center"/);
  assert.doesNotMatch(appManagement, /default-notification|capabilities\.notifications/);
});
