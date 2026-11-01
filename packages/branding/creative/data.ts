import {
  applyPreset,
  compatibleFonts,
  fitDesign,
  palettes,
  presets,
  type Design,
} from "../lib/design";
import {
  applyIconStyle,
  iconPalette,
  iconStyles,
  symbolGroups,
} from "../lib/icon-styles";
import icons from "../lib/icons.json";
import type { BrandingMessageKey, BrandingTranslator } from "../messages";
import { symbolLabel } from "../labels";
export type Kind = "title" | "icon";
export const experiments = [
  {
    id: "vibe",
    titleKey: "experiment.vibe.title",
    iconKey: "experiment.vibe.icon",
    titleLineKey: "experiment.vibe.titleLine",
    iconLineKey: "experiment.vibe.iconLine",
    colour: "#e8a2d1",
    glyph: "✳",
    source: "Adobe Express + Canva",
    titleActionKey: "experiment.vibe.titleAction",
    iconActionKey: "experiment.vibe.iconAction",
  },
  {
    id: "remix",
    titleKey: "experiment.remix.title",
    iconKey: "experiment.remix.icon",
    titleLineKey: "experiment.remix.titleLine",
    iconLineKey: "experiment.remix.iconLine",
    colour: "#b9c7fa",
    glyph: "↻",
    source: "Fontjoy + Coolors + Haikei",
    titleActionKey: "experiment.remix.titleAction",
    iconActionKey: "experiment.remix.iconAction",
  },
  {
    id: "workshop",
    titleKey: "experiment.workshop.title",
    iconKey: "experiment.workshop.icon",
    titleLineKey: "experiment.workshop.titleLine",
    iconLineKey: "experiment.workshop.iconLine",
    colour: "#f6c17d",
    glyph: "▧",
    source: "Figma + LogoFast",
    titleActionKey: "experiment.workshop.titleAction",
    iconActionKey: "experiment.workshop.iconAction",
  },
  {
    id: "discover",
    titleKey: "experiment.discover.title",
    iconKey: "experiment.discover.icon",
    titleLineKey: "experiment.discover.titleLine",
    iconLineKey: "experiment.discover.iconLine",
    colour: "#c9dba1",
    glyph: "↗",
    source: "NN/g recognition guidance + visual catalogues",
    titleActionKey: "experiment.discover.titleAction",
    iconActionKey: "experiment.discover.iconAction",
  },
  {
    id: "world",
    titleKey: "experiment.world.title",
    iconKey: "experiment.world.icon",
    titleLineKey: "experiment.world.titleLine",
    iconLineKey: "experiment.world.iconLine",
    colour: "#9fd9d4",
    glyph: "◉",
    source: "IconKitchen + Figma",
    titleActionKey: "experiment.world.titleAction",
    iconActionKey: "experiment.world.iconAction",
  },
] as const;
export type Experiment = (typeof experiments)[number]["id"];
export const moods = [
  {
    nameKey: "mood.softSunny.name",
    hintKey: "mood.softSunny.hint",
    glyph: "☀",
    preset: 5,
    colours: [1, 4, 9, 14],
    fonts: [
      "fredoka",
      "comfortaa",
      "quicksand",
      "caveat",
      "pacifico",
      "righteous",
    ],
  },
  {
    nameKey: "mood.afterDark.name",
    hintKey: "mood.afterDark.hint",
    glyph: "✦",
    preset: 12,
    colours: [6, 2, 3, 5],
    fonts: [
      "audiowide",
      "orbitron",
      "bungee",
      "righteous",
      "unbounded",
      "russoone",
    ],
  },
  {
    nameKey: "mood.goodOldDays.name",
    hintKey: "mood.goodOldDays.hint",
    glyph: "◒",
    preset: 55,
    colours: [7, 1, 9, 0],
    fonts: [
      "lobster",
      "abrilfatface",
      "specialelite",
      "alfaslabone",
      "yesevaone",
      "bangers",
    ],
  },
  {
    nameKey: "mood.loudProud.name",
    hintKey: "mood.loudProud.hint",
    glyph: "↗",
    preset: 43,
    colours: [8, 6, 9, 2],
    fonts: [
      "bungee",
      "archivoblack",
      "luckiestguy",
      "rubikmonoone",
      "bangers",
      "blackopsone",
    ],
  },
  {
    nameKey: "mood.woods.name",
    hintKey: "mood.woods.hint",
    glyph: "❋",
    preset: 35,
    colours: [0, 7, 10, 3],
    fonts: [
      "dmserifdisplay",
      "vollkorn",
      "philosopher",
      "caveat",
      "amaticsc",
      "notoserif",
    ],
  },
  {
    nameKey: "mood.cleanSlate.name",
    hintKey: "mood.cleanSlate.hint",
    glyph: "○",
    preset: 4,
    colours: [5, 3, 0, 2],
    fonts: [
      "spacegrotesk",
      "montserrat",
      "rubik",
      "notosans",
      "quicksand",
      "oswald",
    ],
  },
] satisfies {
  nameKey: BrandingMessageKey;
  hintKey: BrandingMessageKey;
  glyph: string;
  preset: number;
  colours: number[];
  fonts: string[];
}[];
export const effects: [Design["effect"], BrandingMessageKey][] = [
  ["flat", "effect.flat"],
  ["shadow", "effect.shadow"],
  ["extrude", "effect.extrude"],
  ["outline", "effect.outline"],
  ["neon", "effect.neon"],
  ["chrome", "effect.chrome"],
  ["sticker", "effect.sticker"],
  ["echo", "effect.echo"],
  ["glitch", "effect.glitch"],
  ["halftone", "effect.halftone"],
];
export const shapeNames: [Design["shape"], BrandingMessageKey][] = [
  ["straight", "shape.straight"],
  ["arch", "shape.arch"],
  ["wave", "shape.wave"],
  ["rise", "shape.rise"],
  ["bulge", "shape.bulge"],
  ["slant", "shape.slant"],
];
export const pets = [
  "cat",
  "dog",
  "rabbit",
  "bird",
  "butterfly",
  "fish",
  "ghost",
  "robot",
  "alien",
  "smiley",
  "paw-print",
  "planet",
].filter((s) => s in icons);
export const allSymbols = Object.keys(icons);
export const favourites = symbolGroups.Favourites.filter((s) => s in icons);
export const worlds = {
  "world.forYou": favourites,
  "world.wildThings": pets,
  "world.outside": symbolGroups.Nature,
  "world.playTime": symbolGroups.Play,
  "world.home": symbolGroups.Home,
} satisfies Partial<Record<BrandingMessageKey, string[]>>;
export function paint(d: Design, kind: Kind, p: string[]): Design {
  if (kind === "icon") return { ...d, icon: { ...d.icon, ...iconPalette(p) } };
  const [, ink, secondary, darkInk] = p;
  return {
    ...d,
    light: { ...d.light, ink, secondary },
    dark: { ...d.dark, ink: darkInk, secondary },
  };
}
export function finish(d: Design, effect: Design["effect"]): Design {
  return {
    ...d,
    effect,
    outline:
      effect === "sticker"
        ? 4
        : effect === "outline"
          ? Math.max(2, d.outline)
          : d.outline,
    depth: Math.max(6, d.depth),
  };
}
export function moodDesign(d: Design, index: number): Design {
  const next = applyPreset(presets[moods[index].preset], d);
  const available = compatibleFonts(
    next.uppercase ? next.name.toUpperCase() : next.name,
  );
  const preferred = moods[index].fonts.find((id) =>
    available.some(([font]) => font === id),
  );
  return {
    ...next,
    font:
      available.find(([id]) => id === preferred)?.[0] ??
      available[0]?.[0] ??
      next.font,
  };
}
export function titleCandidates(d: Design, mood: number) {
  const available = compatibleFonts(
    d.uppercase ? d.name.toUpperCase() : d.name,
  );
  const picks = available.filter(([id]) => moods[mood].fonts.includes(id));
  return [...picks, ...available.filter((f) => !picks.includes(f))].slice(0, 6);
}
export type Locks = { identity: boolean; finish: boolean; colour: boolean };
export function remix(
  d: Design,
  kind: Kind,
  locks: Locks,
  random = Math.random,
): Design {
  const choose = <T>(list: readonly T[]) =>
    list[Math.floor(random() * list.length) % list.length];
  let next = structuredClone(d);
  if (kind === "title") {
    if (!locks.identity) {
      const f = compatibleFonts(
        d.uppercase ? d.name.toUpperCase() : d.name,
      ).filter(([id]) => id !== d.font);
      if (f.length) next.font = choose(f)[0];
    }
    if (!locks.finish) {
      next = finish(next, choose(effects.filter(([id]) => id !== d.effect))[0]);
      next.shape = choose(shapeNames)[0];
      next.amount = 35;
    }
  } else {
    if (!locks.identity)
      next.icon = {
        ...next.icon,
        mode: "symbol",
        symbol: choose(favourites.filter((s) => s !== d.icon.symbol)),
      };
    if (!locks.finish) {
      const s = choose(
        iconStyles.filter((s) => s.icon.finish !== d.icon.finish),
      );
      const styled = applyIconStyle(next.icon, s);
      next.icon = {
        ...next.icon,
        shape: styled.shape,
        finish: styled.finish,
        pattern: styled.pattern,
        gradient: styled.gradient,
        border: styled.border,
      };
    }
  }
  if (!locks.colour)
    next = paint(
      next,
      kind,
      choose(
        palettes.filter(
          (p) => p[1] !== (kind === "title" ? d.light.ink : d.icon.foreground),
        ),
      ),
    );
  return fitDesign(next);
}
export function candidate(d: Design, index: number): Design {
  return applyPreset(presets[(index * 7 + 10) % presets.length], d);
}
export function withSymbol(d: Design, symbol: string): Design {
  return { ...d, icon: { ...d.icon, mode: "symbol", symbol } };
}
export function namedSymbol(d: Design, t: BrandingTranslator) {
  return d.icon.mode === "symbol"
    ? symbolLabel(t, d.icon.symbol)
    : d.icon.mode === "monogram"
      ? d.icon.letters || Array.from(d.name.trim())[0] || t("mark.initialsFallback")
      : d.icon.mode === "emoji"
        ? d.icon.emoji
        : t("mark.imageFallback");
}
