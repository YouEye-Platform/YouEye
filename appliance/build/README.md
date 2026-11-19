# Appliance build

`build-appliance.sh` runs as root and builds the immutable System image, the
Recovery image, the A/B/Recovery UKIs and the hybrid UEFI installer ISO. It has a
single mode and never signs anything.

## Inputs

The Debian snapshot and the oldest image this image may update from
(`minimum_current_version`, an image build name) are pinned in
`appliance/recipe.json`. The build reads the image floor from there and writes it
into `system-update-manifest.json`; tooling copies the snapshot into the build
inputs below.

`BUILD_INPUTS_PATH` (default `appliance/build-inputs.json`, absent from source)
names a `youeye.build-inputs.v1` file, validated by `build-inputs.sh`. It names
the exact Spine, Control Panel and UI artifacts by git tree and sha256, and no
version (since 0.6.13):

```json
{
  "schema": "youeye.build-inputs.v1",
  "debian_snapshot": "20260805T142647Z",
  "components": {
    "spine":         {"source_tree": "<40 hex>", "artifact_sha256": "<64 hex>", "source_date_epoch": 1},
    "control_panel": {"source_tree": "<40 hex>", "artifact_sha256": "<64 hex>", "source_date_epoch": 1},
    "ui":            {"source_tree": "<40 hex>", "artifact_sha256": "<64 hex>", "source_date_epoch": 1}
  }
}
```

`YOUEYE_VERSION` (the image build name `X.Y.Z-dev.N`) and `YOUEYE_LINE` (`X.Y.Z`,
the line in `VERSION`) come from `.youeye/build/lib.sh`. The build name is the
image's internal identity: it is written only as `image_version` in
`appliance-manifest.json` (and in the image) and as `target_image_version` in
`system-update-manifest.json`, because the A/B engine orders and keys images by it
(Plan 12 decision 9). It is never shown. The manifests' `release_set` names each
part by the line, its git tree and sha256.

The build compiles Spine (or reuses `YOUEYE_SPINE_FILE`) with the line and tree in
its ldflags, like `.youeye/build/spine`, and refuses to continue unless its sha256
equals `components.spine.artifact_sha256`. Control Panel and UI hashes are pinned
in the image so first deployment fetches exactly those bytes. `ARTIFACT_KIND=test`
marks a build as test-only. Other optional variables: `OUTPUT_DIR`, `WORK_DIR`,
`LIVE_BUILD_APT_PROXY`, `LIVE_BUILD_ATTEMPTS`, `APPLIANCE_TEST_FAULT`.

## Outputs

Exactly eleven files: `system-root.img.zst`, `internal-recovery.img.zst`,
`system-a.efi`, `system-b.efi`, `recovery.efi`, `youeye-appliance-amd64.iso`,
`youeye-installer-linux-amd64`, `youeye-system-updater-linux-amd64`,
`appliance-manifest.json`
(`youeye.appliance.manifest.v1`), `system-update-manifest.json`
(`youeye.system-update.v1`) and `build-inputs.json`. Both manifests are unsigned
and list their image assets by sha256 and size. The ISO carries the manifests
and build inputs in its `appliance/` payload directory. `core-release.json`
binds the manifests by sha256, so no detached signature exists.

## Reproducibility

Filesystem UUIDs, the ISO GPT GUID and all timestamps derive from the source
commit and `SOURCE_DATE_EPOCH`. System and recovery images use Zstandard 1.5.7,
level 10, one worker and a 27-bit long window. The source pins these parameters
and rejects a different compressor version.
