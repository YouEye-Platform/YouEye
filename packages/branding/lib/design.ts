import { z } from "zod";
import { supportsText } from "./coverage";
import icons from "./icons.json";
const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const paintSchema = z.object({
  ink: colour,
  secondary: colour,
  outline: colour,
  shadow: colour,
  surface: colour,
}).strict();
/** Data URLs must contain the declared raster signature, never disguised markup. */
function rasterData(value: string): boolean {
  if (value === "") return true;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) return false;
  try {
    const bytes = atob(match[2]);
    if (match[1] === "png") return bytes.startsWith("\x89PNG\r\n\x1a\n");
    if (match[1] === "jpeg") return bytes.startsWith("\xff\xd8\xff");
    return bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
  } catch { return false; }
}

export const designSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(64),
  font: z.enum([
    "bungee",
    "pacifico",
    "monoton",
    "pressstart2p",
    "righteous",
    "abrilfatface",
    "blackopsone",
    "permanentmarker",
    "lobster",
    "audiowide",
    "creepster",
    "dmserifdisplay",
    "spacegrotesk",
    "caveat",
    "comfortaa",
    "oswald",
    "montserrat",
    "orbitron",
    "fredoka",
    "playfairdisplay",
    "dancingscript",
    "cinzel",
    "quicksand",
    "archivoblack",
    "russoone",
    "satisfy",
    "greatvibes",
    "bangers",
    "bebasneue",
    "alfaslabone",
    "rubikmonoone",
    "rubikglitch",
    "rubikmoonrocks",
    "luckiestguy",
    "vt323",
    "specialelite",
    "notosans",
    "notoserif",
    "rubik",
    "unbounded",
    "yesevaone",
    "marckscript",
    "badscript",
    "amaticsc",
    "philosopher",
    "vollkorn",
    "zenmarugothic",
    "mashanzheng",
    "gaegu",
  ]),
  family: z.string().max(30),
  effect: z.enum([
    "flat",
    "shadow",
    "extrude",
    "outline",
    "neon",
    "chrome",
    "sticker",
    "echo",
    "glitch",
    "halftone",
  ]),
  shape: z.enum(["straight", "arch", "wave", "rise", "bulge", "slant"]),
  amount: z.number().min(0).max(100),
  tracking: z.number().min(-5).max(20),
  width: z.number().min(60).max(140),
  outline: z.number().min(0).max(8),
  depth: z.number().min(0).max(24),
  gradient: z.boolean(),
  angle: z.number().min(0).max(360),
  uppercase: z.boolean(),
  layout: z.enum(["title", "beside", "stacked", "badge"]),
  light: paintSchema,
  dark: paintSchema,
  linked: z.boolean(),
  icon: z.object({
    mode: z.enum(["symbol", "monogram", "emoji", "upload"]),
    symbol: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .max(80)
      .refine((id) => Object.hasOwn(icons, id), "Unknown symbol"),
    letters: z.string().max(6),
    emoji: z.string().max(32),
    image: z
      .string()
      .max(3000000)
      .refine(
        rasterData,
        "Use a PNG, JPEG or WebP image",
      ),
    shape: z.enum([
      "rounded",
      "circle",
      "square",
      "squircle",
      "diamond",
      "hexagon",
    ]),
    scale: z.number().min(30).max(92),
    rotation: z.number().min(-180).max(180),
    x: z.number().min(-20).max(20),
    y: z.number().min(-20).max(20),
    background: colour,
    backgroundDark: colour,
    foreground: colour,
    foregroundDark: colour,
    gradient: z.boolean(),
    border: z.number().min(0).max(8),
    radius: z.number().min(0).max(50),
    match: z.boolean(),
    transparent: z.boolean(),
    finish: z
      .enum(["plain", "raised", "glass", "neon", "sticker", "stamp"])
      .default("plain"),
    pattern: z
      .enum(["none", "dots", "rays", "grid", "waves", "orbit"])
      .default("none"),
    accent: colour.default("#a9ba7a"),
    accentDark: colour.default("#88af8e"),
    gradientAngle: z.number().min(0).max(360).default(135),
  }).strict(),
}).strict();
export type Design = z.infer<typeof designSchema>;
export type Paint = z.infer<typeof paintSchema>;
export type Theme = "light" | "dark";
export type View = "logo" | "title" | "icon";
export const fonts = [
  ["bungee", "Bungee", "Block"],
  ["pacifico", "Pacifico", "Script"],
  ["monoton", "Monoton", "Display"],
  ["pressstart2p", "Press Start 2P", "Pixel"],
  ["righteous", "Righteous", "Rounded"],
  ["abrilfatface", "Abril Fatface", "Editorial"],
  ["blackopsone", "Black Ops One", "Stencil"],
  ["permanentmarker", "Permanent Marker", "Brush"],
  ["lobster", "Lobster", "Script"],
  ["audiowide", "Audiowide", "Tech"],
  ["creepster", "Creepster", "Spooky"],
  ["dmserifdisplay", "DM Serif Display", "Serif"],
  ["spacegrotesk", "Space Grotesk", "Clean"],
  ["caveat", "Caveat", "Handwritten"],
  ["comfortaa", "Comfortaa", "Rounded"],
  ["oswald", "Oswald", "Condensed"],
  ["montserrat", "Montserrat", "Modern"],
  ["orbitron", "Orbitron", "Sci-fi"],
  ["fredoka", "Fredoka", "Playful"],
  ["playfairdisplay", "Playfair Display", "Editorial"],
  ["dancingscript", "Dancing Script", "Script"],
  ["cinzel", "Cinzel", "Classical"],
  ["quicksand", "Quicksand", "Rounded"],
  ["archivoblack", "Archivo Black", "Bold"],
  ["russoone", "Russo One", "Industrial"],
  ["satisfy", "Satisfy", "Brush"],
  ["greatvibes", "Great Vibes", "Calligraphy"],
  ["bangers", "Bangers", "Comic"],
  ["bebasneue", "Bebas Neue", "Condensed"],
  ["alfaslabone", "Alfa Slab One", "Slab"],
  ["rubikmonoone", "Rubik Mono One", "Block"],
  ["rubikglitch", "Rubik Glitch", "Distressed"],
  ["rubikmoonrocks", "Rubik Moonrocks", "Textured"],
  ["luckiestguy", "Luckiest Guy", "Cartoon"],
  ["vt323", "VT323", "Terminal"],
  ["specialelite", "Special Elite", "Typewriter"],
  ["notosans", "Noto Sans", "Multilingual"],
  ["notoserif", "Noto Serif", "Multilingual"],
  ["rubik", "Rubik", "Rounded"],
  ["unbounded", "Unbounded", "Wide"],
  ["yesevaone", "Yeseva One", "Display"],
  ["marckscript", "Marck Script", "Handwritten"],
  ["badscript", "Bad Script", "Handwritten"],
  ["amaticsc", "Amatic SC", "Handwritten"],
  ["philosopher", "Philosopher", "Serif"],
  ["vollkorn", "Vollkorn", "Editorial"],
  ["zenmarugothic", "Zen Maru Gothic", "Japanese"],
  ["mashanzheng", "Ma Shan Zheng", "Chinese"],
  ["gaegu", "Gaegu", "Korean"],
] as const;
export const defaultDesign: Design = {
  version: 1,
  name: "Moonbase",
  font: "righteous",
  family: "Orbital",
  effect: "flat",
  shape: "straight",
  amount: 35,
  tracking: 0,
  width: 100,
  outline: 0,
  depth: 6,
  gradient: false,
  angle: 25,
  uppercase: false,
  layout: "beside",
  light: {
    ink: "#344f41",
    secondary: "#9ba678",
    outline: "#fbfaf1",
    shadow: "#b7c6a0",
    surface: "#efefdf",
  },
  dark: {
    ink: "#d7e8bd",
    secondary: "#a4c2a0",
    outline: "#1b2e27",
    shadow: "#101d18",
    surface: "#1b2c25",
  },
  linked: true,
  icon: {
    mode: "symbol",
    symbol: "planet",
    letters: "M",
    emoji: "🪐",
    image: "",
    shape: "rounded",
    scale: 68,
    rotation: -10,
    x: 0,
    y: 0,
    background: "#d4dfb5",
    backgroundDark: "#344e3c",
    foreground: "#344f41",
    foregroundDark: "#d7e8bd",
    gradient: false,
    border: 0,
    radius: 28,
    match: true,
    transparent: false,
    finish: "plain",
    pattern: "none",
    accent: "#a9ba7a",
    accentDark: "#88af8e",
    gradientAngle: 135,
  },
};
export const families = [
  "All looks",
  "Orbital",
  "Soft serve",
  "After hours",
  "Sunday paper",
  "Arcade club",
  "Made by hand",
  "Chrome lab",
  "Field notes",
  "Super sticker",
  "Signal",
  "Wild things",
  "Old school",
];
type Family = {
  name: string;
  font: Design["font"];
  effect: Design["effect"];
  shape: Design["shape"];
  icon: string;
  ink: string;
  second: string;
  surface: string;
  dark: string;
  layout: Design["layout"];
};
const seeds: Family[] = [
  {
    name: "Orbital",
    font: "righteous",
    effect: "flat",
    shape: "straight",
    icon: "planet",
    ink: "#344f41",
    second: "#a9ba7a",
    surface: "#eff0df",
    dark: "#d7e8bd",
    layout: "beside",
  },
  {
    name: "Soft serve",
    font: "comfortaa",
    effect: "extrude",
    shape: "arch",
    icon: "flower-tulip",
    ink: "#ae4b66",
    second: "#ffc4b5",
    surface: "#fae5df",
    dark: "#ffd4df",
    layout: "stacked",
  },
  {
    name: "After hours",
    font: "monoton",
    effect: "neon",
    shape: "straight",
    icon: "lightning",
    ink: "#803eb3",
    second: "#d25da8",
    surface: "#f4e7fa",
    dark: "#e2a4ff",
    layout: "beside",
  },
  {
    name: "Sunday paper",
    font: "abrilfatface",
    effect: "flat",
    shape: "straight",
    icon: "sun",
    ink: "#39372d",
    second: "#9c6a36",
    surface: "#f5efdf",
    dark: "#f2dfb5",
    layout: "title",
  },
  {
    name: "Arcade club",
    font: "pressstart2p",
    effect: "shadow",
    shape: "rise",
    icon: "game-controller",
    ink: "#443798",
    second: "#cd6b4b",
    surface: "#eae6ff",
    dark: "#bfb5ff",
    layout: "beside",
  },
  {
    name: "Made by hand",
    font: "permanentmarker",
    effect: "flat",
    shape: "slant",
    icon: "sparkle",
    ink: "#285d91",
    second: "#e56c35",
    surface: "#e3ecf2",
    dark: "#acd7ff",
    layout: "stacked",
  },
  {
    name: "Chrome lab",
    font: "audiowide",
    effect: "chrome",
    shape: "slant",
    icon: "diamonds-four",
    ink: "#314757",
    second: "#f0f8ff",
    surface: "#e7edef",
    dark: "#bfd9ed",
    layout: "beside",
  },
  {
    name: "Field notes",
    font: "dmserifdisplay",
    effect: "flat",
    shape: "arch",
    icon: "mountains",
    ink: "#4d613b",
    second: "#a48c46",
    surface: "#eef0e1",
    dark: "#d1e0b0",
    layout: "badge",
  },
  {
    name: "Super sticker",
    font: "bungee",
    effect: "sticker",
    shape: "wave",
    icon: "smiley",
    ink: "#e46b32",
    second: "#ffc68f",
    surface: "#fff0dd",
    dark: "#ffb47d",
    layout: "beside",
  },
  {
    name: "Signal",
    font: "oswald",
    effect: "glitch",
    shape: "straight",
    icon: "broadcast",
    ink: "#255d68",
    second: "#e07575",
    surface: "#e3f1ef",
    dark: "#8fe5de",
    layout: "beside",
  },
  {
    name: "Wild things",
    font: "creepster",
    effect: "outline",
    shape: "bulge",
    icon: "cat",
    ink: "#5d4e8f",
    second: "#a4bb64",
    surface: "#ede6f5",
    dark: "#d0b9ff",
    layout: "stacked",
  },
  {
    name: "Old school",
    font: "lobster",
    effect: "echo",
    shape: "rise",
    icon: "vinyl-record",
    ink: "#a84838",
    second: "#dfaa66",
    surface: "#f5e9cf",
    dark: "#ffbd8d",
    layout: "title",
  },
];
export type Preset = {
  id: string;
  label: string;
  family: string;
  design: Design;
};
const variants = ["Original", "Daydream", "Midnight", "Playful", "Quiet"];
export const presets: Preset[] = seeds.flatMap((s, i) =>
  variants.map((v, j) => {
    const d = structuredClone(defaultDesign);
    Object.assign(d, {
      font: s.font,
      family: s.name,
      effect: s.effect,
      shape: s.shape,
      layout: s.layout,
      gradient: j === 1,
      amount: j === 3 ? 65 : 28,
      tracking: j === 4 ? 4 : 0,
      depth: j === 3 ? 12 : 6,
      outline: s.effect === "sticker" ? 4 : s.effect === "outline" ? 2 : 0,
    });
    d.light = {
      ink: s.ink,
      secondary: s.second,
      surface: s.surface,
      outline: "#fffaf0",
      shadow: s.second,
    };
    d.dark = {
      ink: s.dark,
      secondary: s.second,
      surface: "#20232a",
      outline: "#151922",
      shadow: "#080a10",
    };
    d.icon = {
      ...d.icon,
      symbol: s.icon,
      background: s.second,
      backgroundDark: "#303a39",
      shape: j === 1 ? "circle" : j === 3 ? "diamond" : "rounded",
      rotation: j === 3 ? -12 : 0,
    };
    if (j === 2) {
      d.gradient = true;
      d.effect = i === 2 ? "neon" : s.effect;
      d.light.surface = "#e0e4ed";
    }
    if (j === 4) {
      d.effect = "flat";
      d.shape = "straight";
      d.layout = "beside";
    }
    return {
      id: `${i}-${j}`,
      label: `${s.name} / ${v}`,
      family: s.name,
      design: d,
    };
  }),
);
export function applyPreset(p: Preset, current: Design): Design {
  return fitDesign({
    ...structuredClone(p.design),
    name: current.name,
    icon: structuredClone(current.icon),
    layout: current.layout,
  });
}
export function parseDesign(value: unknown): Design {
  return fitDesign(designSchema.parse(value));
}
export const palettes = [
  ["Meadow", "#344f41", "#a9ba7a", "#d7e8bd"],
  ["Persimmon", "#b7492e", "#ffc085", "#ffd2ac"],
  ["Lilac", "#624397", "#b4a0dd", "#dac7ff"],
  ["Poolside", "#176877", "#75c8c2", "#a4f1e7"],
  ["Rosewater", "#9b3c63", "#e7a6b4", "#ffccd9"],
  ["Ink", "#252d36", "#97a6b4", "#e3ebf3"],
  ["Electric", "#5a3bd6", "#ec7dbe", "#c2aeff"],
  ["Cocoa", "#714635", "#c5a580", "#ecd6af"],
  ["Cherry soda", "#9c2344", "#f28a80", "#ffbec7"],
  ["Mango", "#935614", "#ffba49", "#ffdc88"],
  ["Lemon grove", "#616f19", "#c5d966", "#e7f4a4"],
  ["Lagoon", "#006661", "#5ed9bc", "#a1f4df"],
  ["Blue hour", "#254d9c", "#88b5ed", "#b9d7ff"],
  ["Ultraviolet", "#6542ac", "#ed9dde", "#d6bcff"],
  ["Candy shop", "#a93083", "#ff9eb9", "#ffcaec"],
  ["Terracotta", "#8c4434", "#d9a083", "#f1bea4"],
  ["Peacock", "#185c73", "#a8bd5e", "#9ad9ec"],
  ["Apricot sky", "#98491e", "#e6a7cb", "#ffd0a6"],
  ["Matcha latte", "#4b642f", "#c3b99b", "#cce3b1"],
  ["Ocean floor", "#29516a", "#8cadd2", "#bad8ee"],
  ["Disco", "#863584", "#e1b440", "#edbef1"],
  ["Tomato leaf", "#a33629", "#9bac65", "#ffc3a1"],
  ["Lavender fog", "#62527a", "#c5becd", "#e2d8f2"],
  ["Midnight mint", "#264d46", "#8ccbb4", "#b1f1d7"],
  ["Peach fuzz", "#995e52", "#ebba9e", "#fbd2c3"],
  ["Bubblegum", "#9e3870", "#bbace9", "#f9c5e5"],
  ["Honey", "#80601c", "#dcc178", "#f7e2a5"],
  ["Graphite", "#3e4145", "#b3b9c0", "#eef0f4"],
  ["Firefly", "#526a18", "#a7de3f", "#d9f8a0"],
  ["Polar", "#345d78", "#aedada", "#c6efff"],
  ["Grape fizz", "#693580", "#bb98e3", "#e4c7fa"],
  ["Red velvet", "#792e46", "#c58696", "#f4bdcd"],
];

export function compatibleFonts(name: string) {
  return fonts.filter(([id]) => supportsText(id, name));
}
export function fitDesign(d: Design): Design {
  const text = d.uppercase ? d.name.toUpperCase() : d.name;
  if (supportsText(d.font, text)) return d;
  const available = compatibleFonts(text);
  const preferred = available.find(([id]) => id === "notosans") || available[0];
  return preferred ? { ...d, font: preferred[0] } : d;
}
