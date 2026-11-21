# System release contract (`core-release.json`)

A YouEye System release is one document, `core-release.json`, plus the files it names. This page describes the
document and what a box does with it: install, check, update, recover. Channels, versions and promotion are in
[releases.md](releases.md).

Releases are unsigned for now. Integrity comes from SHA-256 plus HTTPS with normal certificate checks. Signing
returns before the public Release; the `authority` field is where it will attach.

| Code | Role |
|---|---|
| `scripts/assemble-core-release.py` | writes the document (since 0.6.13 without `build` and member `build_version`, `minimum_reader: 2`, `minimum_release` a line) |
| `releasecache/core_release.go` | the Go reader (`ParseCoreRelease`), used by Spine and the installer |
| `control-panel/src/lib/releases/core-release.ts` | the Control Panel reader; both parse `releasecache/testdata/core-release.json` |
| `spine/internal/systemupdate/core_*.go` | the update engine |
| `installer/scripts/install.sh`, `installer/internal/installer/` | install-time readers |

## The document

Schema `youeye.core-release.v1`. Top-level fields:

| Field | Meaning |
|---|---|
| `schema` | `youeye.core-release.v1` |
| `version` | the release name: `X.Y.Z-dev.N` on dev, `X.Y.Z-alpha.N`, `X.Y.Z-beta.N` or `X.Y.Z` after promotion. What the box shows; never compared |
| `build` | optional, old shape only (documents up to 0.6.12): the dev name of the build, equal to `version` on dev. Checked when present, used for nothing. Absent from 0.6.13 on |
| `tag` | `youeye-v<version>` |
| `source_tree` | the git tree the build came from (40 hex) |
| `sequence` | the build's publish time in Unix seconds, written once and kept by every promotion. With the line of `version` it orders releases ([releases.md](releases.md#ordering-line-then-sequence)) |
| `minimum_reader` | `1` in documents up to 0.6.12 (a 0.6.11 Control Panel accepts only 1); `2` from 0.6.13 |
| `authority` | `"digest"`; nothing else is accepted |
| `compatibility` | `state_min`/`state_max` (1), `data_min`/`data_max` (1), `minimum_release`, `capabilities` (must contain `core-release-v1`) |
| `members` | exactly one member per role, in dependency order |

`minimum_release` is a line (`0.6.12`): a box may install the document when its installed release's line is that
line or later (`MinimumReleaseMet` in `releasecache/order.go`). An old-shape value written as a build name
(`0.6.5-dev.2`) is read as its line. It comes from `.youeye/minimum-release` in the repository. It is not the image
floor: `appliance/recipe.json` `minimum_current_version` (written into `system-update-manifest.json` as
`minimum_current_image_version`) is an image identity that the A/B engine compares with image identities, and it
stays a build name.

Each member has `role`, `source_tree`, `input_sha256`, optional `depends_on`, an `artifact` blob
`{name, sha256, size_bytes, release?}`, and in the old shape `build_version` (the dev name of the build the member's
file came from; optional, checked when present, used for nothing, absent from 0.6.13 on; a member a 0.6.13 or later
document reuses from an older-shape release comes over without it). The `appliance` member
also has a `build_inputs` blob (`build-inputs.json`); no other member may. `input_sha256` is the SHA-256 of the text
`youeye.core-member-input.v1\n<role>\n<source_tree>\n<artifact sha256>\n`.

The 13 roles, in document order:

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
| `spine` | `spine-linux-amd64` | Spine build | no (trial on State) |
| `cp` | `cp-standalone.tar` (depends on `spine`) | CP build | no |
| `ui` | `ui-standalone.tar` (depends on `cp`) | UI build | no |

The reboot column is the list in `spine/internal/systemupdate/core_journal.go`: a release whose `appliance`,
`system-root`, either system UKI, `system-updater`, `internal-recovery` or `recovery-uki` digest differs from the
installed one needs a host restart.

### Parser rules

A reader must be able to read documents published years later, so `ParseCoreRelease` (Go) and `parseCoreRelease`
(Control Panel) are lenient where a later release may add things and strict where a mistake would matter:

- **Read first:** `schema` must be `youeye.core-release.v1`; a higher `minimum_reader` than this reader's
  (`CoreReleaseReader` and `RELEASE_READER`, both 2 since 0.6.12) returns `ErrNeedsNewerReader` /
  `ReleaseNeedsNewerReader` before anything else is read. Reader 2 reads both shapes: documents with `build` and
  member `build_version` (`minimum_reader: 1`) and documents without them (`minimum_reader: 2`). Both parse the
  fixtures `releasecache/testdata/core-release.json` (old shape) and `core-release-no-build.json` (new shape).
- **Ignored:** unknown fields at any level (they are covered by the document digest but never interpreted).
- **"Needs a newer reader":** a role this reader doesn't know (a later release added one).
- **Refused, before any effect:** documents over 1 MiB, duplicate JSON keys at any depth, trailing data, a wrong
  authority, a `tag` that is not `youeye-v<version>`, duplicate or missing roles, invalid versions (including a
  `build` or `build_version` that is present but invalid), trees or digests, a missing or invalid `sequence`,
  `build_inputs` on the wrong member, and any dependency that is missing or not earlier in the list (CP must depend
  on Spine, UI on CP).

It returns the SHA-256 of the exact bytes; that digest is the release's identity. A box that gets "needs a newer
reader" for the channel head takes a stepping stone (below).

### Host independence

The document names files and never locates them. A client downloads `<repository>/releases/download/<tag>/<name>`,
using the repository and tag where it found the document, or `<download_base>/<tag>/<name>` when the channel index
entry names a `download_base` ([releases.md](releases.md)); Spine records the base per tag in
`core-update/download-bases.json` for later blob downloads. A blob's optional `release` names another `youeye-v`
release of the same repository that holds the file; publishing uses it to reuse unchanged image files
(`assemble-core-release.py --reuse`). There is no source, branch, channel, commit or URL inside, so the same
bytes are published on every host a release is promoted to. Downloads follow HTTPS redirects to any host (every
file is checked by SHA-256 and size); leaving HTTPS, credentials, fragments and release-listing APIs are refused.

