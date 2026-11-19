# Development: building, releasing and testing

YouEye is pre-release. Every machine can be reinstalled, and nothing has to stay
update-compatible with older development versions until the first public release.

## Toolchains

| Tool | Version | Why it is exact |
|---|---|---|
| Go | toolchain `go1.24.4` (`spine/go.mod`, `installer/go.mod`; language `1.23.0`) | Go downloads it automatically when the local Go is older |
| Node | **exactly `v24.22.0`** | `scripts/bundle-node-runtime.mjs` (in `control-panel/`, `ui/` and the YouEye-Canvas app template) copies the running `node` binary into the package and checks its SHA-256 |
| pnpm | **exactly `10.6.2`** | Node builds run `pnpm install --frozen-lockfile --offline` against `YOUEYE_PNPM_STORE_DIR`; fill that store once online with `pnpm fetch --store-dir <dir>` |

## Building

The entrypoints in `.youeye/build/` build one component each (see
`.youeye/build/README.md`). Each needs a clean checkout of one commit plus
`YOUEYE_OUTPUT_DIR` and `YOUEYE_WORK_DIR`.

| Component | Where | Notes |
|---|---|---|
| Spine | any Linux | seconds |
| Control Panel, UI | any Linux | a few minutes; Node and pnpm pinned as above. The CP build also runs a set of spec files first. |
| Native apps | any Linux | the app repo's own `.youeye/build/app` |
| Appliance image | **as root** on Debian | needs `mmdebstrap`, `live-build` (`lb`), `ukify`, `xorriso`, `debugfs`, `jq`, `go`, exactly `zstd` 1.5.7, and an APT cache on `127.0.0.1:3142` (`LIVE_BUILD_APT_PROXY`). Takes tens of minutes. |

Every entrypoint needs `YOUEYE_VERSION` (the build version `X.Y.Z-dev.N`; `X.Y.Z` must equal `VERSION`) and builds
from a commit whose git tree identifies the build (`YOUEYE_SOURCE_TREE`). Nothing in the source tree carries the
build number `N`; see [releases.md](releases.md).

The image build takes `YOUEYE_BUILD_INPUTS`, a `youeye.build-inputs.v1` file:

- the Spine, CP and UI artifacts by version, source tree and SHA-256;
- the Debian snapshot and minimum update version, which come from `appliance/recipe.json`.

The image bakes no repository, branch, channel or Market source: the installer records the repository and channel
in protected State, so one image is promoted unchanged through every channel. Pass the Spine you already built as
`YOUEYE_SPINE_FILE`; its SHA-256 must match the inputs.

**Image inputs.** The publish tool rebuilds a part only when its inputs changed: it hashes the git tree listing of
each part's paths and reuses the earlier release's files when the fingerprint is the same. The image's inputs are
`appliance/`, `installer/`, `releasecache/`, `.youeye/build/appliance`, `.youeye/build/installer` and
`.youeye/build/lib.sh`. A change to any of them, even a comment, makes a new image, and an image change reboots
every box into the other slot. Spine (`spine/`, plus `releasecache/` and `appliance/ordering`), the Control Panel and
the UI each have their own inputs and update without a reboot.

## Publishing a System release

1. Put the 15 build outputs in one directory under their asset names:
   - the 12 image outputs (including both manifests and `build-inputs.json`);
   - `spine-linux-amd64`;
   - `cp-standalone.tar`;
   - `ui-standalone.tar`.
2. Run `scripts/assemble-core-release.py --version <X.Y.Z-dev.N> --source-tree <tree> --minimum-release <v>
   --artifacts <dir>` (`<v>` from `.youeye/minimum-release`; `--sequence` defaults to now). It writes
   `core-release.json` and `SHA256SUMS`. When the image did not change, add
   `--reuse <previous core-release.json>=image` (or `=spine`, `=cp`, `=ui`): those members are copied unchanged and
   their blobs name the earlier release that holds the file, so only the rebuilt files need to be in `<dir>`.
3. Create release `youeye-v<version>` (prerelease) in the development repository, upload every file plus
   `installer/scripts/install.sh`, and point the `dev` channel index at it.
