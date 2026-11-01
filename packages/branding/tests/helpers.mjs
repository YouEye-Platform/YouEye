import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("../", import.meta.url));
export const requireBranding = createRequire(new URL("../package.json", import.meta.url));
// Use the monorepo's installed tooling; the package has no new runtime dependency.
export const requireTools = createRequire(new URL("../../../control-panel/package.json", import.meta.url));
export const { buildSync } = requireTools("esbuild");

/** Bundle only the shared package, in memory, without a production build. */
export function loadBranding() {
  const { outputFiles } = buildSync({
    stdin: {
      contents: `
        export * from "./messages";
        export * from "./locale";
        export * from "./labels";
        export * from "./lib/design";
        export * from "./lib/image";
        export * from "./lib/fonts";
        export * from "./lib/icon-styles";
        export * from "./lib/render";
        export * from "./creative/data";
        export * from "./creative/starter";
        export * from "./creative/shared";
        export * from "./components";
        export * from "./Studio";
        export * from "./MarkLibrary";
        export { default as icons } from "./lib/icons.json";
      `,
      resolveDir: packageRoot,
      sourcefile: "branding-test-entry.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    external: ["react", "lucide-react", "zod"],
    loader: { ".css": "empty" },
    logLevel: "silent",
  });
  const result = { exports: {} };
  new Function("require", "module", "exports", outputFiles[0].text)(
    requireBranding, result, result.exports,
  );
  return result.exports;
}
