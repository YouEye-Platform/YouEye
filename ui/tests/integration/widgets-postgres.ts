import assert from "node:assert/strict";
import { getUserWidgets, saveUserWidgets } from "../../src/lib/db/queries/widgets";
import { cleanup } from "./widgets-db";

async function main() {
  const owner = crypto.randomUUID();
  const other = crypto.randomUUID();
  const layout = [{ widgetType: "greeting", positionX: 30, positionY: 32, width: 35, height: 8, settings: { greetingPreset: "terminal" } }];
  try {
    const saved = await saveUserWidgets(owner, layout);
    const separate = await saveUserWidgets(other, layout);
    for (const invalid of [undefined, {}, null, [null], [{ ...layout[0], width: "35" }], [{ ...layout[0], settings: [] }], [{ ...layout[0], height: NaN }]]) {
      await assert.rejects(saveUserWidgets(owner, invalid as never));
      assert.deepEqual(await getUserWidgets(owner), saved);
    }
    console.log("PASS malformed layouts preserve saved rows and IDs");
    await assert.rejects(saveUserWidgets(owner, [{ ...layout[0], width: -1 }]));
    assert.deepEqual(await getUserWidgets(owner), saved);
    console.log("PASS database insertion failure rolls back deletion");
    const first = [{ ...layout[0], settings: { greetingPreset: "first" } }];
    const second = [{ ...layout[0], settings: { greetingPreset: "second" } }];
    await Promise.all([saveUserWidgets(owner, first), saveUserWidgets(owner, second)]);
    const current = await getUserWidgets(owner);
    assert.equal(current.length, 1);
    assert.ok(["first", "second"].includes(current[0].settings.greetingPreset as string));
    assert.deepEqual(await getUserWidgets(other), separate);
    console.log("PASS concurrent replacements remain complete and account scoped");
    assert.deepEqual(await saveUserWidgets(owner, []), []);
    console.log("PASS explicit empty layout remains supported");
  } finally {
    await cleanup();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
