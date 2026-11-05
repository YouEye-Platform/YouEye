// Optional browser fixture for live locale/state checks. No app build or server
// credentials are needed. Run from the repository root, then stop with Ctrl-C.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildSync, packageRoot } from "./helpers.mjs";

const { outputFiles } = buildSync({
  stdin: {
    contents: `
      import React, { useState, useEffect } from "react";
      import { createRoot } from "react-dom/client";
      import { BrandingLocaleProvider, useBrandingTranslations } from "./locale";
      import { TitleStudio } from "./Studio";
      import { defaultDesign } from "./lib/design";
      function IndependentAccount() {
        return <small data-independent-account>{useBrandingTranslations()("title.heading")}</small>;
      }
      function App() {
        const [locale, setLocale] = useState("en");
        const [design, setDesign] = useState(() => ({...structuredClone(defaultDesign), name: "My Draft Café"}));
        useEffect(() => {
          window.changeBrandingTestLocale = setLocale;
          window.brandingTestDesign = design;
        }, [design]);
        return <>
          <nav aria-label="Test languages">
            {["en", "ru", "es", "de", "fr"].map(value => <button key={value} onClick={() => setLocale(value)}>{value}</button>)}
            <BrandingLocaleProvider locale="ru"><IndependentAccount /></BrandingLocaleProvider>
          </nav>
          <BrandingLocaleProvider locale={locale}>
            <TitleStudio design={design} onChange={setDesign} onContinue={() => {}} onBack={() => {}} />
          </BrandingLocaleProvider>
        </>;
      }
      createRoot(document.getElementById("root")).render(<App />);
    `,
    sourcefile: "branding-browser-fixture.tsx",
    resolveDir: packageRoot,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  nodePaths: [resolve(packageRoot, "../../control-panel/node_modules")],
  loader: { ".css": "empty" },
  logLevel: "silent",
});
const source = outputFiles[0].contents;
const port = Number(process.env.BRANDING_TEST_PORT || 4318);
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><style>body{margin:0;background:#f2f3ee}nav{padding:10px;display:flex;gap:12px;align-items:center}button{cursor:pointer}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
    } else if (path === "/fixture.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.end(source);
    } else if (path === "/style.css") {
      response.setHeader("Content-Type", "text/css");
      response.end(await readFile(resolve(packageRoot, "style.css")));
    } else if (/^\/mytitle\/fonts\/[a-z0-9]+\.ttf$/.test(path)) {
      response.setHeader("Content-Type", "font/ttf");
      response.end(await readFile(resolve(packageRoot, "../../ui/public", path.slice(1))));
    } else {
      response.writeHead(404).end();
    }
  } catch {
    response.writeHead(404).end();
  }
});
server.listen(port, "0.0.0.0", () => console.log(`Branding locale fixture listening on ${port}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
