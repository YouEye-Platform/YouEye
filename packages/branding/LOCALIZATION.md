# Shared branding interface languages

The host resolves the authenticated person's interface language, including its
instance and English fallbacks. Wrap the shared studio, artwork and brand
consumers once, inside the host's client boundary:

```tsx
import { BrandingLocaleProvider } from "@youeye/branding/locale";

<BrandingLocaleProvider locale={resolvedLocale}>
  {children}
</BrandingLocaleProvider>
```

The provider accepts `en`, `ru`, `es`, `de` and `fr`. Regional variants select a
shipped base language; unsupported values select English. Change the `locale`
prop in place. Do not add a locale `key` or remount the editor: the current
stage, typed draft, chooser, search, locks and undo history belong to that mount.
Independent providers can show different languages at the same time.

The package owns its catalogs and does not depend on next-intl, cookies,
browser storage or a process-wide current locale. `useBrandingLocale()` and
`useBrandingTranslations()` are exported from `@youeye/branding/locale`.
Authenticated producers and tests can use the pure
`createBrandingTranslator(locale)` from `@youeye/branding/messages`, which also
exports `brandingCatalogs`, `brandingLocales` and the message/locale types.

## Authoring and display data

Add matching keys to all five `messages/<locale>.json` files. Messages use named
scalar arguments such as `{name}` and `{total}`. Numeric arguments are formatted
with `Intl.NumberFormat` for the selected language; document/SVG coordinates
remain locale independent. This small formatter does not parse arbitrary ICU
expressions. Use complete message keys for each action and state, including
grammatical variants; do not concatenate translated sentence fragments.
Placeholder names must match in every catalog. English fallback is recovery
behavior; it does not permit shipping missing translations.

Shared creative metadata uses `nameKey`, `hintKey`, `labelKey`, `titleKey`,
`iconKey`, `titleLineKey`, `iconLineKey`, `titleActionKey` and `iconActionKey`.
Resolve these keys in the current render. `labels.ts` projects palette names,
symbol identifiers, categories, sticker finishes and sticker shapes to messages.
Every bundled symbol has a complete catalog label. The picker searches both its
localized label and its canonical identifier.

`lib/design.ts` retains its persisted identifiers, preset identities and real
font family names. `creative/server-names.ts`, `YouEye`, `Untitled`, the `Aa`
lettering sample, entered titles/initials, emoji and uploaded artwork are
document content. Changing the interface language does not rewrite them.
Generic controls accept already localized `label`, `hint`, `items`, `ends` and
children supplied by their caller.

Upload errors retain a typed message key and resolve it during the current
render, so an open error changes language without losing the upload dialog.
The React artwork component passes localized accessible metadata into
`renderSvg` through its optional final `accessibility` argument. Existing raw
renderer calls and the artwork geometry keep their original behavior.

## Focused verification

Use the monorepo's installed core dependencies, without an install or production
build:

```sh
node --test packages/branding/tests/localization.spec.mjs
node control-panel/scripts/check-i18n-source.mjs
node ui/scripts/check-i18n-source.mjs
```

The package tests check five-language catalog and argument parity, every dynamic
option, actual React rendering, SVG escaping/geometry, image failure codes,
locale isolation and zero shared-source literal entries without a baseline.
They load the same pinned font bytes that the application uses.

For interactive verification, run
`node packages/branding/tests/localization-preview.mjs` and open port 4318 on its
real localhost origin. Stop the fixture afterward. The fixture provides language
switches and an independent Russian provider for checking simultaneous locales.
Verify an uncommitted input, the current font, locks, undo history, the sticker
stage and an open chooser/error before and after changing languages.
