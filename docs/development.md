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

## Publishing a System release

1. Put the 15 build outputs in one directory under their asset names:
   - the 12 image outputs (including both manifests and `build-inputs.json`);
   - `spine-linux-amd64`;
   - `cp-standalone.tar`;
   - `ui-standalone.tar`.
2. Run `scripts/assemble-core-release.py --version <X.Y.Z-dev.N> --source-tree <tree> --minimum-release <v>
   --artifacts <dir>`. It writes `core-release.json` and `SHA256SUMS`. When the image did not change, add
   `--reuse <previous core-release.json>=image` (or `=spine`, `=cp`, `=ui`): those members are copied unchanged and
   their blobs name the earlier release that holds the file, so only the rebuilt files need to be in `<dir>`.
3. Create release `youeye-v<version>` (prerelease) in the development repository, upload every file plus
   `installer/scripts/install.sh`, and point the `dev` channel index at it.
4. Promote it to alpha, beta and stable without rebuilding: each promotion writes a new document for the same files
   (copied to GitHub for beta and stable) and moves that channel's index (see [releases.md](releases.md)).

## Installing a development build

On a Proxmox host, as root:

```sh
curl -fsSL https://<forge>/<owner>/YouEye/releases/download/<tag>/install.sh | \
  sh -s -- --repository https://<forge>/<owner>/YouEye --channel dev
```

- **Unattended test installs:** add `--silent --yes --erase-confirmed --vmid <id> --target-storage <storage>
  --iso-storage <storage> --cpu 4 --memory 8192 --target-disk-gb 64`.
- **Native apps, Pointer and the Market catalog** come from the box's channel index, like the System.
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
- **A new manifest field** ships in a YouEye release before the catalog that uses it: an older Control Panel refuses
  a field it doesn't know, and that app drops out of its catalog.

Check with `git grep -nE '\b[vV][2-9]\b|[._-][vV][2-9]\b|V[2-9][A-Z]|schemaVersion:\s*[2-9]|format:\s*[2-9]|[Ll]egacy'`.

## Compatibility rules for later changes

After the Release every box must keep updating for years, and any feature must arrive by update. Three kinds of code
are never replaced by an ordinary update before they act, so their formats follow fixed rules (the update-readiness
audit, Plan 7):

- **The readers that decide whether to accept the next update** (channel index, release documents, download rules):
  - Add fields freely; readers ignore unknown keys (index, core and product releases), skip unknown index products,
    and fail only the one entry that is invalid.
  - A new core role, a removed role, a renamed field or a changed meaning needs a higher `minimum_reader` and a
    **stepping stone** in the index (`Tools/release/index stone add`), so old boxes install an intermediate release
    first. The same for raising `appliance/recipe.json` `minimum_current_version`.
  - Files may move to any HTTPS host: set `download_base` in the index entry. Never require a query string,
    credentials or a release-listing API on a box path.
- **Code frozen on a box** (the seed Spine in each image, the other slot after a rollback, Recovery):
  - Records on State and Data: readers ignore unknown keys and writers keep them (`internal/jsonkeep`); add fields,
    don't bump `schema_version` unless old readers must refuse the file ([spine.md](spine.md)).
  - Recovery reads only slots, ownership and digests. New Recovery actions are request kinds that the System image's
    `youeye-recovery-apply` implements; list them for the Recovery menu in `recovery/menu.json` on State.
- **Backups:** the CP and Spine exchange `youeye.backup.source.v1` (fixtures in `contracts/spine-cp/`, tested from
  both sides). A restore refuses a backup made by a newer CP, UI or Pointer build or a newer State/Data schema.
- **Databases:** CP and UI tables change additively only (new columns nullable or defaulted) until they have a
  version table (Backlog).
