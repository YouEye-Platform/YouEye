import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = join(import.meta.dirname, "..");

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

test("Control header drawer uses UI-sized trigger and Lucide object exports", () => {
  const header = read("src/components/control-surface/control-header.tsx");

  assert.match(header, /<DotsIcon className="h-4 w-4" \/>/);
  assert.match(header, /typeof icon === "function"/);
  assert.match(header, /\$\$typeof" in \(icon as Record<string, unknown>\)/);
  assert.match(header, /displayIcon\.startsWith\("data:"\)/);
});
