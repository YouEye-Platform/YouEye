# System release contract (`core-release.json`)

A YouEye System release is one document, `core-release.json`, plus the files it names. This page describes the
document and what a box does with it: install, check, update, recover. Channels, versions and promotion are in
[releases.md](releases.md).

Releases are unsigned for now. Integrity comes from SHA-256 plus HTTPS with normal certificate checks. Signing
returns before the public Release; the `authority` field is where it will attach.

| Code | Role |
|---|---|
| `scripts/assemble-core-release.py` | writes the document |
| `releasecache/core_release.go` | the Go reader (`ParseCoreRelease`), used by Spine and the installer |
| `control-panel/src/lib/releases/core-release.ts` | the Control Panel reader; both parse `releasecache/testdata/core-release.json` |
| `spine/internal/systemupdate/core_*.go` | the update engine |
| `installer/scripts/install.sh`, `installer/internal/installer/` | install-time readers |

## The document

Schema `youeye.core-release.v1`. Top-level fields:

| Field | Meaning |
|---|---|
| `schema` | `youeye.core-release.v1` |
| `version` | the release name: `X.Y.Z-dev.N` on dev, `X.Y.Z-alpha.N`, `X.Y.Z-beta.N` or `X.Y.Z` after promotion |
| `build` | the build version `X.Y.Z-dev.N`; equal to `version` on dev. The only field used to order releases |
| `tag` | `youeye-v<version>` |
| `source_tree` | the git tree the build came from (40 hex) |
| `sequence` | publish time in Unix seconds |
| `minimum_reader` | `1` |
| `authority` | `"digest"`; nothing else is accepted |
| `compatibility` | `state_min`/`state_max` (2), `data_min`/`data_max` (1), `minimum_release`, `capabilities` (must contain `core-release-v1`) |
| `members` | exactly one member per role, in dependency order |

Each member has `role`, `build_version`, `source_tree`, `input_sha256`, optional `depends_on`, and an `artifact`
blob `{name, sha256, size_bytes, release?}`. The `appliance` member also has a `build_inputs` blob
(`build-inputs.json`); no other member may. `input_sha256` is the SHA-256 of the text
`youeye.core-member-input.v1\n<role>\n<source_tree>\n<artifact sha256>\n`.

The 14 roles, in document order:

| Role | File | Built by | Changes need a reboot |
|---|---|---|---|
| `installer` | `youeye-installer-linux-amd64` | image build | no (install time only) |
| `media` | `youeye-appliance-amd64.iso` | image build | no (install time only) |
| `appliance` | `appliance-manifest.json` | image build | yes |
| `system-update` | `system-update-manifest.json` | image build | no |
| `system-root` | `system-root.img.zst` | image build | yes |
| `system-a-uki`, `system-b-uki` | `system-a.efi`, `system-b.efi` | image build | yes |
| `system-updater` | `youeye-system-updater-linux-amd64` | image build | yes |
| `internal-recovery` | `internal-recovery.img.zst` | image build | yes |
| `recovery-uki` | `recovery.efi` | image build | yes |
| `update-bootstrap` | `youeye-system-update-bootstrap` | image build | no |
| `spine` | `spine-linux-amd64` | Spine build | no (trial on State) |
| `cp` | `cp-standalone.tar` (depends on `spine`) | CP build | no |
| `ui` | `ui-standalone.tar` (depends on `cp`) | UI build | no |

The reboot column is the list in `spine/internal/systemupdate/core_journal.go`: a release whose `appliance`,
`system-root`, either system UKI, `system-updater`, `internal-recovery` or `recovery-uki` digest differs from the
installed one needs a host restart.

### Parser rules

`ParseCoreRelease` refuses, before any effect: documents over 1 MiB, duplicate JSON keys at any depth, unknown
fields, trailing data, a wrong schema, reader or authority, a `tag` that is not `youeye-v<version>`, unknown,
duplicate or missing roles, invalid versions, trees or digests, `build_inputs` on the wrong member, and any
dependency that is missing or not earlier in the list (CP must depend on Spine, UI on CP). It returns the SHA-256
of the exact bytes; that digest is the release's identity.

### Host independence

