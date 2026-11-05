import {
  compatibleFonts,
  defaultDesign,
  fitDesign,
  palettes,
  type Design,
} from "../lib/design";
import { effects, finish, paint, type Locks } from "./data";

import { pick, randomName } from "./server-names";
export { serverNames, randomName } from "./server-names";
export const titleStyles = [
  ...effects.map(([effect, labelKey]) => ({
    id: effect,
    labelKey,
    effect,
    shape: "straight" as Design["shape"],
  })),
  {
    id: "wave",
    labelKey: "shape.wave" as const,
    effect: "extrude" as const,
    shape: "wave" as const,
  },
  {
    id: "arch",
    labelKey: "shape.arch" as const,
    effect: "echo" as const,
    shape: "arch" as const,
  },
  {
    id: "slant",
    labelKey: "shape.rise" as const,
    effect: "sticker" as const,
    shape: "slant" as const,
  },
];
export function applyTitleStyle(d: Design, index: number): Design {
  const s = titleStyles[index];
  return {
    ...finish(d, s.effect),
    ...(s.effect === "outline" ? { outline: 6 } : {}),
    shape: s.shape,
    amount: 35,
  };
}
export function styleIndex(d: Design) {
  return titleStyles.findIndex(
    (s) => s.effect === d.effect && s.shape === d.shape,
  );
}
export function paletteIndex(d: Design) {
  return palettes.findIndex(
    (p) =>
      p[1] === d.light.ink && p[2] === d.light.secondary && p[3] === d.dark.ink,
  );
}
export function shuffleTitle(
  d: Design,
  locks: Locks,
  random = Math.random,
): Design {
  let next = structuredClone(d);
  if (!locks.identity) {
    const fonts = compatibleFonts(
      d.uppercase ? d.name.toUpperCase() : d.name,
    ).filter(([id]) => id !== d.font);
    if (fonts.length) next.font = pick(fonts, random)[0];
  }
  if (!locks.colour)
    next = paint(
      next,
      "title",
      pick(
        palettes.filter((_, i) => i !== paletteIndex(d)),
        random,
      ),
    );
  if (!locks.finish)
    next = applyTitleStyle(
      next,
      pick(
        titleStyles.map((_, i) => i).filter((i) => i !== styleIndex(d)),
        random,
      ),
    );
  return fitDesign(next);
}
export function createStarter(random = Math.random): Design {
  const base = structuredClone(defaultDesign);
  base.name = randomName("", random);
  base.icon = { ...base.icon, mode: "monogram", letters: "", rotation: 0 };
  base.light.surface = "#faf9f5";
  base.dark.surface = "#202126";
  base.font = pick(compatibleFonts(base.name), random)[0];
  return fitDesign(
    applyTitleStyle(
      paint(base, "title", pick(palettes, random)),
      pick(
        titleStyles.map((_, i) => i),
        random,
      ),
    ),
  );
}
