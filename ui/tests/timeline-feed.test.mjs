import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

// Plan 1 E2 — timeline is an embeds-first, single centered column, date-grouped feed.
// Run: node --test tests/timeline-feed.test.mjs
const root = process.env.UI_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('page is a single centered column (max 640) per the mockup', () => {
  const p = read('src/app/timeline/page.tsx');
  assert.match(p, /max-w-\[640px\]/);
  assert.doesNotMatch(p, /max-w-4xl/);
});

test('feed groups entries by day (Today / Yesterday / date) in one pass', () => {
  const f = read('src/components/timeline/timeline-feed.tsx');
  assert.match(f, /buildDayGroups/);
  assert.match(f, /toDateString\(\)/);          // day key
  assert.match(f, /t\("dayToday"\)/);           // Today label
  assert.match(f, /t\("yesterday"\)/);          // Yesterday label
  assert.match(f, /toLocaleDateString\(locale/); // older dates, locale-aware
});

test('feed renders a .day divider for day items and the entry card otherwise', () => {
  const f = read('src/components/timeline/timeline-feed.tsx');
  assert.match(f, /item\.type === "day"/);
  assert.match(f, /uppercase tracking-wider/);  // day label styling
});

test('entry card renders an attribution (.via) row OUTSIDE the embed (anti-impersonation)', () => {
  const c = read('src/components/timeline/timeline-entry-card.tsx');
  // 18px app chip + app name + clock time, all UI-rendered above the body
  assert.match(c, /h-\[18px\] w-\[18px\]/);
  assert.match(c, /toLocaleTimeString/);
  assert.match(c, /<time/);
  // delete affordance lives on the row (hover-revealed)
  assert.match(c, /deleteEntry/);
});

test('entry card body is the embed / unified info-card / StandardCard — old chrome dropped', () => {
  const c = read('src/components/timeline/timeline-entry-card.tsx');
  const i = read('src/components/timeline/timeline-info-card.tsx');
  assert.match(c, /<TimelineEmbed/);
  assert.match(c, /<TimelineInfoCard/);
  assert.match(i, /kind="info-card"/);
  assert.match(i, /\/api\/v1\/apps\/info-cards/);
  assert.doesNotMatch(i, /useInfoCard|\/api\/v1\/apps\/info-card"/);
  // the old bordered-chrome card, collection badge, and raw-JSON expander are gone
  assert.doesNotMatch(c, /COLLECTION_COLORS/);
  assert.doesNotMatch(c, /COLLECTION_LABELS/);
  assert.doesNotMatch(c, /JSON\.stringify/);
  assert.doesNotMatch(c, /ChevronDown/);
});

test('clock-time attribution replaces the old relative "today at {time}" in the row', () => {
  const c = read('src/components/timeline/timeline-entry-card.tsx');
  // the card uses a bare clock time now; relative formatting moved to the day header
  assert.doesNotMatch(c, /formatTimestamp/);
});
