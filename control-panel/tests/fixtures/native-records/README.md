# Native app records from before 0.6.20 (YE-142)

What a box at YouEye 0.6.15 to 0.6.18 holds for a native app it installed from its channel index, for the tests of
the move to the Market (`update-native-move.spec.ts`).

**Captured** on a test box (bykapc VM 380, 2026-11-24): installed with `install.sh --release-tag youeye-v0.6.15`
from GitHub stable, Notes installed on 0.6.15; System update to 0.6.16 (the stepping stone), Wiki installed; System
update to 0.6.18, Search installed. Stable's update path never stops at 0.6.17.
- `notes-0.6.15.*`, `wiki-0.6.16.*`, `search-0.6.18.*`: `install.json` (`/var/lib/youeye/app-<app>/install.json` in
  `youeye-control`), `installed-app.json` (the app's entry in `installed-apps.json`) and `registration.json`
  (`youeye_ui.apps.manifest`: the compiled release contract with its frozen source). The records did not change
  across the later updates apart from `updatedAt`.
- Scrubbed: every value under a key naming a token, secret, password or key, and JWT-shaped strings
  (`ye142-capture.sh` in the session folder). Nothing matched: `env_mapping` holds `${…}` templates only. No env
  file or secret file was copied. The ids are random UUIDs of a destroyed box.

**Built** from the tag code (youeye-v0.6.17-alpha.1 `engine.ts`) for an alpha box, which a stable box cannot show:
`wiki-0.6.17.*`, a Forgejo `v0.6.4-alpha.1` receipt and a channel update recorded (`installedTag`, `channelSource`);
the Forgejo host is written `forgejo.example` (public release hygiene).

`<app>-<tag>.product-release.json` and `.youeye-app.yaml` are the real release documents (GitHub v0.6.4; Forgejo
Wiki v0.6.4-alpha.1); the market copies in the spec are made from them as `Tools/market/native-pin` makes them.
