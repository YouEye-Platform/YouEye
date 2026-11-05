import assert from "node:assert/strict";
import test from "node:test";
import { classifyGridPointer } from "../src/lib/hooks/grid-drag-geometry.mjs";

const rects = [
  { id: "app-a", left: 0, right: 100, top: 0, bottom: 100, width: 100, height: 100 },
  { id: "app-b", left: 120, right: 220, top: 0, bottom: 100, width: 100, height: 100 },
];
const order = ["dragged", "app-a", "app-b"];

test("a central app overlap is a folder merge, never a reorder", () => {
  assert.deepEqual(
    classifyGridPointer("dragged", 50, 50, rects, order, () => true),
    { kind: "merge", targetId: "app-a" },
  );
});

test("the narrow edge of a tile remains a reorder target", () => {
  assert.deepEqual(
    classifyGridPointer("dragged", 4, 50, rects, order, () => true),
    { kind: "reorder", targetId: "app-a", toIndex: 1 },
  );
});

test("a folder tile being dragged cannot merge but can reorder", () => {
  assert.deepEqual(
    classifyGridPointer("folder", 170, 50, rects, ["folder", ...order], () => false),
    { kind: "reorder", targetId: "app-b", toIndex: 3 },
  );
});

test("empty grid space and the dragged tile itself have no drop action", () => {
  assert.deepEqual(classifyGridPointer("dragged", 300, 300, rects, order, () => true), { kind: "none" });
  assert.deepEqual(
    classifyGridPointer("app-a", 50, 50, rects, ["app-a", "app-b"], () => true),
    { kind: "none" },
  );
});
