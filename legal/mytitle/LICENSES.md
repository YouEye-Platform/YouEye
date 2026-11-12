# MyTitle — source and licence register

Generated from the installed lockfile by `pnpm licenses:generate`. Do not edit generated tables by hand.

## Original work

MyTitle application, renderer, presets, five comparison layout pairs (Pocket, Lookbook, One at a time, Side by side, Spotlight), ten round-two creative workflows (Vibe finder, Title studio (formerly Type radio), Poster press, This or that, In the wild, Creature club, Sticker machine, Tile workshop, Icon safari, Tiny test lab), the 120-name suggestion registry, tests, and tooling are original code, licensed MIT (see LICENSE). No YouEye product code or Microsoft artwork was copied. The design follows the owner’s YouEye UX 2.0.1 guidance (source revision 2bd81720d561332efc473d08e655a72486c07626); no specimen source/assets are included.

## Code and assets actually used

- React / React DOM: application components and state.
- OpenType.js: font parsing, glyph outlines and kerning in src/lib/fonts.ts and render.ts.
- Phosphor Icons Core: 1,512 regular SVG symbols, generated unchanged apart from wrapper/fill normalization into src/lib/icons.json by scripts/icons.mjs. MIT notices retained below.
- Lucide React: interface icons; ISC with Feather MIT notices.
- fflate: ZIP export in src/lib/export.ts.
- Zod: strict design import and persistence validation.
- Fontsource IBM Plex Sans: self-hosted interface font.
- Google Fonts files listed below: self-hosted lettering. Original fonts are unmodified; exported logos contain derived glyph outlines.
- Vite/TypeScript and test tooling: build/verification, not runtime editor features.

No source from the reference clones was pasted/adapted into MyTitle. App Icon Generator informed the foreground/background workflow; Icônes informed search; Warp.js informed investigation of distortion; SVG-Edit and Fabric informed composition research. Faviator informed compact initials controls; schwa/icon-generator informed layered treatments; Patternomaly informed texture choices; Iconify informed symbol discovery. SuperTinyIcons was inspected for small-size legibility only: its individual assets have mixed licences, so none were imported. Iconify’s MIT framework licence does not cover every icon collection. No SF Symbols, third-party brand logos or new runtime packages were imported. MyTitle rendering/warps, icon patterns/recipes and UI are original. The ten round-two workflows draw interaction inspiration from Fontjoy, Coolors, Haikei, Canva, Adobe Express, LogoFast, IconKitchen, Figma and Nielsen Norman Group; see research/ROUND_TWO_UX.md for sources and design inferences. These websites are reference-only and are not asserted to be MIT-licensed; no code or assets from them were copied. The name registry and title selector are original code; research/SERVER_NAMES.md records the naming inspiration and sources. The dependency packages above are independently installed, versioned code.

## Font assets