4. Promote it to alpha, beta and stable without rebuilding: each promotion writes a new document for the same files
   (copied to GitHub for beta and stable) and moves that channel's index (see [releases.md](releases.md)). Promote
   `youeye` alone (`Tools/release/promote youeye <channel>`), not `all`, until the native apps and Pointer are
   rebuilt in the new document shape: `all` would carry their old-shape dev heads to every channel.

## Installing a development build

On a Proxmox host, as root:

```sh
curl -fsSL https://<forge>/<owner>/YouEye/releases/download/<tag>/install.sh | \
  sh -s -- --repository https://<forge>/<owner>/YouEye --channel dev
```

- **Unattended test installs:** add `--silent --yes --erase-confirmed --vmid <id> --target-storage <storage>
  --iso-storage <storage> --cpu 4 --memory 8192 --target-disk-gb 64`.
- **Native apps and Pointer** come from the box's channel index, like the System. The Market comes from
  `https://market.youeye.me/dev/` on dev and alpha boxes ([market-format.md](market-format.md)).
- **Spine changes** never need a new image: a Spine-only release updates a box in about a minute without a reboot.
  To try a binary by hand, `youeye spine install <file> --sha256 <d> --version <v>` runs it as a trial and rolls
  back if it is unhealthy ([spine.md](spine.md)).

## Tests

| Suite | Command |
|---|---|
| Go | `umask 022` first, then `go vet ./... && go test ./...` in `releasecache`, `spine`, `installer` and `appliance/ordering`. With a group-writable umask (0002) some Spine tests fail with "unsafe … directory". |
| Control Panel | each spec file with `node --import tsx --test <file>` from `control-panel/`, using Node 24.22.0, plus `tsc --noEmit` |
| UI | `pnpm --dir ui run typecheck` |

Where two components exchange a document, a fixture in `contracts/` is written by the producer's test and parsed by
the consumer's real code (`contracts/README.md`). Regenerate it with `YOUEYE_UPDATE_CONTRACTS=1` after an intended
change and run both sides.

## Naming rule

While YouEye is pre-release, nothing first-party is versioned as a second or later variant. A replacement takes the
original name, schema IDs stay `.v1`, and the old reader is deleted rather than kept alongside.

- **Numbers start at 1.** Numeric schema and format versions are `1`; a database migration chain that only fresh
  installs use is squashed into one baseline (Pointer: `0001_baseline.sql`, version 1). The next change after the
  Release adds `0002`.
- **No "legacy" paths.** Code that reads or converts data a fresh install of the current version never produces is
  deleted, not renamed. If current code still produces the data, name the path after what it does.
- **Left alone:** external versions (third-party APIs such as `/api/v3`, Docker manifest media types, Go module
  `/vN` paths, IPv4/v6, OAuth2, HTTP/2), semver release versions, model and product names, and the live YouEye
  Names service's snapshot format.