The document names files and never locates them. A client downloads `<repository>/releases/download/<tag>/<name>`,
using the repository and tag where it found the document. A blob's optional `release` names another `youeye-v`
release of the same repository that holds the file; publishing uses it to reuse unchanged image files
(`assemble-core-release.py --reuse`). There is no source, branch, channel, commit or URL inside, so the same
bytes are published on every host a release is promoted to.

**Payload digest.** `PayloadSHA256()` hashes `schema`, `minimum_reader`, `compatibility` and the members with every
blob's `release` cleared. All documents of one build (dev, alpha, beta, stable) have the same payload digest.

## Install

- `install.sh` reads the channel index, checks `core-release.json` against the index entry's SHA-256, checks the
  `installer` member's SHA-256 and size, and runs it with the tag and the document digest
  ([install.md](install.md)).
- The installer answer (`youeye.appliance.answer.v1`) carries the exact document bytes as `core_release`
  (`manifest_base64`, `manifest_sha256`), base64 so that JSON reformatting cannot change them, and
  `release_policy.core_manifest_sha256` must equal that digest. The installer refuses media whose image manifest
  differs from the `appliance` member, or whose files differ from the matching members
  (`bindCoreInstallBundle` in `installer/internal/installer/core_install_input.go`).
- On State it writes `bootstrap/core-release.json`, `bootstrap/release-policy.json` (`youeye.release-policy.v1`:
  `repository`, `channel`, `core_manifest_sha256`) and `installer/appliance-manifest.json`.
- First deployment records the installed release (`youeye update core initialize`, then `first-boot`) before setup
  opens. Spine also copies the document into `youeye-control` at
  `/var/lib/youeye-state/core-selection/core-release.json`, after checking its digest.

## Checking for an update

`youeye update core check` (and Spine `GET /api/appliance/core-update/check`):

1. Reads the channel index of the box's repository and channel ([releases.md](releases.md)).
2. Downloads the `youeye` entry's `core-release.json` and refuses it unless its SHA-256 equals the entry.
3. Prints `release`, `manifest_sha256` and `channel`, plus `"behind": true` and a message when the channel's build
   is older than the installed build.

**Never downgrade.** Two checks enforce it:

- Preparing an update refuses a target whose `build` is older than the installed build
  ("a box never downgrades").
- The version floor `core-update/version-floor.json` (`youeye.core-version-floor.v1`) remembers the highest accepted
  build and its payload digest. A release with the same build but a different payload is refused. Cancel, recovery
  and channel changes never lower the floor.

## The update transaction

State lives in `/var/lib/youeye-state/core-update/`:

| File | What |
|---|---|
| `journal.json` | the one current request: request ID, target digest, phase, steps |
| `targets/<digest>.json` | the frozen target document; the journal must match it |
| `committed.json` | the receipt of the installed release (`youeye update core status` shows it) |
| `version-floor.json` | see above |

Downloads go to `/var/lib/youeye/cache/core-update/` (on Data) and are checked by SHA-256 and size.

**Kinds of update** (`coreJournalStepNames`):

| Kind | When | Steps |
|---|---|---|
| no-op | the target is the installed document | `verify-members`, `authenticated-health` |
| metadata-only | different document, same payload digest (a promotion of the installed build) | `verify-members`, `authenticated-health` |
| service | Spine, CP or UI changed, no host part | `verify-members`, `checkpoint`, [`apply-spine`], `apply-cp`, `apply-ui`, `authenticated-health` |
| host | a host part changed | `verify-members`, `stage-host`, `checkpoint`, `activate-host`, `host-health`, `apply-cp`, `apply-ui`, `authenticated-health`, `commit-host` |

- `stage-host` writes the image to the inactive slot and checks it; nothing restarts yet.
- `checkpoint` runs only when the owner activates, not at staging time.
- `apply-spine` runs the target Spine as a trial on State and commits it when healthy ([spine.md](spine.md)).
  In a host update the new slot simply selects the release's Spine.
- `activate-host` arms the new slot for a counted trial boot (three attempts); `commit-host` makes it the
  known-good default.
- `apply-cp` and `apply-ui` replace the container payloads from the verified archives and run their schema step
  once; a completed schema receipt is never replayed.

**Phases:** `prepared` → `applying` → (`awaiting-restart`) → `committed`, or `needs-recovery` → `recovering` → `rolled-back`, or
`cancelling` → `cancelled`. Only one unfinished request may exist.

