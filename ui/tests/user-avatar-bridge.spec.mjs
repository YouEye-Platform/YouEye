import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/app/api/ui-bridge/user-avatar/route.ts", import.meta.url),
  "utf8",
);
const usersSource = readFileSync(
  new URL("../src/lib/db/queries/users.ts", import.meta.url),
  "utf8",
);
const settingsSource = readFileSync(
  new URL("../src/app/api/ui-bridge/settings/[...path]/route.ts", import.meta.url),
  "utf8",
);
const profileSource = readFileSync(
  new URL("../src/app/api/ui-bridge/user-profile/route.ts", import.meta.url),
  "utf8",
);

test("UI bridge creates a minimal profile mirror before first UI sign-in", () => {
  assert.match(usersSource, /export async function ensureBridgeUser/);
  assert.match(usersSource, /\.onConflictDoNothing\(\{ target: users\.username \}\)/);
  assert.match(source, /await ensureBridgeUser\(username\)/);
  assert.match(settingsSource, /const user = await ensureBridgeUser\(username\)/);
  assert.doesNotMatch(settingsSource, /User not found/);
  assert.match(profileSource, /await ensureBridgeUser\(username\)/);
});

test("avatar removal is idempotent for a user without a UI mirror", () => {
  assert.match(source, /A user who has not opened UI has no avatar/);
  assert.match(source, /if \(!userId\) \{[\s\S]*return NextResponse\.json\(\{ success: true \}\)/);
});