- **A new manifest field** ships in a YouEye release before any market uses it, and gets a row in the "field, since
  version" table (`control-panel/src/lib/market/app-format/since.ts`). An older Control Panel refuses a field it
  doesn't know, so an app that uses it must say `requires: { youeye: ">=<that version>" }`; the generator refuses it
  otherwise, and older boxes list it as needing a newer YouEye ([market-format.md](market-format.md#building-a-market)).

Check with `git grep -nE '\b[vV][2-9]\b|[._-][vV][2-9]\b|V[2-9][A-Z]|schemaVersion:\s*[2-9]|format:\s*[2-9]|[Ll]egacy'`.

## Compatibility rules for later changes

After the Release every box must keep updating for years, and any feature must arrive by update. Three kinds of code
are never replaced by an ordinary update before they act, so their formats follow fixed rules (the update-readiness
audit, Plan 7):

- **The readers that decide whether to accept the next update** (channel index, release documents, download rules):
  - Add fields freely; readers ignore unknown keys (index, core and product releases), skip unknown index products,
    and fail only the one entry that is invalid.
  - A new core role, a removed role, a renamed field or a changed meaning needs a higher `minimum_reader` and a
    **stepping stone** in the index (`Tools/release/index stone add`, or `--stone-previous` on publish and
    promote), so old boxes install an intermediate release first. The same for raising `minimum_release`
    (`.youeye/minimum-release`, a line) or the image floor (`appliance/recipe.json` `minimum_current_version`, an
    image identity that stays a build name).
  - **Reader 2** (Go `CoreReleaseReader`, CP `RELEASE_READER`, since 0.6.12) reads both document shapes: the old
    one with `build` and member `build_version` (`minimum_reader: 1`; 0.6.12 and earlier) and the new one without
    them (`minimum_reader: 2`; 0.6.13 and later). Releases are ordered by line and `sequence` only; `build` is
    checked when present and never used. Channel index entries keep a temporary `build` for 0.6.11 readers. The
    old shape, the temporary entry field and the 0.6.12 stones go at the Release cleanup (Backlog).
  - Files may move to any HTTPS host: set `download_base` in the index entry. Never require a query string,
    credentials or a release-listing API on a box path.
- **Code frozen on a box** (the seed Spine in each image, the other slot after a rollback, Recovery):
  - Records on State and Data: readers ignore unknown keys and writers keep them (`internal/jsonkeep`); add fields,
    don't bump `schema_version` unless old readers must refuse the file ([spine.md](spine.md)).
  - **Dual-written records (0.6.12 until the Release cleanup).** The other slot may still hold a Spine up to 0.6.11
    (reachable from the boot menu), and a 0.6.11 Control Panel may meet records a newer one wrote, so these records
    carry the old fields next to the new ones:
    - the version floor `core-update/version-floor.json`: `build` next to `line`, `sequence` and `version` (a 0.6.11
      Spine refuses a floor without `build`;
      [core-release-contract.md](core-release-contract.md#checking-for-an-update));
    - the Spine selection `spine/selection.json`: every entry keeps a non-empty `version` (a 0.6.11 Spine drops an
      entry without one) next to `line`, `source_tree` and `described_sha256` ([spine.md](spine.md));
    - product floors (Market install records and Pointer state): `build` next to `line` and `sequence`
      ([product-release-contract.md](product-release-contract.md#never-older-never-different));
    - backup identities: `control_panel_version`, `ui_version` and `pointer_version` next to the release keys
      `release`, `control_panel`, `ui` and `pointer` (below).

    A record written by an older version, without the new fields, is read: its sequence comes from the release
    document it names, and the old build rule is used only when that document is gone. Stop writing the old fields
    only when no supported box can run a reader that needs them.
  - Spine's `GET /api/version` keeps answering the binary's own `version`: a 0.6.11 Spine trial-runs the next Spine
    and compares it. What callers show and compare is its `release` field.
  - Recovery reads only slots, ownership and digests. New Recovery actions are request kinds that the System image's
    `youeye-recovery-apply` implements; list them for the Recovery menu in `recovery/menu.json` on State.
- **Backups:** the CP and Spine exchange `youeye.backup.source.v1` (fixtures in `contracts/spine-cp/`, tested from
  both sides). Since 0.6.12 a backup records the installed releases as `release`, `control_panel`, `ui` and
  `pointer`, each `{version, line, sequence, source_tree}`, next to the old build-name fields. A restore refuses a
  backup made by a newer Control Panel, UI or Pointer (compared by key; the same tree is the same software) or a
  newer State/Data schema. An older backup with build names only is compared by line, and within one line by the
  old build rule only when both sides are dev build names. A 0.6.11 Spine refuses the new fields, so the Control
  Panel sends the store request once more with the old fields only when Spine answers "invalid repository store
  request".
- **Databases:** CP and UI tables change additively only (new columns nullable or defaulted) until they have a
  version table (Backlog).
- **Markets** ([market-format.md](market-format.md)): `market.json` and the index may only grow; readers ignore
  unknown fields, and an entry of an unknown `kind` is listed as needing a newer YouEye. Manifests change behind
  `requires.youeye` and the field-since table. A box never accepts a lower `sequence` from the same address, so a
  market is undone with a new commit, never by publishing an older one. The frozen `market` entry of every channel
  index stays byte for byte ([releases.md](releases.md#the-frozen-market-entry)).
- **Image inputs** (`appliance/`, `installer/`, `releasecache/`, `.youeye/build/{appliance,installer,lib.sh}`; see
  Building) never change in a release that is meant to update boxes without a reboot. Collect such changes for the
  next image release.

**A check that runs in the installed Spine must never refuse an update because of the state of what the update did
not write.** Such a check runs in the Spine that is already on the box, so a mistake in it cannot be fixed by a
release: the box refuses the very update that would fix it. 0.6.8 and 0.6.9 refused every System update once a
browser had loaded the Control Panel's favicon (Next.js cached the response inside the installed tree). Instead:

- record what you find (counts in the step's evidence) for a tree the update did not write, and check strictly
  only what the request itself wrote ([core-release-contract.md](core-release-contract.md#installed-file-checks));
- put a new requirement in the new Spine (from `apply-cp` on, every step runs in it) or in the release document,
  never in a check the old Spine runs first (`verify-members`, the checkpoint preflight).

**`verify-members`, `checkpoint` and `apply-spine` always run in the installed Spine**, and so does the coordinator
until the Spine step is done. A later release may only loosen what they require; anything stricter is checked by
the new Spine after the Spine step, or in the release document. After `apply-spine` the installed Spine hands the
request to the new one ([core-release-contract.md](core-release-contract.md#the-hand-over-after-the-spine-step)),
which makes three things a contract between a release and the next one; keep all of them working in every Spine:

- `youeye update core resume --request <id>` continues a request whose last finished step is `apply-spine`;
- `youeye update core status --can-resume --request <id>` answers, by reading alone, whether this Spine's `resume`
  can continue the request now: exit 0 with `can_resume: true`, `can_resume_request` (the request asked about) and
  the judged `transaction` only when it can; otherwise a non-zero exit with `can_resume: false` and
  `can_resume_reason`. The previous release's Spine asks this before every hand-over, so a release's Spine must
  keep answering it the same way. A Spine that does not know the flag exits non-zero and is handed nothing;
- the answer of `youeye update core status` carries `transaction.request_id`, `transaction.manifest_sha256`,
  `transaction.phase` and `transaction.steps[].name` / `.state` with their current meaning.

A defect in a release's coordinator now shows during the update **to** that release, so the update from the
previous release with a Spine change is part of every release's tests.

**Which Spine runs what** in a service update with a Spine change. Every step is a unit that starts through the
launcher, so it runs the Spine that is current when it starts:

| Piece | Spine |
|---|---|
| `verify-members`, `checkpoint`, `apply-spine` | the installed one |
| `apply-cp`, `apply-ui`, `authenticated-health` | the new one |
| the coordinator | the installed one until `apply-spine` is done, then the new one (0.6.10 and older: the installed one to the end) |
| `recover` started after `apply-spine`: its coordinator, `recovery-fence`, `recovery-paired-restore` and the first pass of `recovery-health` (which returns the box to the previous Spine and then checks the services in the same process) | the new one |
| any later command on that box (`recover` again, `resume`, `status`) | the previous one |
| `recover` of an update that failed in `checkpoint` or `apply-spine` | the installed one, every step |

So what a release's Spine accepts in `apply-cp` and in the first pass of `recovery-health` is decided by the
release, and whatever a second pass of `recovery-health` checks is checked by the previous Spine: a recovery leaves
the box in a state the previous Spine accepts byte for byte (the recorded selection is the example,
[core-release-contract.md](core-release-contract.md#the-recorded-selection)). The update **from a box that took a
promotion as an update** (dev, then alpha, then the next dev build) is part of every release's tests as well.

`TestCorePayloadCheckSitesUseTheDecidedMode` (`spine/internal/systemupdate/core_payload_sites_test.go`) pins the
literal mode argument of each installed-file check call, per function in source order; a computed mode is pinned
there only as its expression, and what the mode functions return is pinned by
`TestCoreStageModeFollowsTheStageReceipt`, `TestCoreHealthIsStrictOnlyForATreeThisRequestWrote` and
`TestCoreInstalledHealthModeTable`. Changing a mode is a deliberate edit of these tests. A framework upgrade that starts
writing into the installed tree is caught by the Control Panel and UI build guard
([releases.md](releases.md#build-guard-control-panel-and-ui)).