**Requests.** Every request has a stable ID chosen by the caller (`--request`). `stage` binds it to the reviewed
document digest (`--manifest-sha256`). Repeating a command with the same ID observes the same request; it never
starts a second one. API calls also carry a delivery ID, so a lost HTTP response can be retried safely.

### Checkpoint and recovery

The checkpoint lets a failed update return to the previous release:

1. **Fence:** settle running native actions, close ingress, hold autostart.
2. **Quiesce:** record each container's power state, stop the owned platform and app containers. PostgreSQL keeps
   running for the database capture.
3. **Capture:** root snapshots of `youeye-control` and `youeye-ui`, ZFS snapshots of the datasets that hold platform
   files, and logical PostgreSQL archives on Data. Capacity is checked first.

`youeye update core recover --request <id>` restores the databases first, then the UI data, then the two core
service roots, recovers the host slot if needed, and checks the previous release's health. Live configuration,
credentials and Pointer's own data are kept as they are; old secrets are not copied back.

Rules that hold throughout:

- An effect whose outcome is unknown (lost acknowledgement, crash) is observed, never repeated. A failed schema
  request is never retried.
- Maintenance holds (ingress, autostart, lifecycle lock) stay until a verified commit or a verified rollback.
- App, container and backup operations share a lock with the update. Unfinished app work blocks activation until
  it is recovered.

### Cancel

`youeye update core cancel --request <id>` works while only `verify-members` and `stage-host` ran, or when the
checkpoint's read-only preflight refused (then nothing was stopped or captured). It removes only the inactive-slot
boot entries and candidate data it created. Once the checkpoint started, use `recover`.

## Commands and API

| CLI | API (Spine socket) |
|---|---|
| `youeye update core status` | `GET /api/appliance/core-update/status` |
| `youeye update core check` | `GET /api/appliance/core-update/check` |
| `youeye update core stage --request <id> --manifest-sha256 <sha>` | `POST …/stage` |
| `youeye update core activate --request <id>` | `POST …/activate` |
| `youeye update core resume --request <id>` | `POST …/resume` |
| `youeye update core recover --request <id>` | `POST …/recover` |
| `youeye update core cancel --request <id>` | `POST …/cancel` |
| `youeye update core observe` | `GET …/status?observe=1` |

After a reboot `youeye-core-update.service` runs `youeye update core resume --boot`, which continues only the
retained request. The Control Panel reaches these routes through its own
`/settings/api/appliance/core-update/{status,[action]}` routes (`control-panel/src/app/settings/api/appliance/`).

## Read-only observation

`youeye update core observe` checks, without changing anything, that the machine still runs the installed release:
the running image and seed Spine, the CP and UI files against their archives, and the completed schema markers. It
reports `unverified` or `pending` when it cannot prove that. It creates no users, sessions, migrations or jobs.

Installed-file checks ignore runtime files that are not code: `.env` and `.next/cache`, and Next.js's cached
`manifest.webmanifest` response under `.next/server/route-cache/` (only that exact route, only regular non-executable
files; `core_response_cache.go`).

## Older readers

When an installed Spine cannot read a newer release, the target release's own coordinator can be used:

```sh
youeye-system-update-bootstrap --core https://<repository>/releases/download/<tag>/core-release.json \
  --sha256 <core-release.json digest> [--inputs <protected dir>] [--activate]
```

It requires `authority: "digest"` and the exact digest, downloads only the `spine` member (or its `blob-<sha256>`
copy next to the document after an HTTP 404), checks its size and SHA-256, keeps both under
`/var/lib/youeye-state/core-update/bootstrap/<artifact-sha256>/`, and runs
`youeye update core bootstrap --request stable-bootstrap-<digest> --manifest-sha256 <digest>`. A runtime-only
drop-in under `/run/systemd/system/youeye-core-update.service.d/` points the boot continuation at it. It never
replaces the image's Spine. Rerunning the same command after an interruption continues the same request.

`youeye api serve --core-reader <path> --core-reader-manifest-sha256 <sha>` is the same bridge for the API (for a
temporary, runtime-only override of `youeye.service`): the reader must sit at its `core-update/bootstrap/` path next
to the exact document, `check` refuses any release with another digest, and only an owner's `stage` registers the
reader and starts the update (`spine/internal/cmd/core_api_reader.go`).
