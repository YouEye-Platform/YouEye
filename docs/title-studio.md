# Title Studio and Sticker Machine

Title Studio is the editor for the server's title (styled lettering of the server name) and its sticker (the
small mark that is also the favicon and app icon). The same editor is used in setup, personal Appearance, admin
Branding, per-app branding and the greeting widget.

## The package

`packages/branding` (`@youeye/branding`) holds:

- the MyTitle renderer (`lib/render.ts`) and the editable design schema, `version: 1` (`lib/design.ts`);
- 49 local fonts with glyph coverage data (`lib/font-coverage.json`) and 1,512 Phosphor symbols (`lib/icons.json`);
- the editors: `Studio.tsx` (`TitleStudio`), `creative/TitleBuilder.tsx`, `creative/StickerMachine.tsx`;
- `resolveTitle` (`appearance.ts`), the shared rule for which title a person sees;
- its own translations (`messages/`, five languages; see [localization.md](localization.md)).

Source pin, licences, notices and asset hashes are in `legal/mytitle/`. The editor CSS is scoped to
`.mytitle-scope`, so it does not change the host app's styles.

## How a design is stored

- The dashboard owns branding (`ui/src/lib/db/queries/branding.ts`, table `system_settings`). The shared title is
  `site_name` plus `site_name_style`.
- A Studio design is saved as `site_name_style.mytitle` (the version 1 document) with `mytitleRevision`.
- `site_name_style` can also hold only CSS fields (font family, size, weight, colour, gradient, shadow, transform,
  per-character shape). Readers render such a style as it is (`ui/src/components/layout/site-name.tsx`). Every
  editor now opens Title Studio (`WordArtPickerInline.tsx` just wraps it); opening an old CSS-only style does not
  convert it, and saving stores a `mytitle` document.
- `site_name_style.showHeaderLogo` (admin setting **Show sticker beside the title** in Branding, off by default)
  shows the sticker in the header. It is separate from the design and applies even when a person has their own
  title. The sticker is the favicon either way.

## Saving

1. The dashboard validates the document and checks that the chosen fonts cover every character.
2. It renders immutable files: light and dark title SVGs and icon PNGs, named after the revision
   (`ui/src/lib/mytitle-assets.ts`). The revision is the SHA-256 of the renderer revision plus the prepared
   document, so a renderer change gives a new revision.
3. It writes the document and the active file references in one transaction, under a branding advisory lock.

- Save requests carry `expected_revision` (null when the current style has no revision). A competing save gets
  `409`. Repeating an identical save is safe.
- Generated files live in persistent branding storage, not in the app bundle. A failed write or transaction leaves
  the previous design active. Unreferenced files may stay behind after a failure; delete them only after checking
  that nothing refers to them. Never delete the previous active files when publishing a new design.
- Uploaded sticker images: PNG, JPEG or WebP, at most 2 MB and 4096 pixels per side. An unreadable file shows a
  retryable message and keeps the current mark.

## Personal titles

- A person can have their own design (Settings → Appearance). It owns its text and lettering for that account
  only. Everyone else, and the public sign-in page, see the shared title.
- A personal style without its own `mytitle` keeps its styling but follows the server's name (`resolveTitle`).
- **Use server title** removes the personal override and shows the current saved shared design. An admin's unsaved
  draft is never shown as a default.
- `resolveTitle` is used by the dashboard, Timeline, Notifications and the header APIs, including the Settings
  bridge. Personal changes never change the shared branding or another account.

## Where titles appear

- The dashboard and Settings previews render the saved vector design.
- YouEye ID's sign-in page uses the same renderer and local fonts, with escaped plain text if the artwork is
  missing.
- Icons and browser/PWA artwork use the immutable PNGs.
- Native app headers get validated outline artwork through their branding CSS, so they need no fonts and no extra
  permission.
- Compact places fit the actual lettering bounds; the title widget fills its width; the sign-in artwork stays in
  its centred box.

After a confirmed save or reset, open title views in the same document and in other tabs of the same origin
re-read their title (the notice carries no data; each view reads through its own authenticated API, no-store).
Focus, visibility and history navigation also refresh it. Failed saves announce nothing. No reload is needed.

## Editor behaviour

- Locks and Undo are editor state only; Undo keeps the last 20 changes.
- The monogram follows the name until the person picks their own letters or another mark.
- **Match title** in the Sticker Machine uses the title's light and dark ink for the mark but keeps the saved
  independent colours; unchecking it brings them back. Choosing a new colour pair switches back to independent
  colours.
- Save buttons stay visible while scrolling. Appearance waits for both the shared and the personal design before
  showing the editor, so a slow first response cannot overwrite typing; a failed first read offers Retry.
- Emoji look depends on the device's emoji font; the bundled fonts do not include colour emoji.

## Greeting designs

Greeting widget designs are saved with the account's widget layout. A full replacement is validated first, then
old rows are deleted and new ones inserted in one transaction, under a per-account lock. Invalid data or a failed
insert keeps the previous layout.

## Tests

- `packages/branding/tests/`: renderer (font hashes, presets, glyph coverage, refusal of executable uploads,
  unknown symbols, unknown versions and out-of-range values), title appearance, dashboard language rendering.
- `control-panel/tests/title-appearance.browser.mjs` (opt-in): real Settings, header and widget components against
  a local fixture API (overrides, shared changes, reset, other tabs, failed saves, slow responses).
- `ui/tests/integration/build-widgets.mjs` (opt-in): the greeting/widget replacement query against a disposable
  PostgreSQL schema.

These do not prove browser layout, first-run provisioning or installed updates; check those on a test VM.
