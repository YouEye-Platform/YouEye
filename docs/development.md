# Development: building, releasing and testing

YouEye is pre-release. Every machine can be reinstalled, and nothing has to stay
update-compatible with older development versions until the first public release.

## Toolchains

| Tool | Version | Why it is exact |
|---|---|---|
| Go | toolchain `1.25.14` (`spine/go.mod`) | Go downloads it automatically when the local Go is older |
| Node | **exactly `v24.22.0`** | `scripts/bundle-node-runtime.mjs` copies the running `node` binary into the Control Panel, UI and native-app packages and checks its SHA-256 |
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
| Appliance image | **as root** on Debian | needs `mmdebstrap`, `live-build`, `ukify`, `xorriso`, `zstd` 1.5.7, and an APT cache on `127.0.0.1:3142`. Takes about 15 minutes on 4 cores. |

Every entrypoint needs `YOUEYE_VERSION` (the build version `X.Y.Z-rc.N`; `X.Y.Z` must equal `VERSION`) and builds
from a commit whose git tree identifies the build (`YOUEYE_SOURCE_TREE`). Nothing in the source tree carries the rc
number; see [releases.md](releases.md).

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
2. Run `scripts/assemble-core-release.py --version <X.Y.Z-rc.N> --source-tree <tree> --minimum-release <v>
   --artifacts <dir>`. It writes `core-release.json` and `SHA256SUMS`.
3. Create release `youeye-v<version>` (prerelease) in the development repository, upload every file plus
   `installer/scripts/install.sh`, and point the `dev` channel index at it.
4. Promote it to alpha, beta and stable without rebuilding: the same bytes are uploaded to the next host and the
   channel indexes move (see [releases.md](releases.md)).

## Installing a development build

On a Proxmox host, as root:

```sh
curl -fsSL https://<forge>/<owner>/YouEye/releases/download/<tag>/install.sh | \
  sh -s -- --repository https://<forge>/<owner>/YouEye --channel dev
```

- **Unattended test installs:** add `--silent --yes --erase-confirmed --vmid <id> --target-storage <storage>
  --iso-storage <storage> --cpu 4 --memory 8192 --target-disk-gb 64`.
- **Native apps, Pointer and the Market catalog** come from the box's channel index, like the System.
- **Spine changes** need a new image today, because the image refuses a Spine that differs from its own. Separating
  Spine from the image removes that.

## Tests

| Suite | Command |
|---|---|
| Go | `go vet ./... && go test ./...` in `releasecache`, `spine`, `installer` and `appliance/ordering`. Several Spine packages expect to run **as root**; as another user about 35 tests fail with "unsafe … directory". |
| Control Panel | each spec file with `node --import tsx --test <file>` from `control-panel/`, using Node 24.22.0, plus `tsc --noEmit` |
| UI | `pnpm --dir ui run typecheck` |

## Naming rule

While YouEye is pre-release, nothing first-party is versioned as a second or later variant. A replacement takes the
original name, schema IDs stay `.v1`, and the old reader is deleted rather than kept alongside.