|Font|Licence|Original source|SHA-256|
|---|---|---|---|
|bungee|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/bungee)|c4f5361ce120af3e6b9156d0bf379fa19cda2ea0cd18ac01fd99596c6bf66e3f|
|pacifico|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/pacifico)|5b6c0d5334a7bf77dea52b975c5a0c408878c0f7115ed5b6fb151f634b7bf701|
|monoton|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/monoton)|951c4cea65ffede784a7c9672feec5d329a7e1e12216c42d53ecf36c90d04dea|
|pressstart2p|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/pressstart2p)|034c77f1f05ec89421e4a63f0e3a4ca1ecf852cc6d2bf611f126f275728e017d|
|righteous|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/righteous)|2ffb3fe5c27d7e6571210b800448c4e234e651b46c6b4426c1bb567e5341348a|
|abrilfatface|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/abrilfatface)|5971d4a3758a922a9fedc7f6fb825a96341a2e718c45a4b2c9a6b417c8c4dbe9|
|blackopsone|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/blackopsone)|282a825b5f294377387e3969f765408157dbea8da0f5d0aae68c6bc704b145b3|
|permanentmarker|Apache-2.0|[Google Fonts](https://github.com/google/fonts/tree/main/apache/permanentmarker)|28f82c8a7943cb8e9d599f8554da1d4fc75dbcf69b9885ad6c0611d20c6946c5|
|lobster|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/lobster)|d6568e697fd50cedc0be04d8aae4127fe95add607e7bff954ca88604be80c205|
|audiowide|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/audiowide)|c7c0f2b0f6fad8c623e31772ce79f94a4edb9321ffce9fce978ea892d20ae730|
|creepster|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/creepster)|402aeb734586c74aecd3dbdc454589b1fb12e2e1c71f782fd019ae68066d9f44|
|dmserifdisplay|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/dmserifdisplay)|df74c0ac387baeaeb0fe4f2324e1668e6a3ed8c09cd9796fe162c71753e19e45|
|spacegrotesk|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/spacegrotesk)|acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72|
|caveat|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/caveat)|0bdb6b660482d31531b3945849fba5916b3ef8695da7024a9e6b9ee3c4157988|
|comfortaa|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/comfortaa)|0fc3f45dc48b614db9c39181502544b37217ecbf8bee2fb35886992bc96c5bd3|
|oswald|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/oswald)|5b38c246e255a12f5712d640d56bcced0472466fc68983d2d0410ec0457c2817|
|montserrat|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/montserrat)|0f7b311b2f3279e4eef9b2f968bcdbab6e28f4daeb1f049f4f278a902bcd82f7|
|orbitron|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/orbitron)|f42db2dd16e642258e35782916eceb1dcdbea06fb958d77ad71dc5963587e8fd|
|fredoka|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/fredoka)|2ba02e68b152868aef9ba28e24b3648c7d457fe6f25c761f2c2c53fb61a73fc8|
|playfairdisplay|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/playfairdisplay)|c40f2293766a503bc70cce9e512ef844a4ccb7cbcde792fe2ea31d191917d8d6|
|dancingscript|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/dancingscript)|21808625578fe8d8cd10cb684be546dca077b27cd03a53a2f1ec11dc743c924c|
|cinzel|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/cinzel)|f4d83d34d1f6c741193e4acf4b3dff9531e5a67b6aa65228d00a7db72a4e0f34|
|quicksand|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/quicksand)|39c9b64223561f56aaff6062a6f04063c4fc86809ad6768722c06614d977e1cc|
|archivoblack|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/archivoblack)|dd9a89a019b4849f66ab75455fe7bdf931311042cbb0f0f97acc061539703180|
|russoone|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/russoone)|bc0abcc660bd8b7ad3000ecb2898a27c58a29a50f7ec81652fa12e75148d09df|
|satisfy|Apache-2.0|[Google Fonts](https://github.com/google/fonts/tree/main/apache/satisfy)|55bb141a0a23a32278d5fa7fd2e853824faa173b94774660ebeddb106be07c80|
|greatvibes|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/greatvibes)|8d509802186f1b51572531ecf313e8098f9a5bfdfaca93f0c9b34467f9982d15|
|bangers|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/bangers)|4160a7311de9342674cce9160cde9fcbb30f48190397d86ff1b70b455af65824|
|bebasneue|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/bebasneue)|08e4623805102d819f58601e46e345648846075e363b2ceb23313c2d1c83ec73|
|alfaslabone|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/alfaslabone)|28664afa698a3393bd5a29eec750230a0645c5301d62200e5f2d3a027fb2299d|
|rubikmonoone|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/rubikmonoone)|b22624b6a36e543e942106edfccd198c50b57b65b924bfe02a6f0a5699429e6b|
|rubikglitch|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/rubikglitch)|260245012483d56956269100ebece747aa95b4b67e5a9411a81a36e91f55e653|
|rubikmoonrocks|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/rubikmoonrocks)|39ff4d96b906e8cc2fd7a350aa13620d5eff18d776fedb5c98c12cbf6e1f2c1e|
|luckiestguy|Apache-2.0|[Google Fonts](https://github.com/google/fonts/tree/main/apache/luckiestguy)|cfbdd68a039f92df51cf3721506af6242e64594c6325fe0bedbeff3fe385d980|
|vt323|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/vt323)|cf4de751ada78ceac033dbe16a687742939995b77bc2a052ae17a4957958594d|
|specialelite|Apache-2.0|[Google Fonts](https://github.com/google/fonts/tree/main/apache/specialelite)|a776fcb4ceb8bdf03e2967688ebdad42680de5b91a7e62c17e718ae212d14bc4|
|notosans|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/notosans)|bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d|
|notoserif|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/notoserif)|4d8e6761424656867019081a1a01336f3cb086982682698714054fc33f782713|
|rubik|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/rubik)|1b3a7437ba2af80e465e773ed60c5036d1ba6ace492d89046dbcf18fb31e4e88|
|unbounded|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/unbounded)|323b511be380c8d474ef030686b71aedde501f8d9cd46da558b7c40454372c3f|
|yesevaone|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/yesevaone)|88362b33820f0011e163e67b1d570fecd442aa8c05eaac89d5162f9c40d9dac3|
|marckscript|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/marckscript)|504de8cc6f919163bc9afb67b9bc208d258230c5e8d00cb82ec52474f9fafc3b|
|badscript|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/badscript)|40ec737eee65ec4efbc24ae636fa31d7d84d1ccca83ab54cd555edb72cb3eaf0|
|amaticsc|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/amaticsc)|513a76f96d39a5366bd27c258674aaea35ee51c42b8f3060387f74649ee8c8aa|
|philosopher|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/philosopher)|e1cba0b5003b5694f1d6cc0fbe629f78362ad38a9ffd4d0cb7abfd9698a575ed|
|vollkorn|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/vollkorn)|4ebef434f76f80286204840354a84db79a0dc3c87deeeb791e015b70b2ade49d|
|zenmarugothic|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/zenmarugothic)|a0c0b53543e0993ae2225e629c833f3d51495ad31720694ff112ce4ce11111ef|
|mashanzheng|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/mashanzheng)|6d2546bb189c732a8ca29af9e22457b152387d158aa459e4ac2ce1e51788b7fb|
|gaegu|OFL-1.1|[Google Fonts](https://github.com/google/fonts/tree/main/ofl/gaegu)|aa52c98336f7c62e2896fc8b12b56a75d5b476d88a2f104b0980f4f7ce0adfc3|

## Reference checkouts (not shipped)

Local copies are ignored by the parent repository; origin/commit manifest and clone script are committed. Original licence files remain in each checkout. A public repository without a licence is not treated as reusable code.

|Repository|Pinned commit|Licence files in checkout|
|---|---|---|
|[leandro32x/app-icon-generator-public](https://github.com/leandro32x/app-icon-generator-public)|214f39e0cf832088df951da967ef14953788092f|LICENSE|
|[antfu-collective/icones](https://github.com/antfu-collective/icones)|1b7f2ba7a7f88cac09bb9da093921612060abd03|LICENSE|
|[ryanuo/textcss](https://github.com/ryanuo/textcss)|5db868d22db44b16a81c459a87484e3f0a019dc2|LICENSE.md|
|[benjamminf/warpjs](https://github.com/benjamminf/warpjs)|a765f8a509b116bb9880e4437f2d6255d2fbcc6e|LICENSE|
|[opentypejs/opentype.js](https://github.com/opentypejs/opentype.js)|5d65b6dcfab5115f90d375f8ba6b7942fdaa0138|LICENSE|
|[fabricjs/fabric.js](https://github.com/fabricjs/fabric.js)|90d2c71ecee44bae1915fed3e9423f53b9cb1889|LICENSE|
|[SVG-Edit/svgedit](https://github.com/SVG-Edit/svgedit)|c44f061d2f9a626d2771cc931298af5a45522d87|LICENSE-MIT.txt, licenseInfo.json|
|[tabler/tabler-icons](https://github.com/tabler/tabler-icons)|a4ce1404bc6d24d3c365afe7b258d6bf6f48d62d|LICENSE|
|[phosphor-icons/core](https://github.com/phosphor-icons/core)|2b75f3ad12b420c9504ef05df8d2564a28f8500e|LICENSE|
|[itgalaxy/favicons](https://github.com/itgalaxy/favicons)|30ec2042097bd749af174da047681080390810ba|LICENSE|
|[donlair/browsertexteffects](https://github.com/donlair/browsertexteffects)|5f33d31e0a39a55a3340dc196c92c436282e30ff|LICENSE|
|[mxvsh/svglogo](https://github.com/mxvsh/svglogo)|6e9f52b444744a060537844d225524970323997b|No root licence verified; reference only|
|[romannurik/AndroidAssetStudio](https://github.com/romannurik/AndroidAssetStudio)|ac5649658291b556db017817914f843a41d344b9|LICENSE|
|[sacredvoid/logo-generator](https://github.com/sacredvoid/logo-generator)|de357b6ff48a83381da52eeff241c67295714135|LICENSE|
|[faviator/faviator](https://github.com/faviator/faviator)|288615170bacb967fe44b2ecfa2229d320878242|LICENSE|
|[schwa/icon-generator](https://github.com/schwa/icon-generator)|893250e4bec9bec4d66b2d99a0eae37b0b868833|LICENSE|
|[ashiguruma/patternomaly](https://github.com/ashiguruma/patternomaly)|5ca857ae7888aacaac9ecfc43f6b3e9859e40645|LICENSE|
|[edent/SuperTinyIcons](https://github.com/edent/SuperTinyIcons)|d532b8a9e8a96ed5462f3813106f0b1e230249dc|LICENSE|
|[iconify/iconify](https://github.com/iconify/iconify)|48826b359b57266206f254c27849869ce6d00280|license.txt|

## Installed dependency inventory

Includes runtime and development transitive dependencies for a complete provenance record; not all packages below are shipped to the browser. Versions are pinned by pnpm-lock.yaml. Complete upstream notices are in public/THIRD_PARTY_NOTICES.txt, included in the hosted app and exported identity kits.

|Package|Version|Declared licence|Upstream|
|---|---|---|---|
|@babel/code-frame|7.29.7|MIT|https://github.com/babel/babel.git|
|@babel/compat-data|7.29.7|MIT|https://github.com/babel/babel.git|
|@babel/core|7.29.7|MIT|https://github.com/babel/babel.git|
|@babel/generator|7.29.8|MIT|https://github.com/babel/babel.git|
|@babel/helper-compilation-targets|7.29.7|MIT|https://github.com/babel/babel.git|
|@babel/helper-globals|7.29.7|MIT|https://github.com/babel/babel.git|
|@babel/helper-module-imports|7.29.7|MIT|https://github.com/babel/babel.git|
|@babel/helper-module-transforms|7.29.7|MIT|https://github.com/babel/babel.git|
|@babel/helper-plugin-utils|7.29.7|MIT|https://github.com/babel/babel.git|
|@babel/helper-string-parser|7.29.7|MIT|https://github.com/babel/babel.git|
|@babel/helper-validator-identifier|7.29.7|MIT|https://github.com/babel/babel.git|
|@babel/helper-validator-option|7.29.7|MIT|https://github.com/babel/babel.git|
|@babel/helpers|7.29.10|MIT|https://github.com/babel/babel.git|
|@babel/parser|7.29.9|MIT|https://github.com/babel/babel.git|
|@babel/plugin-transform-react-jsx-self|7.29.7|MIT|https://github.com/babel/babel.git|
|@babel/plugin-transform-react-jsx-source|7.29.7|MIT|https://github.com/babel/babel.git|
|@babel/template|7.29.7|MIT|https://github.com/babel/babel.git|
|@babel/traverse|7.29.10|MIT|https://github.com/babel/babel.git|
|@babel/types|7.29.8|MIT|https://github.com/babel/babel.git|
|@esbuild/linux-x64|0.28.2|MIT|https://github.com/evanw/esbuild.git|
|@fontsource/ibm-plex-sans|5.3.0|OFL-1.1|https://github.com/fontsource/font-files.git|
|@jridgewell/gen-mapping|0.3.13|MIT|https://github.com/jridgewell/sourcemaps.git|
|@jridgewell/remapping|2.3.5|MIT|https://github.com/jridgewell/sourcemaps.git|
|@jridgewell/resolve-uri|3.1.2|MIT|https://github.com/jridgewell/resolve-uri|
|@jridgewell/sourcemap-codec|1.6.0|MIT|https://github.com/jridgewell/sourcemaps.git|
|@jridgewell/trace-mapping|0.3.31|MIT|https://github.com/jridgewell/sourcemaps.git|
|@napi-rs/lzma-linux-x64-gnu|1.5.1|MIT|https://github.com/Brooooooklyn/lzma.git|
|@phosphor-icons/core|2.1.1|MIT|https://github.com/phosphor-icons/phosphor-core.git|
|@playwright/test|1.64.1|Apache-2.0|https://github.com/microsoft/playwright.git|
|@rolldown/pluginutils|1.0.0-rc.3|MIT|https://github.com/rolldown/rolldown.git|
|@rollup/rollup-linux-x64-gnu|4.64.7|MIT|https://github.com/rollup/rollup.git|
|@types/babel__core|7.20.5|MIT|https://github.com/DefinitelyTyped/DefinitelyTyped.git|
|@types/babel__generator|7.27.0|MIT|https://github.com/DefinitelyTyped/DefinitelyTyped.git|
|@types/babel__template|7.4.4|MIT|https://github.com/DefinitelyTyped/DefinitelyTyped.git|
|@types/babel__traverse|7.28.0|MIT|https://github.com/DefinitelyTyped/DefinitelyTyped.git|
|@types/chai|5.2.3|MIT|https://github.com/DefinitelyTyped/DefinitelyTyped.git|
|@types/deep-eql|4.0.2|MIT|https://github.com/DefinitelyTyped/DefinitelyTyped.git|
|@types/estree|1.0.9|MIT|https://github.com/DefinitelyTyped/DefinitelyTyped.git|
|@types/node|24.19.2|MIT|https://github.com/DefinitelyTyped/DefinitelyTyped.git|
|@types/opentype.js|1.3.10|MIT|https://github.com/DefinitelyTyped/DefinitelyTyped.git|
|@types/react|19.3.0|MIT|https://github.com/DefinitelyTyped/DefinitelyTyped.git|
|@types/react-dom|19.3.0|MIT|https://github.com/DefinitelyTyped/DefinitelyTyped.git|
|@vitejs/plugin-react|5.2.0|MIT|https://github.com/vitejs/vite-plugin-react.git|
|@vitest/expect|3.2.7|MIT|https://github.com/vitest-dev/vitest.git|
|@vitest/mocker|3.2.7|MIT|https://github.com/vitest-dev/vitest.git|
|@vitest/pretty-format|3.2.7|MIT|https://github.com/vitest-dev/vitest.git|
|@vitest/runner|3.2.7|MIT|https://github.com/vitest-dev/vitest.git|
|@vitest/snapshot|3.2.7|MIT|https://github.com/vitest-dev/vitest.git|
|@vitest/spy|3.2.7|MIT|https://github.com/vitest-dev/vitest.git|
|@vitest/utils|3.2.7|MIT|https://github.com/vitest-dev/vitest.git|
|assertion-error|2.0.1|MIT|git@github.com:chaijs/assertion-error.git|
|baseline-browser-mapping|2.11.29|Apache-2.0|https://github.com/web-platform-dx/baseline-browser-mapping.git|
|browserslist|4.29.3|MIT|browserslist/browserslist|
|cac|6.7.14|MIT|egoist/cac|
|caniuse-lite|1.0.30001816|CC-BY-4.0|browserslist/caniuse-lite|
|chai|5.3.3|MIT|https://github.com/chaijs/chai|
|check-error|2.1.3|MIT|ssh://git@github.com/chaijs/check-error.git|
|convert-source-map|2.0.0|MIT|git://github.com/thlorenz/convert-source-map.git|
|csstype|3.2.3|MIT|https://github.com/frenic/csstype|
|debug|4.4.3|MIT|git://github.com/debug-js/debug.git|
|deep-eql|5.0.2|MIT|git@github.com:chaijs/deep-eql.git|
|electron-to-chromium|1.5.458|ISC|https://github.com/Kilian/electron-to-chromium.git|
|es-module-lexer|1.7.0|MIT|https://github.com/guybedford/es-module-lexer.git|
|esbuild|0.28.2|MIT|https://github.com/evanw/esbuild.git|
|escalade|3.2.0|MIT|lukeed/escalade|
|estree-walker|3.0.3|MIT|https://github.com/Rich-Harris/estree-walker|
|expect-type|1.4.0|Apache-2.0|https://github.com/mmkal/expect-type.git|
|fdir|6.5.0|MIT|https://github.com/thecodrr/fdir.git|
|fflate|0.8.3|MIT|https://github.com/101arrowz/fflate|
|gensync|1.0.0-beta.2|MIT|https://github.com/loganfsmyth/gensync.git|
|js-tokens|4.0.0|MIT|lydell/js-tokens|
|js-tokens|9.0.1|MIT|lydell/js-tokens|
|jsesc|3.1.0|MIT|https://github.com/mathiasbynens/jsesc.git|
|json5|2.2.3|MIT|https://github.com/json5/json5.git|
|loupe|3.2.1|MIT|https://github.com/chaijs/loupe|
|lru-cache|5.1.1|ISC|git://github.com/isaacs/node-lru-cache.git|
|lucide-react|0.468.0|ISC|https://github.com/lucide-icons/lucide.git|
|magic-string|0.30.21|MIT|https://github.com/Rich-Harris/magic-string.git|
|ms|2.1.3|MIT|vercel/ms|
|nanoid|3.3.20|MIT|ai/nanoid|
|node-releases|2.0.59|MIT|https://github.com/chicoxyzzy/node-releases.git|
|opentype.js|1.3.4|MIT|git://github.com/opentypejs/opentype.js.git|
|opentype.js|1.3.5|MIT|git://github.com/opentypejs/opentype.js.git|
|pathe|2.0.3|MIT|unjs/pathe|
|pathval|2.0.1|MIT|ssh://git@github.com/chaijs/pathval.git|
|picocolors|1.1.1|ISC|alexeyraspopov/picocolors|
|picomatch|4.0.7|MIT|micromatch/picomatch|
|playwright|1.64.1|Apache-2.0|https://github.com/microsoft/playwright.git|
|playwright-core|1.64.1|Apache-2.0|https://github.com/microsoft/playwright.git|
|postcss|8.5.30|MIT|postcss/postcss|
|prettier|3.9.10|MIT|prettier/prettier|
|react|19.3.1|MIT|https://github.com/react/react.git|
|react-dom|19.3.1|MIT|https://github.com/react/react.git|
|react-refresh|0.18.0|MIT|https://github.com/facebook/react.git|
|rollup|4.64.7|MIT|https://github.com/rollup/rollup.git|
|scheduler|0.28.0|MIT|https://github.com/react/react.git|
|semver|6.3.1|ISC|https://github.com/npm/node-semver.git|
|siginfo|2.0.0|ISC|https://github.com/emilbayes/siginfo.git|
|source-map-js|1.2.2|BSD-3-Clause|7rulnik/source-map-js|
|stackback|0.0.2|MIT|git://github.com/shtylman/node-stackback.git|
|std-env|3.10.0|MIT|unjs/std-env|
|string.prototype.codepointat|0.2.1|MIT|https://github.com/mathiasbynens/String.prototype.codePointAt.git|
|strip-literal|3.1.0|MIT|https://github.com/antfu/strip-literal.git|
|tiny-inflate|1.0.3|MIT|git://github.com/devongovett/tiny-inflate.git|
|tinybench|2.9.0|MIT|tinylibs/tinybench|
|tinyexec|0.3.2|MIT|https://github.com/tinylibs/tinyexec.git|
|tinyglobby|0.2.17|MIT|https://github.com/SuperchupuDev/tinyglobby.git|
|tinypool|1.1.1|MIT|https://github.com/tinylibs/tinypool.git|
|tinyrainbow|2.0.0|MIT|https://github.com/tinylibs/tinyrainbow.git|
|tinyspy|4.0.6|MIT|https://github.com/tinylibs/tinyspy.git|
|typescript|5.9.3|Apache-2.0|https://github.com/microsoft/TypeScript.git|
|undici-types|7.24.6|MIT|https://github.com/nodejs/undici.git|
|update-browserslist-db|1.3.4|MIT|browserslist/update-db|
|vite|7.3.7|MIT|https://github.com/vitejs/vite.git|
|vite-node|3.2.4|MIT|https://github.com/vitest-dev/vitest.git|
|vitest|3.2.7|MIT|https://github.com/vitest-dev/vitest.git|
|why-is-node-running|2.3.0|MIT|https://github.com/mafintosh/why-is-node-running.git|
|yallist|3.1.1|ISC|https://github.com/isaacs/yallist.git|
|zod|4.6.7|MIT|https://github.com/colinhacks/zod.git|

## Output and user uploads

User-uploaded images are not relicensed by MyTitle. Emoji SVGs use platform emoji fonts; use PNG for the current appearance, or licensed Phosphor symbols/monograms for consistent portable artwork. Exported kits include notices. Font/icon licences do not grant rights to third-party trademarks.
