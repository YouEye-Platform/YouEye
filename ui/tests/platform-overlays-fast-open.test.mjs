import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.env.UI_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("platform overlay frames stay mounted, prewarm, and signal visibility", () => {
  const frame = read("src/components/layout/platform-overlay-frame.tsx");
  const host = read("src/components/layout/drawer-and-launcher.tsx");

  assert.match(frame, /preload/);
  assert.match(frame, /setMounted\(true\)/);
  assert.match(frame, /youeye:overlay-visibility/);
  assert.match(frame, /youeye:overlay-command/);
  assert.match(frame, /command === "open-launcher"/);
  assert.doesNotMatch(frame, /action === "open-launcher"/);
  assert.match(frame, /active && loaded/);
  assert.match(frame, /pointer-events-auto/);
  assert.match(host, /prewarm/);
  assert.match(host, /requestIdleCallback/);
  assert.match(host, /kind="drawer"[\s\S]*active=\{overlay === "drawer"\}[\s\S]*preload=\{prewarm\}/);
  assert.match(host, /kind="launcher"[\s\S]*active=\{overlay === "launcher"\}[\s\S]*preload=\{prewarm\}/);
});

test("drawer and launcher embeds never show a false empty-app state while loading", () => {
  const drawer = read("src/components/layout/app-drawer.tsx");
  const launcher = read("src/components/layout/launcher.tsx");

  assert.match(drawer, /appsLoaded/);
  assert.match(drawer, /appsError/);
  assert.match(drawer, /!appsLoaded/);
  assert.match(drawer, /youeye:overlay-visibility/);
  assert.match(launcher, /loaded/);
  assert.match(launcher, /loadError/);
  assert.match(launcher, /!loaded/);
  assert.match(launcher, /youeye:overlay-visibility/);
});

test("notification centre is prewarmed and refreshes while visible", () => {
  const bell = read("src/components/layout/notification-bell.tsx");

  assert.match(bell, /prewarm/);
  assert.match(bell, /panelActive/);
  assert.match(bell, /requestIdleCallback/);
  assert.match(bell, /preload=\{prewarm\}/);
  assert.match(bell, /onUnreadCountChange/);
  assert.match(bell, /setInterval\(fetchNotifications, 30000\)/);
});

test("overlay shells use a platform command namespace, not app-surface actions", () => {
  const shell = read("src/components/layout/embed-overlay-shell.tsx");

  assert.match(shell, /youeye:overlay-command/);
  assert.match(shell, /command: "open-launcher"/);
  assert.doesNotMatch(shell, /type: "youeye:action", action: "open-launcher"/);
});
