import test from "node:test";
import assert from "node:assert/strict";
import { validateStudioStyle } from "../src/lib/studio-style";
import { defaultDesign } from "../../packages/branding/lib/design";
const DEFAULT_STYLE = { fontFamily: "Inter", fontSize: "1.5rem", fontWeight: 700, letterSpacing: "0em", color: "#111111", gradient: null, textShadow: "none", textTransform: "none" };

test("account and app editing preserves CSS-only fields and validates MyTitle designs", () => {
  const cssOnly = { ...DEFAULT_STYLE, color: "#123456" };
  assert.equal(validateStudioStyle(cssOnly), cssOnly);
  const style = validateStudioStyle({ ...cssOnly, mytitle: defaultDesign });
  assert.equal(style.color, cssOnly.color);
  assert.deepEqual(style.mytitle, defaultDesign);
  for (const bad of [{ ...defaultDesign, version: 99 }, { ...defaultDesign, icon: { ...defaultDesign.icon, image: 'https://invalid.example/image.svg' } }]) {
    assert.throws(() => validateStudioStyle({ ...cssOnly, mytitle: bad } as never));
  }
});
