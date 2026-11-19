# Repository-owned build entrypoints

These executable entrypoints are the component build boundary:

- `spine` emits `spine-linux-amd64`;
- `installer` emits an unsigned, appliance-owned runtime overlay for the
  reversible development deployment lane; it has no independent release version,
  is not an ISO, and is never an independently publishable release;
- `control-panel` and `ui` each emit an uncompressed `standalone.tar` rooted at
  `server.js` (published as `cp-standalone.tar` and `ui-standalone.tar`). Both
  end with the payload guard (`youeye_guard_standalone_payload` in `payload-guard.sh`,
  `payload-guard.mjs`): it requires `isrFlushToDisk: false` in
  `.next/required-server-files.json`, runs a copy of the packaged tree,
  requests every prerendered route, `/favicon.ico`, `/manifest.webmanifest`,
  the icon routes and the sign-in pages, and fails the build (deleting
  `standalone.tar`) when the server added, changed or removed any file in its
  tree, or when `/favicon.ico` or `/manifest.webmanifest` answers other than
  HTTP 200 although the tree ships it. A server that does not come up gets one
  more try (on another port unless the port is fixed, below). The helper is in `payload-guard.sh`, not `lib.sh`,
  because `lib.sh` is an input of the system image. A failure means the app or
  a framework upgrade writes into its installed tree; fix that, never loosen
  the guard (see `docs/releases.md`). The copy listens on the loopback port the
  packaged request proxy calls, when it has one (the Control Panel's calls
  `http://localhost:3000`), and the guard fails when that port is in use on
  the build machine: free the port and build again;
- `appliance` emits the nine appliance/installer outputs plus
  `appliance-manifest.json`, `system-update-manifest.json` and a copy of
  `build-inputs.json`. See `appliance/build/README.md`.

Every entrypoint requires `YOUEYE_SOURCE_DIR`, `YOUEYE_WORK_DIR`,
`YOUEYE_OUTPUT_DIR`, `YOUEYE_VERSION` (the build version `X.Y.Z-dev.N`; its
`X.Y.Z` must equal `VERSION`), `YOUEYE_SOURCE_TREE` and `SOURCE_DATE_EPOCH`, and
exports `YOUEYE_LINE` (`X.Y.Z`). Git metadata is optional: when it exists, the
supplied tree must match `HEAD^{tree}`. The build is identified by its git tree,
which is the same on every host a release is promoted to. The source tree carries
only the line (`VERSION`, `X.Y.Z`); the build number `dev.N` comes in as
`YOUEYE_VERSION`, and the channel names (`-alpha.N`, `-beta.N`, `X.Y.Z`) are given
at promotion, which never rebuilds. Since 0.6.13 nothing built names the build:
Spine's ldflags and the Control Panel's and UI's `version.json` carry the line and
the tree, and `build-inputs.json` trees and sha256 only. The one exception is the
image's internal identity (`image_version` in the image manifests, Plan 12
decision 9; see `appliance/build/README.md`). Node
builds require pnpm `10.6.2` and always use `--frozen-lockfile`; there is no
unlocked dependency fallback. Entrypoints build only. They never sign, publish,
or accept credentials.

The `appliance` entrypoint additionally requires `YOUEYE_BUILD_INPUTS`, the
`youeye.build-inputs.v1` file naming the exact Spine, Control Panel and UI
artifacts by tree and sha256. It uses the builder-local APT cache (`LIVE_BUILD_APT_PROXY`, default
`http://127.0.0.1:3142`) for both `mmdebstrap` and `live-build`; Debian's signed
Release metadata and package hashes remain authoritative.

Release integrity comes from `core-release.json` (`youeye.core-release.v1`,
`authority: "digest"`), written by `scripts/assemble-core-release.py` from the
built artifacts. It binds every artifact by sha256 and size.
