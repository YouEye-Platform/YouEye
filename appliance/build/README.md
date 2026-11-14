# Appliance build

`build-appliance.sh` runs as root and builds the immutable System image, the
Recovery image, the A/B/Recovery UKIs and the hybrid UEFI installer ISO. It has a
single mode and never signs anything.

## Inputs

The Debian snapshot and the oldest version this image may update from are pinned in
`appliance/recipe.json`; tooling copies them into the build inputs below.

`BUILD_INPUTS_PATH` (default `appliance/build-inputs.json`, absent from source)
names a `youeye.build-inputs.v1` file, validated by `build-inputs.sh`:

```json
{
  "schema": "youeye.build-inputs.v1",
  "version": "0.6.0-dev.1",
  "debian_snapshot": "20260805T142647Z",
  "minimum_current_version": "0.5.6",
  "release_source": "https://github.com/YouEye-Platform/YouEye",
  "release_branch": "dev",
  "market": {"source": "https://github.com/YouEye-Platform/Market", "branch": "main", "commit": "<40 hex>"},
  "components": {
    "spine":         {"version": "...", "tag": "youeye-v...", "source_commit": "<40 hex>", "artifact_sha256": "<64 hex>", "source_date_epoch": 1},
    "control_panel": {"version": "...", "tag": "youeye-v...", "source_commit": "<40 hex>", "artifact_sha256": "<64 hex>", "source_date_epoch": 1},
    "ui":            {"version": "...", "tag": "youeye-v...", "source_commit": "<40 hex>", "artifact_sha256": "<64 hex>", "source_date_epoch": 1}
  }
}
```

The build compiles Spine (or reuses `YOUEYE_SPINE_FILE`) and refuses to continue
unless its sha256 equals `components.spine.artifact_sha256`. The Spine version in
`spine/internal/cmd/root.go` must equal `components.spine.version`. Control Panel
and UI hashes are pinned in the image so first deployment fetches exactly those
bytes. The image channel follows the version suffix (none = stable, `-beta.N` =
beta, otherwise development); `ARTIFACT_KIND=test` marks a development build as
test-only. Other optional variables: `OUTPUT_DIR`, `WORK_DIR`,
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
