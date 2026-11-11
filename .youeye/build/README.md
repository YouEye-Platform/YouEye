# Repository-owned build entrypoints

These executable entrypoints are the component build boundary:

- `spine` emits `spine-linux-amd64`;
- `installer` emits an unsigned, appliance-owned runtime overlay for the
  reversible development deployment lane; it has no independent release version,
  is not an ISO, and is never an independently publishable release;
- `control-panel` and `ui` each emit an uncompressed `standalone.tar` rooted at
  `server.js` (published as `cp-standalone.tar` and `ui-standalone.tar`);
- `appliance` emits the nine appliance/installer outputs plus
  `appliance-manifest.json`, `system-update-manifest.json` and a copy of
  `build-inputs.json`. See `appliance/build/README.md`.

Every entrypoint requires `YOUEYE_SOURCE_DIR`, `YOUEYE_WORK_DIR`,
`YOUEYE_OUTPUT_DIR`, `YOUEYE_SOURCE_COMMIT`, and `SOURCE_DATE_EPOCH`. Git
metadata is optional: when it exists, the supplied commit must match it. Node
builds require pnpm `10.6.2` and always use `--frozen-lockfile`; there is no
unlocked dependency fallback. Entrypoints build only. They never sign, publish,
or accept credentials.

The `appliance` entrypoint additionally requires `YOUEYE_BUILD_INPUTS`, the
`youeye.build-inputs.v1` file naming the exact Spine, Control Panel and UI
artifacts. It uses the builder-local APT cache (`LIVE_BUILD_APT_PROXY`, default
`http://127.0.0.1:3142`) for both `mmdebstrap` and `live-build`; Debian's signed
Release metadata and package hashes remain authoritative.

Release integrity comes from `core-release.json` (`youeye.core-release.v1`,
`authority: "digest"`), written by `scripts/assemble-core-release.py` from the
built artifacts. It binds every artifact by sha256 and size.
