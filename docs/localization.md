# Interface languages

The interface language belongs to the signed-in person. Resolve their supported
preference, then the instance language, then English. A language change must load
new messages, not just change the document's `lang` attribute. Never put a
person's language in a process-global cache or change a container environment
variable to apply a personal preference.

## Authoring interface text

Use `useTranslations` in synchronous components and `getTranslations` in async
server components. Keep stable keys in the component's message namespace.
Translate buttons, headings, form labels, placeholders, validation, loading,
empty and error states, notifications and accessible names. Do not translate
internal identifiers or text supplied by a person.

Write complete messages with named ICU arguments instead of concatenating
translated fragments. Use ICU plurals and `Intl`/next-intl formatters with the
resolved interface locale. Keep meaningful context in the key or adjacent
translator documentation; distinguish actions from status labels. Shared terms
should use consistent wording across the interface.

Every supported catalogue needs the same keys and arguments. Run
`pnpm i18n:check` in both `ui` and `control-panel`; their build commands run it.
Checks validate message coverage, ICU syntax and argument agreement. They also
reject new visible string literals detected by the source audit.

The source audit is a guard, not a proof of full coverage. The checked-in
`src/i18n/untranslated-baseline.json` files inventory existing translation debt
while that interface is converted. Remove resolved entries; do not regenerate
the baseline to admit new untranslated features. Dynamic messages, composed
sentences, third-party widgets and responsive layouts still need review.

## Adding a language

Supported today: English, Russian, Spanish, German and French (`en`, `ru`, `es`,
`de`, `fr`).

1. Add the canonical language code, native name, English name and `ltr`/`rtl`
   direction to `shared/languages.json`. Selectors and API validation use it.
2. Add matching `ui/messages/<code>.json` and
   `control-panel/messages/<code>.json`, using the English keys and ICU arguments.
   Review the wording in context. A copied English catalogue is not a translation.
3. Update the independently versioned native app registries and catalogues.
   Apps accept only languages they ship; a regional variant may fall back to a
   shipped base language, and unavailable languages fall back to English.
4. Run catalogue checks, type checks and authenticated interface tests. Verify
   longer text, keyboard and screen-reader names, dates/numbers/plurals, and RTL
   layout where applicable. Direction metadata alone does not prove RTL support.

English fallback fills missing nested keys without discarding translated
siblings. It is recovery behavior, not permission to ship an incomplete
registered language; build checks require matching catalogues.

## Native apps and open views

Native apps use the authorized profile-scoped `/api/v1/header/config` response.
The request configuration must load actual messages for that locale, including
server components that resolve translations independently of the root layout.
Do not add a browser-supplied user identifier or broaden service credentials.

After saving a personal preference, Settings reloads its messages and signals
other same-origin views. Dashboard and app views re-read their own authenticated
locale on focus/visibility changes. Native `/api/locale` responses are private
and network-only. Offline failures preserve the current interface. Refreshing
messages must preserve in-progress client state; do not force-reload editors.

Validate two simultaneous accounts with different preferences, clearing a
personal preference, changing the instance default, navigating between apps,
returning to an already open view, and denied/unavailable profile reads.
Interface language does not automatically translate notes, Wikipedia articles,
movie metadata or other external content.

## Authenticated producers and embedded modules

Permission descriptors and approval requirements accept a translator resolved
from the authenticated acting user. Consent pages resolve the authenticated
identity's validated display locale with the instance and English fallbacks,
escape names, scopes and callback parameters, and retain their allow/deny form
contract. Tests render all supported consent languages, including hostile text.
Do not pass browser-supplied user identities into these resolution paths.

Pointer's shared React mount receives the host's resolved locale and exposes an
optional `setLocale` method (`components/settings-shell/pointer-console.tsx`).
Updating locale must preserve the existing mount, its navigation and unsaved
state; the host calls the method only when the module has it. Pointer's factory owns per-mount state, and the host keeps credentials
behind its existing authenticated request adapter. Pointer owns its catalogues
and generated-label checks; see its contributor localization guide.

Translate complete sentences, including counts, confirmation consequences and
accessible names. Do not concatenate English suffixes around translated labels.
Stable UI failures should use catalogue messages; provider diagnostics, user
content, identifiers and external search/article content retain their identity.

## Dynamic labels and locale changes

Status maps, success notices, helper return values, API/card fact labels and
confirmation consequences are interface text too. Resolve their translator in
the current component or authenticated request; do not freeze translated text
at module import. Keep a translator in the dependency list of callbacks and
computed labels that use it, so an open view uses the new language for its next
action without losing its draft. Use locale-aware relative times and units.

The source guard also checks `desc`, `confirmLabel`, `cancelLabel` and literal
success, notice and connection setters. This still does not discover every
composed or API-produced message. Review those paths and exercise actual rendered
responses. Prune resolved baseline entries only after the guard passes, without
adding or increasing exceptions. Product names, protocol identifiers and supplied
content retain their identity.

Settings and Market reconcile open views after language broadcasts, focus and visibility changes through their authenticated namespaced settings endpoint. Events never supply a trusted locale. Refresh the server tree without remounting embedded Pointer; its adapter reads the current translator through a ref. Offline or denied reads preserve the current view.

Custom text props such as `k`, `d`, subtitle and hint participate in the visible-source guard. Format displayed ratings, sizes and compact counts with the active locale; keep machine/SVG coordinates locale-independent. Language selectors show localized names alongside native names while retaining stable language codes.

## Shared branding editors

Control Panel and UI wrap their existing trees with
`BrandingLocaleProvider` from `@youeye/branding/locale`, passing the locale
resolved by the authenticated host. Update its `locale` prop in place.
Do not key or remount the provider to change language: editor drafts, selection,
locks and undo history must survive.

Shared controls use `useBrandingTranslations()` and the branding package's
five catalogues. Keep this package independent of either host's next-intl
provider. Translate editor controls, help, accessible names and displayed
option labels; preserve saved artwork text, font family identifiers, asset
paths and design IDs. Avoid storing translated labels as persistent design data.

Both host source checks include the shared branding TSX tree and the designated
display-data modules (`creative/data.ts`, `lib/design.ts`, `lib/icon-styles.ts`
and Settings' `ai-navigation.ts`). Keep display labels in the appropriate
catalogue; adding a helper module must not hide new interface text from review.
Negative audit tests cover shared controls, display data, accessible names and
misplaced client directives.

## Error and interrupted-operation surfaces

The dashboard's Pages Router error page (`ui/src/pages/_error.tsx`) can render
without an App Router provider.
It creates a translator from its explicit supported catalogue and validated
locale, with an English fallback. Test errors independently of the normal root
layout so a failure cannot cause another provider error.

Long operations retain their exact operation identity across language changes,
lost replies and reloads. Refresh translations without restarting the operation.
Only an authenticated receipt for that identity may establish completion or
enable recovery with the original selection. A missing or foreign receipt
remains uncertain.
