import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

// Plan 1 E3 — notifications: bell popover, embed-or-standard-row, attribution outside the embed.
// Run: node --test tests/notifications-e3.test.mjs
const root = process.env.UI_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('notification embed is on the ONE <UnifiedEmbed kind="notification"> (hand-rolled iframe gone)', () => {
  const e = read('src/components/notifications/notification-surface-embed.tsx');
  assert.match(e, /from "@\/components\/embeds\/unified-embed"/);
  assert.match(e, /kind="notification"/);
  assert.match(e, /timeout=\{3000\}/);            // 3s → fallback
  assert.doesNotMatch(e, /youeye-embed-ready/);   // legacy protocol removed
  assert.doesNotMatch(e, /addEventListener\("message"/);
  assert.match(e, /fallback=\{fallback\}/);        // never silent
});

test('standard fallback row exists (.std: icon tile + title + action), reused as embed fallback', () => {
  const s = read('src/components/notifications/notification-standard-row.tsx');
  assert.match(s, /h-\[30px\] w-\[30px\]/);        // 30px icon tile
  assert.match(s, /font-semibold text-foreground/); // bold title
  assert.match(s, /action\?\.url/);                 // optional action link
});

test('NotificationItem renders the .via attribution row OUTSIDE the embed + unread dot', () => {
  const i = read('src/components/notifications/notification-item.tsx');
  assert.match(i, /h-4 w-4 place-items-center rounded bg-accent/); // 16px app chip
  assert.match(i, /ml-auto/);                       // time pushed right
  assert.match(i, /!notif\.read &&/);               // unread dot
  assert.match(i, /rounded-full bg-primary/);       // blue dot
  // body: app embed when a surface exists, else the standard row
  assert.match(i, /NotificationSurfaceEmbed/);
  assert.match(i, /standardRow/);
  assert.match(i, /t\("system"\)/);                 // System notices labelled
});

test('bell trigger opens the UI-owned notification overlay using NotificationItem', () => {
  const b = read('src/components/layout/notification-bell.tsx');
  assert.match(b, /PlatformOverlayFrame/);
  assert.match(b, /kind="notifications"/);
  assert.match(b, /preload=\{prewarm\}/);
  assert.match(b, /<NotificationItem/);
  assert.match(b, /markAllRead/);
  assert.doesNotMatch(b, /typeIcon/);               // old per-type icon row gone
});

test('notifications API returns app_meta for the attribution chip (same source as timeline)', () => {
  const r = read('src/app/api/v1/notifications/route.ts');
  assert.match(r, /getAppMetaMap/);
  assert.match(r, /app_meta:/);
});

test('full /notifications page also uses NotificationItem (one implementation)', () => {
  const l = read('src/components/notifications/notifications-list.tsx');
  assert.match(l, /<NotificationItem/);
  assert.doesNotMatch(l, /const typeIcon/);
});
