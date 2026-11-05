# Title Studio and Sticker Machine

The shared `@youeye/branding` workspace package contains the pinned MyTitle
renderer, v1 editable design schema, font coverage, 49 local fonts and 1,512
Phosphor symbols. The source pin, original licences, notices and distributed
asset hashes are retained in `legal/mytitle`. The package's editor CSS is scoped
to `.mytitle-scope`; expressive artwork does not change surrounding app styles.

Setup, personal Appearance, administrator Appearance, app branding and greeting settings use the same Title Studio editor.
The legacy WordArt reader remains available for saved appearances and account
overrides; legacy editing surfaces are replaced by Title Studio. Opening an old appearance does not migrate it. Saving a title and
sticker explicitly stores the v1 document in `site_name_style.mytitle`.
Legacy properties remain available to older readers.

The UI validates the document and local glyph coverage before saving. It
generates immutable title SVGs and icon PNGs before committing the editable
document and active asset references in one database transaction. Readers obtain
the fields in one statement. The revision is a SHA-256 of the renderer version
and validated document. A changed renderer/catalogue requires a new renderer
revision. Client save requests include `expected_revision` (null for legacy
data); a competing save returns 409. Retrying an identical document is safe.

Generated assets live in persistent branding storage, outside the application
overlay. A failed write or database transaction leaves the prior appearance
active. Unreferenced immutable files may remain after failure; removing them
requires checking active references. Do not delete the previous active files
when publishing a new design.

The dashboard and Control Panel previews render the saved vector design.
Identity sign-in uses the same renderer and local fonts, with escaped plain text
fallback if the artwork is unavailable. Icons and browser/PWA artwork use
immutable raster derivatives. Personal WordArt overrides remain separate from
the shared server title.

Locks and Undo are transient editor state. Undo retains the last 20 design
changes. Changing the name follows the initial automatically chosen monogram
until the user chooses custom letters or another mark. Independent light/dark
sticker colours remain in the document when Match title is selected.
The Sticker Machine's **Match title** checkbox uses the title's light/dark ink
for the mark without replacing its saved independent colours. Unchecking it
restores those colours. Choosing a new sticker colour combination switches back
to independent colours; Undo restores the previous design.

Image drafts accept PNG, JPEG and WebP up to 2 MB and 4096 pixels per side.
Unreadable files show a retryable message and leave the current mark intact.

Renderer tests cover the complete catalogue's font hashes, all presets and
compositions, multilingual glyph coverage and rejection of executable uploads,
unknown symbols, unknown versions and out-of-range controls. They do not establish
browser layout, first-run provisioning, Names verification, installed update or
recovery acceptance. Emoji appearance depends on the rendering platform's emoji
font; the bundled outline lettering fonts do not supply colour emoji.

The header sticker is hidden by default. Administrators can enable **Show sticker
beside the title** in Server Branding. This preference is stored separately from
the title design in `site_name_style.showHeaderLogo`, and applies even when a
person has a lettering override. The sticker remains the favicon either way.

Compact title consumers fit the actual warped lettering and effect bounds. The
resizable title widget fills its width; login artwork stays within its centered
wrapper. Full studio/export canvases preserve their original geometry. Native
app headers receive validated outline artwork through their existing branding
CSS contract, so they do not need fonts or a new permission.

Studio save actions stay visible while scrolling. Randomize sticker is an
accessible icon control; the duplicate legacy colour controls are removed.
Appearance waits for both saved server and personal designs before showing the
editor, so a delayed initial response cannot overwrite typing into a placeholder.
An initial read failure offers a retry without exposing an unsaved default.

Personal Studio documents own both their text and lettering for the signed-in
account. The shared title remains the default for other accounts and public
sign-in. Legacy personal overrides keep their style while following the server’s
name. **Use server title** removes the override and reads the current saved server
appearance; an unsaved administrator draft is never a default.

The shared `resolveTitle` reader is used by dashboard, Timeline, Notifications
and authenticated header APIs, including the Settings bridge. The header sticker
preference always comes from shared branding. Personal changes do not change
server branding or another account.

Confirmed saves and resets invalidate open title consumers in the current
document and same-origin tabs. The notification contains no appearance or account
data; each consumer re-reads through its authenticated API with no-store caching.
Focus, visibility and history restoration also refresh the title, covering changes
made in another browser. Failed saves do not announce a change. Request ordering
prevents an older response from replacing a newer one. No hard reload is needed.

The opt-in `control-panel/tests/title-appearance.browser.mjs` regression runs real
Settings/header/widget components with a local fixture API. It covers account
overrides, shared changes, reset, same-origin tabs, failed saves, delayed initial
appearance and delayed header responses. It supplements installed authenticated
acceptance.

Greeting designs are saved with the account's widget layout. The complete
replacement is validated before changing saved rows, then deleted and inserted
in one transaction. Concurrent replacements for the same account are serialized.
Invalid data or an insertion failure preserves the previous layout and row IDs.
The opt-in `ui/tests/integration/build-widgets.mjs` regression bundles the real
query against a disposable PostgreSQL schema; it covers malformed input, rollback,
concurrent replacement and account isolation without changing application rows.