**Payload digest.** `PayloadSHA256()` hashes `schema`, `minimum_reader`, `compatibility` and the members with every
blob's `release` cleared. All documents of one build (dev, alpha, beta, stable) have the same payload digest:
promotion changes only `version`, `tag` and where the files live. Boxes keep this digest (the version floor) and
compare it across Spines, so **the hashed JSON is frozen**: the field names, their order and which fields are left
out when empty (`build_version` is, so a new-shape member hashes without it) must not change for a document that
exists. `TestPayloadDigestIsFrozen` (`releasecache/core_release_test.go`) pins the digests of both fixtures and the
exact text of an old-shape member and compatibility block.

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
  `/var/lib/youeye-state/core-selection/core-release.json`, after checking its digest (see
  [The recorded selection](#the-recorded-selection)).

## Checking for an update

`youeye update core check` (and Spine `GET /api/appliance/core-update/check`):

1. Reads the channel index of the box's repository and channel ([releases.md](releases.md)).
2. Downloads the `youeye` entry's `core-release.json`, refuses it unless its SHA-256 equals the entry, and checks
   that its `tag` and `version` are the entry's. A `build` in either is not compared.
3. If the box can't install it (its `minimum_release` line is above the installed release's line, or it needs a
   newer reader), takes the newest **stepping stone** of the entry that it can install and that is newer than the
   installed release (`releasecache.ChooseCoreRelease`); with none, it reports that no release of the channel can be
   installed from this version.
4. Prints `release`, `manifest_sha256` and `channel`, plus `"stepping_stone": true`, `channel_head` and
   `head_refused` for a stone, or `"behind": true` and a message when the channel's release is older than the
   installed one (`channel stable offers 0.6.13; this box has 0.6.13-dev.7; waiting for it to catch up`).

What the box holds comes from the committed receipt: its key (line and sequence) and its version, for messages.
Only a box with no receipt yet is a fresh install, which considers the channel head alone and ignores its
`minimum_release` (the installer and first boot say so explicitly, `InstalledRelease{Fresh: true}`). A receipt that
cannot be read is an error, never "nothing installed".

**Never downgrade.** Releases are compared by key, line then sequence, never by name. Two checks enforce it:

- Preparing an update refuses a target with an older key than the installed release
  (`YouEye <target> is older than the installed <installed>; a box never downgrades`); the update check reports it
  as `behind` instead.
- The version floor `core-update/version-floor.json` (`youeye.core-version-floor.v1`) remembers the highest accepted
  release and its payload digest. A release with the same key but a different payload is refused. Cancel, recovery
  and channel changes never lower the floor. The floor is written in both shapes (see below).

**The version floor in both shapes.** Both System slots read this file, and the other slot may hold a Spine up to
0.6.11, which reads only `build` and refuses a floor without it. So Spine from 0.6.12 writes `build` (the document's
`build`, or its `version` when it has none) next to `line`, `sequence` and `version`, plus `payload_sha256` and
`manifest_sha256` as before. A floor written by a Spine up to 0.6.11 has no sequence: Spine takes it from the
floor's document in `core-update/targets/<manifest_sha256>.json`. When that document is gone, a release of the
floor's line is placed by the floor's build name with the old rule (the number after the label; a name without a
suffix last), and a release that names no build is judged by the installed receipt alone and never replaces the
floor, so the floor is never lowered (`core_sequence.go`). The `build` field goes at the Release cleanup.

## The update transaction

State lives in `/var/lib/youeye-state/core-update/`:

| File | What |
|---|---|
| `journal.json` | the one current request: request ID, target digest, phase, steps |
| `targets/<digest>.json` | the frozen target document; the journal must match it |
| `committed.json` | the receipt of the installed release (`youeye update core status` shows it) |
| `version-floor.json` | see above |
| `image-bindings/<appliance sha256>.json` | the image a release's `appliance` member stands for (below) |

Downloads go to `/var/lib/youeye/cache/core-update/` (on Data) and are checked by SHA-256 and size.

**Binding the running image** (`core_image_binding.go`). The document binds the `appliance` member, the image
bundle's `appliance-manifest.json`, by SHA-256. That manifest names the image: `image_version`, `build_id` and
`source_tree`, and the running image's own sealed manifest must name the same three. No build name in the document
takes part. A slot cannot hold the digest of its own bundle manifest, so Spine records the three values on State
once, when the digest-checked manifest is at hand: the installer's bundle (`installer/appliance-manifest.json`) on a
fresh install, or the update cache at `verify-members`. Releases that reuse an image share the record. A missing
record is derived again from those two places only; when neither has it, the update downloads the appliance member
into the cache again (checked against the retained document) before staging and after the reboot into a new image,
because a Spine up to 0.6.11 that staged the release kept no record. The image keeps its own identity
(`image_version`, the image build's dev name): the A/B engine orders images and names boot entries by it. No
release document repeats it and no screen, command output or error message shows it
([releases.md](releases.md)); of the published files only `appliance-manifest.json` and
`system-update-manifest.json` carry it. Their
`release_set` names the Spine, Control Panel and UI the image pins by line, git tree and SHA-256 (since 0.6.13; up
to 0.6.12 by build name), and `build-inputs.json` by tree and SHA-256 only.

The Spine, Control Panel and UI members are identified the same way, by tree and SHA-256: the Spine trial checks
that the service runs the member's binary by SHA-256 ([spine.md](spine.md#spine-only-update-no-reboot)), and the
Control Panel and UI by the `source_tree` in their `version.json` (a build without one, before 0.6.12, by its baked
name). Since 0.6.13 nothing built carries a build name: Spine's own `version` and `version.json`'s are the line.

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
- A metadata-only request installs nothing and downloads nothing. Its `authenticated-health` action first gives
  the Control Panel the promoted document (see [The recorded selection](#the-recorded-selection)) and then runs the
  health checks.
- `verify-members` downloads a member only when its files differ from the installed release's. Where a document
  says a file is stored (`artifact.release`: an alpha document names the dev release, a beta one holds the file
  itself) is not part of the member (`CoreMember.SamePayload`, as in the payload digest), so a promotion or a part
  reused from another release is not fetched again.

**Phases:** `prepared` → `applying` → (`awaiting-restart`) → `committed`, or `needs-recovery` → `recovering` → `rolled-back`, or
`cancelling` → `cancelled`. Only one unfinished request may exist.

**Requests.** Every request has a stable ID chosen by the caller (`--request`). `stage` binds it to the reviewed
document digest (`--manifest-sha256`). Repeating a command with the same ID observes the same request; it never
starts a second one. API calls also carry a delivery ID, so a lost HTTP response can be retried safely.

A failed step is never run again: resuming a request with a failed step keeps it in `needs-recovery`. Cancel it (see
Cancel) or recover it.

**An update that cannot go on restores the previous release by itself** (since 0.6.15). Past its checkpoint an update
holds the platform: the Control Panel and the dashboard are closed, so nobody can press "Restore previous release".
When the coordinator (`activate`, `resume`, the boot unit, the watchdog's `resume`) ends with the request past its
checkpoint and stopped (a step failed, or the request is in `needs-recovery` because a step left no word, for
example after a power cut in the middle of a step), it runs the same recovery as `youeye update core recover`
(`runCoreContinuationToAnEnd`, `spine/internal/cmd/core_commands.go`):

- once per request: a request that already has a recovery graph is only continued, and a recovery that itself
  fails stays in `needs-recovery` for a person;
- after one more look, 15 s later, when no step failed and an outcome was only uncertain: a child that runs after
  all is followed to its end and the update commits;
- only for a step whose child is positively gone (`coreUncertainStep`). A look that failed says nothing about the
  step, and never marks the request `needs-recovery`: when another coordinator holds the action's lock at that
  moment ("native action is owned by another executor"; the boot unit, "Resume" and the console can each start a
  coordinator), when the step's child still runs, or when systemd cannot say (`systemctl show` failed), the
  coordinator looks again every 5 s until the step has an outcome or its child is gone
  (`CoreSystemdRunner.ChildState`). Processes that outlive the child's main process are waited for 10 minutes;
  then the step is given up and the recovery's fence stops them. A child that is gone and left `succeeded` as
  its last word (`ChildSucceeded`) did its work, and only the look failed: the coordinator looks again every
  5 s, and the first look that works records the step and the update goes on. So a failed look never rolls an
  update back. One bound keeps the box from staying held for ever: a step whose success no look at all can
  record for 30 minutes is given up. Each of the two bounds counts from the first look that met its own reason
  (the child gone with `succeeded`; only processes left): looks that failed for longer while the child still ran
  use up neither (the first cut counted both from the first failed look, so a long-running child that then
  succeeded was given up at once). Earlier Spines gave a step up on any error, and two such errors 15 s apart
  fenced a live child and restored the previous release over a healthy update; and until this fix "gone" covered
  a child that had succeeded, so a failed look after its end still restored the previous release;
- never before the checkpoint (nothing is held; the panel offers Cancel), never for an admission that ended early
  (the panel offers Retry and Cancel) and never in a single pass (`--once`).

It writes "the update of request <id> cannot continue (<reason>); restoring the previous release" to standard
error. Earlier Spines left such a request in `needs-recovery` with the box closed until someone ran `recover` over
SSH or on the console.

**A restart that did not happen** (since 0.6.15; `NativeCoreRuntime.RebootAgain`, `core_owed_reboot.go`).
`activate-host` and `recovery-host` end by asking for a restart, and only the next boot says how they went, so a
coordinator that finds one of them `started` with an unknown outcome ends without an error. That left the box
held, with the Control Panel closed, when the restart never came: `systemctl reboot` failed, the shutdown was
called off, the child was killed, or the activation failed before it asked for anything. Now the coordinator
judges such a step when its child is positively gone and was launched in this boot (the machine has not restarted
since), and not within 2 minutes of the child's end or of the last request (a shutdown stops every System update
command within seconds). A child whose main process ended without a last word and left processes in its unit is
waited for 30 minutes from its launch and then judged the same way (the restart, or the recovery's fence, ends
what is left); before, such a step was never judged and the box stayed held. Those 30 minutes count from what the
child left (its launch record) and never from a request made since, so the requests below follow each other after
2 minutes here too (the first cut started the 30 minutes again with every request). Once a request was made, the
2 minutes count from that request alone. A time in the future (the clock was set back) says nothing about how long
ago: the wait it belongs to begins anew from now, so it neither ends at once nor lasts as long as the clock was
set back:

- `activate-host`, the host update is pending in this boot (the new slot is selected for its counted trial boot):
  it asks for the restart again ("the restart that activate-host of request <id> asked for did not happen; asked
  for it again"). Asking again repeats nothing: the next boot decides as before, and a new slot that does not
  come up falls back by itself. After two such requests (the count is kept beside the step's launch record) it
  restores the previous release instead, which needs no restart (the old slot runs) and opens the box again;
- `activate-host`, the host update is not pending (the activation failed or never ran): a restart would boot the
  old slot and prove nothing, so the previous release is restored at once;
- `recovery-host`, its record says `reboot-requested`: the boot selection of the previous slot and the request are
  repeated (both repeat safely). A recovery has nothing to fall back to, so this is not counted out; a record in
  another state is left for a person.

The watchdog (below) starts the `resume` that does this: it judges these two steps like any other, and goes on
starting it (every 30 minutes after the first three) for as long as the restart is owed.

When a request is committed, cancelled or rolled back, Spine runs `systemctl reset-failed` on
its own transient units (`youeye-core-<hash>.service` and `youeye-core-control-<hash>.service`;
`CoreSystemdRunner.ResetFailedUnits`), so they don't stay in `systemctl --failed`. A request in `needs-recovery`
keeps its failed units until it ends.

### The recorded selection

The Control Panel reads the installed release document from
`/var/lib/youeye-state/core-selection/core-release.json` inside `youeye-control`: it takes the dashboard's archive
and the place of that file from it. **After a finished request this file holds the installed release document**
(the one `youeye update core status` shows as `installed.manifest_sha256`):

| When | What is written |
|---|---|
| first deployment | the installed document (`stageCoreSelection`, `spine/internal/container/core_selection.go`) |
| `apply-cp` | the target document, behind the service hold, also when the Control Panel itself is reused (`installCoreServiceSelection`) |
| `authenticated-health` of a metadata-only request (since 0.6.11) | the promoted document, before the health checks, so the Control Panel answers them with it (`RecordPromotedSelection`) |
| `recovery-health` | the container root comes back from the checkpoint; when it holds another document of the previous build, the exact previous document is written before the Control Panel's hold is released (`verifyRecoveredCoreSelection`) |

Each of these steps reads the file first and goes on only when it **stands for the release the box should hold**
(`recordedSelectionStandsFor`, `spine/internal/systemupdate/core_service_selection.go`):

- it is the exact document, byte for byte; or
- it is another document of the same build: this box retains the same bytes in
  `core-update/targets/<their SHA-256>.json` (Spine retained them from the box's own channel), and its payload digest equals
  the expected release's (the same members, files, sizes and compatibility; only the release name and the place of
  the files differ).

Anything else is refused and never overwritten: a document of another build, a document this box never retained,
the same content in other bytes, a file that is not a release document. The errors are "CP selection differs from
retained transition" (`apply-cp`, and the action of a metadata-only request) and "restored CP selection is not the
exact previous release" (`recovery-health`). The checks of files, member digests, markers and machine identity are
unchanged.

**Why another document of the same build is accepted.** A Spine before 0.6.11 committed a metadata-only request
without writing the file, and compared the file byte for byte afterwards. A box that took a build on one channel
and then the promotion of that build on another (for example `0.6.10-dev.3` on dev, then `0.6.10-alpha.1` on alpha)
kept recording the first document. Its next service update exchanged the Control Panel tree and then failed in
`apply-cp`, and `recover` failed in `recovery-health` for the same reason and left the platform held
([troubleshooting.md](troubleshooting.md#a-system-update-is-stuck-or-failed)). A box that only ever followed one
channel is not in this state.

- `apply-cp` runs in the new Spine ([development.md](development.md#compatibility-rules-for-later-changes)), so
  such a box updates from 0.6.10 to 0.6.11 or later without failing, and records the target document afterwards.
- `recover` started after `apply-spine` runs its steps in the new Spine until `recovery-health` returns the box to
  the previous Spine. That first pass accepts the earlier document and writes the exact previous one, so a later
  pass by the previous Spine, which compares bytes, accepts it too. Observing a recovery writes nothing.
- A recovery that runs in a Spine before 0.6.11 from its first step (the update failed in `checkpoint` or
  `apply-spine`, or it was a host update, whose `recovery-health` runs after the previous slot has booted) still
  compares bytes. On a box in this state it stops in `recovery-health`; the two commands in
  [troubleshooting.md](troubleshooting.md#a-system-update-is-stuck-or-failed) finish it.

The promoted document is written by the request's action only. When that action is lost, or refuses a file that
does not stand for the release, the coordinator still judges the request by observing its health, as before, and a
healthy box commits; the file then keeps what it held. An earlier document of the build is accepted by every later
step; a foreign file is refused by the next `apply-cp`.

Tests: `TestCoreServiceUpdateAfterPromotion`, `TestCorePromotionRecordsSelectionOverAnEarlierDocumentOfTheBuild`,
`TestCoreRecordedSelectionRefusesOtherPayloadsAndUnretainedDocuments` and
`TestCoreRecoveryOnAStaleSelectionEndsRolledBack` (`core_selection_promotion_test.go`).

### Installed-file checks

The CP and UI trees in `youeye-control` (`/opt/app`) and `youeye-ui` are checked against the file index of their
archive (`VerifyCoreContainerPayload`, `spine/internal/systemupdate/core_payload*.go`). Every check walks the whole
tree and counts three things: **unrecorded** paths (not shipped), **changed** recorded paths (bytes, mode, link,
type; an unreadable path or one that changes during the read counts as changed) and **missing** recorded paths.
Runtime directories are skipped by every check: `.env`, `.next/cache/` and `.next/server/route-cache/`; an archive
that contains them is refused when it is indexed.

**The rule.** A check that runs in the installed Spine never refuses an update, a recovery or a boot because of the
state of a tree this request did not write. Such a tree (about to be replaced, reused, restored or merely
installed) is checked in **record** mode: the counts go into the evidence, nothing is refused. A tree this request
wrote is checked in **strict** mode: a changed or missing recorded file is refused. Unrecorded paths are counted and
never refused in either mode. In both modes the identity checks stay hard failures: marker, schema receipt,
selection, machine and process identity, a container that is not running, a missing or linked application
directory, a tree that cannot be listed, a container or process that changed during the walk.

| Mode | Where |
|---|---|
| record | `verify-members` (every request); the checkpoint preflight; the installed tree before the exchange and the old tree under the stage name after it; a reused member (its artifact did not change); the restored tree in recovery; `observe` and the status API's observation |
| strict | the freshly extracted stage; the application directory after the exchange; `update core initialize` on a fresh install; the destination of an independent copy |
| strict only for a member this request replaced | `apply-cp`/`apply-ui` start and schema checks (the stage receipt says `swapped` and the artifact changed); `authenticated-health` (not for no-op or metadata-only requests); `recovery-health` is always record |

`TestCorePayloadCheckSitesUseTheDecidedMode` (`core_payload_sites_test.go`) parses the non-test files of
`systemupdate`, `cmd` and `api` and pins the literal mode argument of each payload-check call, per function in source
order: a new call site, a flipped mode or two calls of one function that swap modes fails the test. A call that
passes a computed mode (a `mode` variable, `coreStagePayloadMode(stage)`) is pinned only as that expression; what the
mode functions return is pinned by `TestCoreStageModeFollowsTheStageReceipt`,
`TestCoreHealthIsStrictOnlyForATreeThisRequestWrote` and `TestCoreInstalledHealthModeTable` (in `cmd`).

**What a check reports.** One of three states per member: `verified`, `verified, N extra files` (unrecorded paths
only), or `modified (N changed, M missing)`. Evidence carries counts and reasons, never paths, for example
`verify-members`: `complete scoped membership/cache and previous running host verified; installed cp differs: 3
unrecorded, 1 changed, 0 missing (changed-bytes 1); installed ui verified; continuing`. `authenticated-health`
appends `; installed <role> differs: …` the same way.

**What gates on it.**

- `youeye appliance health` walks the CP and UI files only until `first-deploy/complete` exists (the fresh-install
  gate; strict). On a set-up box it does not look at them, so boot blessing and the health call of an update, a
  recovery or a copy never fail on installed files. The file gate of `authenticated-health` and `recovery-health`
  is `NativeCoreServices.Health`, with the modes above.
- **Lost acknowledgement.** When the exchange of the old and new tree was requested but its result was not
  recorded, the exchange counts as done only when the application directory passes strict against the new index
  **and** (the stage fails strict against the new index, **or** the application directory has no unrecorded
  paths). The old tree is never checked strictly, because it may hold all of the new files.
- **Independent copies** ([independent-copy.md](independent-copy.md)): inventory and `reserve-source` refuse a
  source that is `modified` (extra files are fine) and say so with the counts; `release-source` accepts `verified`
  and `modified`, so a source can always release its hold; `commit` checks the destination strictly.

### Checkpoint and recovery

The checkpoint lets a failed update return to the previous release:

1. **Fence:** settle running native actions, close ingress, hold autostart.
2. **Quiesce:** record each container's power state, stop the owned platform and app containers. PostgreSQL keeps
   running for the database capture.
3. **Capture:** root snapshots of `youeye-control` and `youeye-ui`, ZFS snapshots of the datasets that hold platform
   files, and logical PostgreSQL archives on Data. Capacity is checked first.

The preflight only reads. It walks the installed trees in record mode, so it refuses only when a container's tree
cannot be reached, never because of what the tree holds.

**Waiting for the lifecycle locks.** Activation takes the lifecycle reservation (`core-reservation.json`), which
keeps new app, container and backup work out; the checkpoint then confirms it under the exclusive lifecycle locks.
Ordinary work still holds those locks for moments (the Control Panel's health checker reads the reservation for
every running app every 30 s, and YouEye Names maintenance holds the lifecycle lock through a network call), so the
checkpoint waits up to 60 s for them (`BeginAdmitted`, `core_lifecycle.go`). If they stay busy for the whole wait,
the checkpoint fails as a refused preflight (code `checkpoint_preflight_refused`, evidence "checkpoint preflight
refused before any writer was stopped: other app or platform work kept the lifecycle lock busy …"): nothing was
read, stopped or captured. The coordinator then ends the request by itself, as for any proven preflight refusal
(see Cancel): the phase becomes `cancelled`, the lifecycle reservation is released, the installed release is
unchanged, and the error says "System update stopped before any service was touched: the checkpoint preflight
refused (see the checkpoint step)." Nobody has to press Cancel; the update can be started again
(`TestCoreCheckpointBusyLifecycleLockEndsAsRefusedPreflight`). The recovery fence and the release of the hold at
commit or rollback wait the same way.

`youeye update core recover --request <id>` restores the databases first, then the UI data, then the two core
service roots, recovers the host slot if needed, and checks the previous release's health. The restored trees are
checked in record mode (their identity is bound by the component marker): whatever differences they had before the
update, they have again, and these never refuse a recovery. The restored Control Panel must record the previous
release ([The recorded selection](#the-recorded-selection)). Live configuration, credentials and Pointer's own data
are kept as they are; old secrets are not copied back.

**Old service trees.** Replacing the Control Panel or UI exchanges `/opt/app` with the staged tree, so the old tree
stays next to it under the request's stage name, `/opt/.youeye-core-<sha256(request, role)>`, in `youeye-control`
and `youeye-ui` (about 115–120 MB each). Nothing reads it after the exchange (recovery restores the container root
snapshots). `RemoveFinishedStageTrees` (`core_service_leftovers.go`) removes such trees:

- when a request ends (committed, cancelled or rolled back), after the hold is released;
- from Spine's host maintenance: at API start, 15 minutes later, and daily, which also catches the trees earlier
  versions left (they never removed any) and a container that was stopped at the time.

It acts only while no System request is unfinished (none `prepared`, `applying`, `awaiting-restart`,
`needs-recovery`, `recovering` or `cancelling`, no System or copy reservation, no independent copy in progress),
takes the names only from retained stage receipts (never from a listing), holds the shared lifecycle admission while
it removes, and skips a container that is not running. It is best effort and never changes a request. The disk space
returns only when the checkpoint's container snapshot that still references the tree is gone (see below).

**Old checkpoints** (since 0.6.15; `PruneFinished`, `core_prune.go`). Every update leaves two Incus root snapshots
(`youeye-control`, `youeye-ui`), a held ZFS snapshot of each platform dataset, SQL dumps under
`state/core-checkpoints/<sha256(request)>/` on Data, its downloaded release files
(`/var/lib/youeye/cache/core-update/blobs/`) and, on State, its checkpoint record, action and runner receipts,
continuation receipts and payload indexes. Earlier Spines never removed any of it. Now:

- **Kept:** everything of the current request (the journal), whatever its phase; the last good checkpoint, which
  is the complete (`captured`) checkpoint of the committed request that installed the newest release (ordered by
  line and sequence, never by a clock; after an ordinary update that is the current request, after a promotion, a
  cancelled or a rolled-back request it is an earlier one); every request's journal (`requests/`) and release
  document (`targets/`), which keep a repeated request ID from becoming a new update; the cached files and payload
  indexes of the installed release and of the current request's target and previous release.
- **Removed:** for every other finished request, its Incus snapshots, its ZFS snapshots (hold released, then
  destroyed), its SQL dumps, its checkpoint record and its receipts; cached release files and payload indexes of
  other releases.
- **When:** after a request ends and is released (the coordinator logs one line, "pruned N finished request(s):
  … ; kept the checkpoint of <request>"), from Spine's host maintenance 15 minutes after the API service starts and
  then daily (which cleans a box that earlier Spines updated), and by hand with `youeye update core prune`, which
  prints what was removed, kept and left as JSON.
- **Never** while a request is unfinished (`prepared`, `applying`, `awaiting-restart`, `needs-recovery`,
  `recovering`, `cancelling`), while a System or copy reservation exists, or while a coordinator holds the lock:
  only the current request can be unfinished or rolled back, and then nothing on the box is pruned.
- **The lock.** Pruning holds the coordinator lock for one finished request at a time (deleting its snapshots
  can take a minute) and lets go of it in between; every hold decides again what stays, from what is on the box.
  A stage or cancel that arrives during a hold answers "core update cannot start yet: old checkpoints of finished
  System updates are being removed; try again in a minute" on the CLI (the lock file holds `pruning` for that
  time), and leaves a request to yield beside the lock (`lock.wanted` in the core state directory). The pruning
  looks for it after every request and ends its run there ("left: the rest (a System update or cancel is waiting
  for the coordinator)"); what is left goes in the next run, whose first hold forgets a request nobody came back
  for. So the wait is one old request at most. Through the API (the panel's Update and Cancel) the same action
  waits for that, up to 90 s, trying every half second; only after that it is refused. The Control Panel waits
  150 s for Spine's answer to a System update action (`CORE_UPDATE_ACTION_TIMEOUT_MS`), so it never reports an
  error for a request that Spine stages a moment later. A lock that is held while its file is still empty (the
  pruning writes its mark right after it has taken the lock) is looked at again for 50 ms before it counts as a
  coordinator's ("core update is already running"). Until 0.6.15 one hold covered the whole run, up to 30 minutes
  on a box with many old checkpoints, and the answer was "core update is already running".
- A snapshot is deleted only when it carries the request's own mark (`user.youeye.core-request` on the Incus
  snapshot, `org.youeye:core-request` on the ZFS snapshot). One that does not, or that cannot be deleted, is left
  with its record and tried again the next time (`left` in the answer).

Rules that hold throughout:

- An effect whose outcome is unknown (lost acknowledgement, crash) is observed, never repeated. A failed schema
  request is never retried.
- Maintenance holds (ingress, autostart, lifecycle lock) stay until a verified commit or a verified rollback.
- App, container and backup operations share a lock with the update. Unfinished app work blocks activation until
  it is recovered.

### The hand-over after the Spine step

Every step runs as its own process through the launcher, so the steps after `apply-spine` already run in the new
Spine. The coordinator loop (`update core activate|resume`, the process that advances the journal) stays in the
Spine that started the request until the Spine step is done. In a service update with an `apply-spine` step, once
that step is recorded as succeeded and nothing after it has started, the coordinator:

1. checks that the slot's committed Spine is the release's Spine;
2. asks it, through the launcher, `youeye update core status --can-resume --request <id>`, with a limit of 20 s
   (when the time is up, the question's whole process group is killed). The new Spine builds the runtime its
   `resume` would build and runs `CheckResume` (`core_resume_check.go`): the checks `Advance` makes before its first
   write, in the same order, by reading alone (no independent copy owns the installation, the journal is this
   request, the phase is `applying` with no recovery graph and no step `started` or `failed`, and the executor
   authorises the request). It takes no lock, observes or starts no action and records nothing;
3. hands over only when the answer exited 0 with `can_resume: true`, `can_resume_request` equal to the request,
   and a `transaction` whose `request_id`, `manifest_sha256`, `phase` and every `steps[].name` and `state` equal
   its own journal;
4. then replaces itself (`exec`, same PID and unit) with the launcher running
   `youeye update core resume --request <id>`, so the new Spine coordinates the rest of the request.

The journal and the step list are unchanged; the journal at that point is exactly what a lost coordinator leaves,
and `resume` is the command that continues it (as after a reboot). Every hold of the request is durable state, not
a lock of the process. Anything else (no answer in time, a non-zero exit, `can_resume: false`, an answer about
another request or journal state, an unreadable answer, a failed exec) leaves the request with the installed
Spine, which logs why and finishes it itself. A Spine that does not know `--can-resume` fails on the flag, so it is
never handed a request. A request that is resumed with the Spine step already done, and a recovery, hand over
nothing. The hand-over takes effect from the update after the release that ships it (it runs in the installed
Spine). The commands and fields it relies on are a contract with the next release
([development.md](development.md#compatibility-rules-for-later-changes)).

**The release after a reboot.** When a request is committed (or rolled back), its release restores each
container's autostart setting, removes the power holds, opens the ingress gate and removes the lifecycle
reservation (`ReleaseCompleted`, `core_checkpoint_complete.go`). Until then every held container has
`boot.autostart=false`. A reboot or power cut between the commit and the release therefore leaves them all stopped,
the Control Panel included. The boot unit runs the release, and since 0.6.15 the release starts every container
that ran at the checkpoint and is stopped now (the Control Panel and the dashboard first, PostgreSQL before the
identity check), then finishes as usual and writes "core update: release of request <id>: … started after a restart: <names>" to
standard error (`journalctl -u youeye-core-update.service`). A container that cannot be started, or one that runs although it was stopped at the checkpoint, does not
keep the box closed: the Control Panel's monitor looks after it. Earlier Spines refused such a release with
"original container power intent has not been restored" and the box stayed closed until a console repair.
`recover` on a committed request (CLI and API) runs this release too; earlier it answered "completed core request
cannot roll back".

**A lost continuation.** While a service update is past its checkpoint, the Control Panel and the dashboard are
held, so nothing on screen can continue a request whose coordinator was lost; only a reboot (the boot unit resumes
it) or `youeye update core resume` on the console would. The same holds for a request that reached `committed` or
`rolled-back` but whose release of the holds failed or was cut short. The API service (`api serve`, in the selected
Spine) therefore looks once when it starts and then once a minute (`CoreContinuationWatchdog`,
`core_continuation_watchdog.go`), and starts `youeye update core resume --request <id>` again, through the runner
the Control Panel's resume uses, only when all of these hold:

- the request is lost in one of these ways (the last three and image updates since 0.6.15):
  - **between two steps:** phase `applying` with no recovery graph, the checkpoint succeeded and no step is
    `started` or `failed`. Service and image updates alike (a request that waits for the owner's restart is
    `awaiting-restart`, and the reboot itself is the started step `activate-host`);
  - **finished and not released:** phase `committed` or `rolled-back` (not a no-op or metadata-only request), the
    lifecycle reservation still names this request and manifest, and its checkpoint record's `completion_state`
    is empty, `releasing` or `ready`. The release removes the reservation last, so a reservation that names the
    request proves holds remain; `resume` on such a journal only runs the release, and a second run changes
    nothing;
  - **a started step with nobody behind it:** phase `applying`, a step after the checkpoint is `started` (or the
    checkpoint itself, once it has a checkpoint record), and its action child positively does not run
    (`CoreSystemdRunner.ChildGone`: the child left its last word, or was launched in an earlier boot, or systemd
    has no such unit or the unit has no main process and its cgroup is absent or empty; a unit or cgroup that
    cannot be observed counts as running). The unit keeps `RemainAfterExit=yes`, so a process the child started
    can outlive its main process in the cgroup: such a step counts as lost only after 30 minutes without a change
    (`ChildLingering`), and the continuation then gives it up so that the recovery's fence stops what is left.
    `resume` reads the step's result and continues, or finds none and restores the previous release. A step that
    restarts the machine (`activate-host`, `recovery-host`) is judged the same way since 0.6.15: its child is gone
    once it has asked for the restart, and a box that is still up 5 minutes later, with no System update command
    at work, is not restarting (see "A restart that did not happen");
  - **needs recovery:** the request stopped past its checkpoint (`needs-recovery`, or a failed step) and has no
    recovery graph; `resume` restores the previous release;
  - **a recovery that stopped:** a recovery graph with no failed step, in `recovering` or `needs-recovery`, with
    no action child running; `resume` continues it. A failed recovery step is never run again and stays for a
    person;
- the watchdog itself has seen this same journal state (request and change time, compared as text) for at least
  5 minutes (a monotonic clock; no wall-clock time is compared, so a clock that is corrected after boot changes
  nothing; a live coordinator moves on within seconds). Since 0.6.15 a state that was already there when the API
  service started is watched like any other, from that start on: after a boot the boot unit continues it first
  (it counts as a running command), and when that failed, or only the service was restarted, nobody else would.
  Earlier Spines never touched such a state;
- no process on the host runs an `update core` command;
- fewer than three continuations were started for this situation, the last one at least 5 minutes ago. Between
  two steps and for a release the situation is the journal state (a continuation that fails there leaves the
  journal as it is). A continuation that fails over a started step or a recovery rewrites the journal, so those
  are counted per request and step: three in all, however often the journal changes. Two situations are the
  exception (since 0.6.15): after the three they are started again every 30 minutes, without end.
  - The release of a finished request: it changes nothing when it fails, and until it succeeds the box is closed.
  - A started `activate-host` or `recovery-host` whose restart did not happen. Such a continuation starts and
    repeats no action; it asks `RebootAgain`, which counts the restarts it asked for in its own record. Counting
    an activation out takes three continuations that each get that far, and one that does not (it came within
    the 2 minutes after the last request, or the boot ID could not be read just then) used to use up one of
    exactly three: the box then stayed held with a restart owed. Now it ends in a restart or, for
    `activate-host`, in the restore of the previous release.

  The slow attempts are one delivery made again: they share one command ID, and before each the previous one's
  transient unit and delivery receipt are removed (`CoreControlRunner.Forget`; never while the unit runs, and
  never for a unit that is neither running nor ended, such as one that is starting or stopping: that is left for
  the next look). A box
  that stays closed for weeks therefore keeps four continuation units and receipts per situation, not one more
  every half hour. The first three keep their own, which is what counts them across restarts of the API service.

It starts at most three continuations per situation (one was too few: the release of a finished request does
not change the journal, so one transient failure, such as Incus still busy after a boot, left the box closed).
The attempts are counted by the runner's retained delivery receipts, so a restart of the API service neither
repeats an attempt nor resets the count; a continuation of an unfinished request that is lost a third time is
left for a person, because every further one would start or observe actions again. A finished request is
different: its release changes nothing about what is installed, a release that fails leaves everything as it was
and the next one continues it, and until it succeeds the Control Panel stays closed. So it is tried every 30
minutes for as long as the request holds the platform (earlier, an Incus or a database that was not ready for a
quarter of an hour left the box closed until the next reboot). It never acts on `cancelled`, `prepared`, `awaiting-restart` or `cancelling`, or on a request
whose checkpoint has not begun: a request whose first admission
timed out (the lifecycle lock was busy for 60 s before the checkpoint started) holds nothing, the Control Panel
is open, and the update panel offers "Retry update" and Cancel (see Cancel).

A coordinator started by the API writes its standard error to the system journal (unit
`youeye-core-control-<hash>.service`): the hand-over decision ("handing request <id> over to Spine of YouEye
<version> (sha256 <prefix>)" or
"this Spine keeps coordinating the request: <reason>") and a fatal error can be read there afterwards with
`journalctl -u 'youeye-core-control-*'`. Progress is not written there. Since 0.6.15 the action units
(`youeye-core-<hash>.service`, one per step) write standard error to the journal as well (it was discarded): the
error an action ended with, the same text its result keeps as evidence, also when it could not write that result.

### Cancel

`youeye update core cancel --request <id>` works while only `verify-members` and `stage-host` ran, when the
checkpoint's read-only preflight refused (then nothing was stopped or captured), or when the checkpoint's admission
never ended in a launch (below). It removes only the inactive-slot boot entries and candidate data it created. Once
the checkpoint ran, use `recover`. A failed preparation step
can be cancelled even when activation was already requested; the update panel then shows the failed step, its
reason and Cancel, and no "Resume checks".

A checkpoint whose preflight refused (a checkpoint that could not take the lifecycle locks within 60 s is such a
refusal) is cancelled by the coordinator itself: it proves that the preflight refused before any effect, publishes
`cancelling`, removes what preparation created and ends the request `cancelled`; `recover` does the same for such
a request (the panel's notice for it is below, under Commands and API). Only when that cancellation does not
finish does the request stay `cancelling`; the panel offers Cancel in that state, and Cancel finishes it. Without
the proof, and anywhere else, a failed checkpoint needs `recover`.

**A first admission that timed out** (since 0.6.15). Before the checkpoint's child is launched, the coordinator
takes the lifecycle reservation, waiting up to 60 s for the lifecycle locks. When ordinary work (a long app
operation, Names maintenance) keeps them for the whole wait, the checkpoint step is recorded `started`, its action
says `action_state: retryable`, `stage: admission`, `code: admission_timeout`, `effect_state: not-started`, and
the request waits in `applying` for "Retry update" (`resume`). Nothing was launched and nothing is held. Such a
request can also be cancelled: `cancel` (the panel's Cancel, offered beside "Retry update", also when activation
was requested) and `recover` both end it `cancelled`, on the executor's proof that its own admission receipt says
"ended before launch" and that no checkpoint record exists, and remove the reservation if it is this request's
own. A coordinator that was lost while it waited at this admission (a power cut during the wait) is treated the
same way: its "waiting" record proves that no child was launched, so `resume` (the boot unit) admits the request
again and `cancel` ends it. Earlier Spines refused Cancel ("core update requires lifecycle recovery before
cancellation"), the panel hid it, and only a console `recover` ended the request, by a full recovery of a request
that had changed nothing. A checkpoint that was launched is never cancellable.

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
| `youeye update core prune` | (none; runs by itself, see Old checkpoints) |
| `youeye update core observe` | `GET …/status?observe=1` |

After a reboot `youeye-core-update.service` runs `youeye update core resume --boot`, which continues only the
retained request. The Control Panel reaches these routes through its own
`/settings/api/appliance/core-update/{status,[action]}` routes (`control-panel/src/app/settings/api/appliance/`).

The status answer lists the request's `steps[]` (`name`, `state`, `action_state`, `stage`, `code`,
`effect_state`); once recovery owns the request, these are the recovery steps. Some steps also carry `evidence`, as
one line of printable text of at most 600 characters, with absolute paths (words starting with `/`) replaced by "…"
(`coreStepEvidence` in `spine/internal/api/core_update.go`):

- a `failed` step, in every phase: the reason it failed;
- a `started` step while the phase is `needs-recovery` (its outcome is uncertain): the error its action recorded, if
  any. `CoreSystemdRunner.RetainedEvidence` reads it from the runner's result file only (no systemd query, no lock);
  when there is no result, for example because the child was killed, nothing is shown.

Other steps' evidence is not shown. Once recovery owns the request, `transaction.stopped_step`
(`{ name, state, evidence? }`) names the apply step that stopped the update: the first one that `failed` or was left
`started` (uncertain), with its reason as above. So a rolled-back update still says which step stopped it and why.

The update panel (Settings → System, `core-system-update.tsx`) shows the reason next to an uncertain step and below
a failed one. After a request ended `rolled-back`, or `cancelled` with a failed step, it shows a notice that the
installed release is unchanged, with the step that stopped the update and its reason (`stopped_step`, else the
failed step).

## Read-only observation

`youeye update core observe` checks, without changing anything, that the machine still runs the installed release:
the running image and seed Spine, the CP and UI files against their archives (record mode, see Installed-file
checks), and the completed schema markers. It creates no users, sessions, migrations or jobs. The `state` is:

- `verified`: every shipped file is present and unchanged (extra files are allowed and counted);
- `modified`: a shipped file is changed or missing; `reason` names the counts per member. A modified box still
  updates;
- `pending` (a System request is running) or `unverified` (the installation could not be observed).

`members[]` gives each role's `summary` and `findings` (`unrecorded`, `changed`, `missing`, `reasons`). Only
`observe` prints `findings.paths` (a sample of up to 20 paths, for the operator's terminal; not stored anywhere).
The status API's observation (`?observe=1`, as `installed.observation`) has the same members without paths.

## Older readers and stepping stones

An update always starts in the installed Spine (only after its own Spine step does the new Spine take over), so
there is no bridge that lets an older box run a newer release's checks. When the installed Spine cannot install the
channel's head, the channel index offers a stepping stone: an intermediate release the box can install first, after
which it updates again. Each stone repeats its document's `minimum_release`, `minimum_reader` and (from 0.6.12)
`sequence` so a box can choose without downloading every document; the document must agree. Stones are tried newest
first (line, then sequence); a box takes the newest one whose reader and `minimum_release` it meets and that is
newer than its installed release, so a chain of stones is walked in order and never skipped. A stone from an index
written before 0.6.12 has no `sequence`; its document says it once fetched. Mark stones with
`Tools/release/index stone add`, or make the outgoing head a stone as the new head is written (`--stone-previous`).

The first real use is the walk 0.6.11 → 0.6.12 → 0.6.13
([releases.md](releases.md#stepping-stones-from-0611-to-0613)): 0.6.13 documents need reader 2 and drop `build`,
which a 0.6.11 reader requires, so 0.6.12 (reader 2, documents still in the old shape) is the stone on every
channel.

Rules for later releases:

- Adding a field to the document, a role, or a capability is fine: old readers ignore the field and treat the role
  as "needs a newer reader" (so publish a stone when old boxes must still update).
- Removing a role, renaming a field or changing a field's meaning needs a new `minimum_reader` and a stone.
- Raising `minimum_release` (`.youeye/minimum-release`, a line) needs a stone for boxes below it. Raising the image
  floor (`appliance/recipe.json` `minimum_current_version`, an image identity) does too.
- A State or Data schema bump (a release whose `state_min`/`data_min` excludes older boxes) must also raise
  `minimum_release` and publish a stone that migrates: stones are chosen by `minimum_release` and reader only, so
  a head that refuses a box's schema would otherwise be chosen and then refused at staging.
