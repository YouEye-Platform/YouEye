# Core release identity

Releases are unsigned for now. Integrity comes from SHA-256 plus HTTPS with
normal certificate checks. Signing returns before the first public release; the `authority` field marks
where it will attach.

## The release document

The System release document is `youeye.core-release.v1`, published as the
release asset `core-release.json` (reader: `releasecache/core_release.go`,
writer: `scripts/assemble-core-release.py`; the Control Panel reader parses the
same fixture, `releasecache/testdata/core-release.json`). Top level: `schema`,
`version` (the release name: `X.Y.Z-dev.N` on dev, `X.Y.Z-alpha.N`,
`X.Y.Z-beta.N` or `X.Y.Z` after promotion), `build` (the build version
`X.Y.Z-dev.N`; equal to `version` on dev; the only field ordered when deciding
"newer" or "older"), `tag` (`youeye-v<version>`), `source_tree` (the git
tree of the build), `sequence` (publish time), `minimum_reader` (1), `authority`
(only `"digest"` is accepted), `compatibility` and `members`.

Exactly 14 roles are required: `installer`, `media`, `appliance`,
`system-update`, `system-root`, `system-a-uki`, `system-b-uki`,
`system-updater`, `internal-recovery`, `recovery-uki`, `update-bootstrap`,
`spine`, `cp` and `ui`. Each member records `role`, `build_version`,
`source_tree`, `input_sha256`, optional `depends_on` and an `artifact` blob
(`name`, `sha256`, `size_bytes`, optional `release`). The `appliance` member
also has a `build_inputs` blob (`build-inputs.json`); no other role may. Unknown
fields, duplicate JSON keys (at any depth), unknown or duplicate roles, missing
members, cycles and malformed identities fail before any effect. CP depends on
Spine and UI on CP.

The document is **host-independent**: it names assets and never locates them.
A client downloads `<repository>/releases/download/<tag>/<name>`, where the
repository and tag are where it found the document; a blob's optional `release`
names another `youeye-v` release of the same repository (to reuse unchanged
files). There is no source, branch, channel, commit or URL inside, so the same
bytes (and digest) are published on every host a release is promoted to. See
[releases.md](releases.md).

## Root of trust

`ParseCoreRelease` validates structure and returns the exact-byte SHA-256. That
digest is the root of trust:

- The installer gets `core-release.json` through the channel index (whose entry
  names its digest), and records the digest as `core_manifest_sha256` in the
  protected State release policy
  (`/var/lib/youeye-state/bootstrap/release-policy.json`, with the box's
  `repository` and `channel`) beside the bytes (`bootstrap/core-release.json`).
  Spine reads that selection only when the digest matches
  (`ReadAcceptedCoreSelection`).
- An update reads the channel index of the box's repository and channel, checks
  the document against the index digest, then freezes its digest in the update
  journal and the protected `targets/<digest>.json` copy.
- Everything below is bound by SHA-256 and size: member artifacts, the
  `appliance-manifest.json` and `system-update-manifest.json` image manifests
  (the `appliance` and `system-update` member artifacts), and the image payloads
  listed in those manifests. Neither image manifest has a `trust` key; both name
  the build by `source_tree`.

Version ordering, `minimum_release` and the State/Data compatibility ranges still
apply. A box never installs an older version than the one it has: the update
check reports a channel that is behind, and the version floor
(`core-update/version-floor.json`) refuses older or same-version-different-digest
releases.

## Installer answer and installed State

Answer media uses `youeye.appliance.answer.v1`, the only accepted answer schema.
Its fields are `schema`, `operation`, `transaction_id`, `target_serial`,
`erase_confirmed`, `network`, `release_policy`, `development_access`, optional
`authorized_keys`, optional `release_cache_sha256` and optional `core_release`
(`manifest_base64`, `manifest_sha256`). `core_release` carries the exact
`core-release.json` bytes, base64-encoded so JSON reformatting cannot change
them; `release_policy.core_manifest_sha256` must equal its digest. There are no
signature fields. Installer progress uses `youeye.installer.progress.v1` for both
the installer and first deployment.

The installed State receives `bootstrap/core-release.json`,
`bootstrap/release-policy.json` and `installer/appliance-manifest.json`. No
detached signature file is written. Spine checks the running immutable image separately
from CP/UI member selection; the installed appliance manifest must equal the
`appliance` member artifact digest. The CP container receives only
`/var/lib/youeye-state/core-selection/core-release.json`.

New media carries a `core-selection-required` capability marker. Interactive,
seeded and answer-file installs freeze the complete selection before disk
writes, by digest. The selected release must contain the exact image manifest
and baked Spine; image version alone is not sufficient.

## Updates

First deployment stages only the CP/UI artifacts in the protected
content-addressed cache and checks their digests before deriving installed file
indexes. Existing corrupt blobs fail closed; missing blobs use constrained HTTPS
retrieval. GitHub release downloads may redirect only to
`objects.githubusercontent.com` or `release-assets.githubusercontent.com`;
cross-origin hops strip authorization and cookies.

A new release with identical members, dependency graph and compatibility uses a
metadata-only transaction: it checks sequence, installed files and service
health, then commits the release receipt without downloading payloads. Changed
members take the normal update path. Host staging downloads the
`system-update-manifest.json` member, requires its digest to equal the member,
and requires every host payload in it to equal the corresponding member. The
durable host journal binds the release digest; activation re-reads the
protected copy.

Native action intent is persisted before execution. Action IDs bind the target
manifest permanently, with process boot/start identity and retained results.
Action and continuation ownership checks accept systemd's empty representation
of the host root working directory as well as `/`, while requiring explicit
empty RootDirectory and RootImage observations. Missing properties, alternate
working directories and isolated roots remain rejected.
An uncertain action cannot become absent merely because its process disappeared;
only the native operation's exact retained evidence can establish completion.
Track discovery bypasses the frozen installation transport cache and still uses
the selected provider or verified distribution. An explicit tag and
manifest digest may resolve an unpublished candidate from protected media. If
that exact tag is absent from the snapshot, discovery checks the live source;
it never silently substitutes the installed release. Network or verification
failures do not turn a tracking selection into a stale offline selection.

Complete staging verifies each role and reserves sufficient free cache capacity,
while identical blobs share protected content-addressed storage.

The first shared installed receipt binds installation/device/disk/partition
identities, exact retained selection and native deployment evidence. First boot
records it after media, service membership, static installed file checks,
operational health and bridge/CLI credential binding checks. This initial setup receipt does not claim later
administrator/user acceptance or a completed update/recovery test. A no-op update
revalidates members and health without checkpointing or applying migrations.

Before setup completes, its owner session reads installed System status through
the onboarding API. Settings aliases remain outside that session's authority;
the wizard does not weaken session policy or require publication to read the
native committed receipt.

Fresh UI startup completes its durable schema attempt before HTTP readiness,
bound to its exact protected `install-<manifest SHA-256>` marker. Database
connectivity is checked before migration intent; changed markers and uncertain
attempts fail closed. Completed attempts remain no-ops across process restarts.
Builds and legacy runtimes do not use this fresh startup path; update/recovery
markers remain under the native coordinator's explicit schema action.

Fresh managed deployment binds UI to the existing PostgreSQL credential before
starting its service. It creates only an absent `youeye_ui` database, verifies
its owner, and verifies a protected environment against the exact UI marker.
Saved configuration takes precedence. It creates no user, OAuth client or
session secret: the setup wizard retains that work. The UI startup hook owns
the once-only schema receipt; bootstrap does not run a parallel SQL schema.

The System selection is not a release channel. It is derived only from the
protected installer-recorded `release-policy.json` and the `core-release.json`
it accepted: the same source, the case-sensitive raw branch of the recorded
track (no fallback), or the exact tag and digest for an exact installation. The
Spine API refuses writes to the core channels (`default`, `spine`, `control`,
`ui`) and to `system`, so the Control Panel can read but never choose what the
host installs; only `app:<id>` channels are writable there. Initialization
preserves owner pins; CP/UI member pins stay frozen when System follows a track.
Discovery uses sequence within the selected branch, rejects conflicting
sequences and never ranks by timestamps. A release that lacks
`core-release.json`, returns HTTP 404 for it, or whose document does not parse
is skipped; any other error stops discovery.

Core checkpoint admission shares a kernel read/write lock with ordinary app,
container and inventory work. Active operations must settle, and unfinished app
receipts require recovery before activation. A protected durable reservation
continues exclusion after process loss or reboot; only the matching committed
core journal and installed machine receipt permit normal release of that hold.
A checkpoint whose read-only preflight refused (`checkpoint_preflight_refused`, no
checkpoint record written) ends the request as `cancelled` on resume, recover or
cancel and releases the hold; nothing was stopped or snapshotted.
Native backup and all system-container entry points retain the same shared lock.
Interrupted backup and container-maintenance records block activation as well.

Checkpoint and recovery-fence admission take place before native action launch.
They wait at most 60 seconds, respect caller cancellation, and revalidate current
transaction identity and policy under exclusive admission. A separate admission
gate prevents new ordinary operations from overtaking the waiting System writer;
already admitted nested operations retain their original lease until cleanup.
This fairness gate requires compatible CP/native writers. Older CP readers still
share the lifecycle lock and are safely bounded by the timeout, but do not honor
the new gate until upgraded.

The executor records admission intent before waiting. A positively recorded
pre-launch rejection, timeout or cancellation may retry admission on an explicit
Resume of the same request. Every retry repeats policy and unfinished-work checks;
it cannot bypass an app, container or backup recovery obligation. The continuation
returns after an admission timeout instead of automatically retrying indefinitely.
A lost process, absent child or incomplete receipt is unknown, not retry proof.
Once launch begins, the existing no-replay rule applies. Native execution-entry
intent and allowlisted stage/error codes survive acknowledgement loss without
retaining subprocess output; execution entry does not establish completed effects.
System displays waiting/retry status using these sanitized diagnostics. Durable
reservations remain until independently verified commit or recovery.

Component process startup does not prove HTTP readiness. Before the first schema
request, the native coordinator bounds read-only connection/502/503/504 probes
to two minutes and rechecks current authority and component identity each time.
For a pending CP schema, that probe also executes a read-only database query
through CP's configured Incus transport. Incus's Unix socket and container
autostart can be ready before its bridge-bound HTTPS listener; an HTTP response
from CP alone cannot authorize the schema write. This probe creates no migration
receipt and leaves started or uncertain attempts untouched.
Authorization failures and mismatched receipts fail closed. A failed schema POST
is never retried: its outcome can be uncertain even without a response. Retained
diagnostics distinguish response availability, request rejection and identity
mismatch without storing credentials or subprocess output.

Paired recovery has a separate frozen action graph: fence writers/native effects,
restore the paired state and service payloads, recover the host where required,
then verify prior-release health. It authorizes current recovery policy separately
from the failed target. Lost acknowledgements cannot replay restoration; unknown
outcomes retain the hold. A durable target commit cannot become rollback merely
because its journal acknowledgement was lost. Only exact verified rollback and
the unchanged prior machine receipt can release the recovery hold. Concrete
checkpoint/provider actions and installed fault acceptance remain separate gates.

Explicit recovery can continue unfinished final-health substeps after the original
native child has settled. It holds the action, launch and child leases, verifies
the exact retained invocation and empty cgroup, and rechecks current recovery
authority, machine identity, reservation, provider settlement and container holds.
The original child result is retained unchanged. Only service/container starts
without a previous start intent may begin; attempted starts require positive
readback and are never repeated. This path cannot replay schema, paired restore,
host recovery or commitment. Read-only observation cannot begin pending substeps.
Sanitized diagnostics distinguish restored-service, platform-power and
authenticated-health failures; missing evidence remains unfinished recovery.

CP/UI static file indexes derive from exact role-archive bytes.
Native observation checks all files, links, modes and added paths rather than
trusting package version labels. Runtime environment files and Next's cache are
outside the code identity. New UI installations place uploaded branding,
user images and avatars in mounted `/var/lib/youeye/ui-data`, included in core
backup. Image URLs are preserved by data-serving routes. This changes fresh
installation inputs; it does not move files on existing owner machines.

Native payload and protected metadata writes remain anchored to the exact
container filesystem descriptors. On an idmapped mount, a host identity may
be unmappable even though reads succeed. Only an `EOVERFLOW` namespace-write
rejection may retry the same syscall using the verified parent directory's
mapped owner, on an isolated locked thread. Restore and check the original
filesystem credentials before returning the thread; retire it if restoration
cannot be proved. This does not enter a container namespace, run container
executables, relax exclusive creation/no-follow rules, or replay an uncertain
extraction. Journal writes and all later verification retain host authority.

Native checkpoint inventory binds the current machine, exact container UUIDs,
original power/autostart intent, installed app ownership and explicit ZFS file
coverage. Foreign workloads, unsettled lifecycle records and uncovered nested
datasets fail preflight. Core PostgreSQL observation requires closed writers and
supported ownership. Private role/ACL/security rows stream into fingerprints;
changed authority blocks historical restore rather than reviving old grants.
Pointer stays independently versioned, so the core never migrates its database.
These observations are provider preflight, not completed checkpoint capture.

Native quiescence first saves original power intent and binds the coordinator's
active checkpoint step. It checks actual appliance partitions, installs an owned
ingress gate, disables autostart and holds core systemd units across restart.
Only frozen owned container UUIDs can be stopped. Re-entry observes existing stops
and preserves originally stopped applications. The shared PostgreSQL engine stays
running for logical capture. Quiesced is not checkpointed or accepted: snapshots,
database archives and their restore verification are separate required actions.
Control Panel/ID defer background writers while the durable core hold exists;
startup resumes after the host releases a verified commit/recovery hold.

Status APIs expose bounded release/transaction summaries and whether a machine
binding exists, never its raw installation/disk/partition identifiers. A retained
receipt explicitly reports that it is not a fresh payload observation.

This document defines the source data contract. Producer, installed coordinator,
publication and actual installation acceptance are separate integration gates;
the presence of this contract does not establish a released or installed update.

Native root capture freezes each expanded root pool and verifies it again before
snapshots. Admission includes complete checkpoint and restore copies plus the
expanded target payload; shared pool free space is not counted twice. Both paths
use the same validated CP/UI payload indexes to derive a positive expanded
budget for root capture as for complete admission; a passed admission never
permits an unspecified capture budget. Creates record intent first and use
non-expiring exact names. A lost acknowledgement can
reconcile an owned, unchanged snapshot; absence after intent remains unknown and
never automatically replays creation. Root snapshots alone are not the complete
paired checkpoint: logical database archives, persistent files, restore and
installed acceptance must also succeed.

Persistent capture records the exact ZFS GUID and a request-bound user property,
then retains a snapshot hold. It rejects changed mount coverage, foreign
snapshots and uncertain creation instead of repeating effects. SQL capture
streams bounded custom archives to protected Data storage, verifies successful
archive hashes and records durable per-database receipts. Partial/unknown output
is retained for recovery, never overwritten or silently recaptured. Final capture
rechecks closed writers, current authority and both snapshot sets. These native
provider actions are source-tested; concrete restore/application orchestration
and disposable installed fault acceptance remain required.

Database recovery independently checks the active paired-recovery step, verified
fence, previous installed commitment, machine, owned stopped containers, snapshot
identities and current authority before effects. Each bounded archive restores
into its existing database in one PostgreSQL transaction, without recreating
cluster roles or database owners. Unknown restore outcomes remain held and cannot
replay. Semantic permission fingerprints include column grants, row policies,
routines, triggers and default ACLs without unstable recreated-object IDs. A real
local PostgreSQL 17 round-trip exercises archives, ordinary data and revocation
checks; it does not substitute for installed appliance or complete paired restore
acceptance.

Paired recovery restores SQL first, portable UI data second and only the two core
service roots last. Live `config`, `control`, UI environment and independent
Pointer paths remain authoritative: old secrets, selected sources and lifecycle
journals are not copied over them. Compatibility with those retained bindings is
part of the later health gate; incompatible state remains held for
recovery. UI data restoration verifies the exact held snapshot tree and current
mount coverage, rejects links/devices/nested mounts, checks capacity and hashes
its result. An interrupted idempotent file copy may reconcile under the same
verified fence. An uncertain remote root restore cannot replay. `paired-restored`
is still not an accepted rollback and does not release ingress or power holds.

Fresh CP/UI receive a protected component marker before service startup, bound to
the verified raw manifest digest and selected payload hash. CP and ID share one
durable schema attempt; UI uses its mounted data. A completed exact receipt skips
schema replay across processes/restarts. Uncertain effects remain held. Database
connectivity is checked before recording intent, so a not-yet-deployed database
does not become a false migration failure. Historical full restore has a separate
explicit attempt. Authenticated component endpoints expose bounded status and
accept only the native marker's exact identity. Missing selected markers cannot
fall back to legacy initialization. Fresh UI mount creation and generated digest
metadata placement preserve the exact application-file index.

The core checkpoint may retain a Pointer archive for paired evidence, but core
rollback does not restore that independently managed database. Current Pointer
rows/files remain in place. Core database authority checks and the global writer
fence still apply; a newer Pointer data row is not permission to overwrite it
with the older checkpoint. Pointer's own update/backup lifecycle retains its
separate paired recovery contract.

The native command entry points are `youeye update core check`, `stage`,
`activate`, `resume`, `recover`, and `cancel`. Stage binds the owner's stable
request ID to the reviewed manifest digest resolved under current System policy.
A host update waits for explicit activation before checkpoint capture; service
updates use the same graph without a host restart. Resume reconciles separately
owned systemd actions. Unknown actions cannot be launched again. Boot continuation
reads only the retained request and does not authorize a waiting restart.

Native Incus commands always select the local daemon and default project. Raw
`query` commands bind `project=default` in the API URI because Incus rejects its
global `--project` option for that command. Existing query parameters remain
intact; foreign or ambiguous project selections fail closed.

Authenticated health checks exact installed file indexes, component markers,
completed schema receipts, current native credentials, the CP-to-UI bridge and
live read-only database access. Native operational checks also verify host,
storage and service bindings. These checks create no user or sign-in session;
real administrator/user, SSO and app admission acceptance remains a separate
required disposable installation test. A completed shared receipt precedes
restoring original power policy and opening the owned ingress/lifecycle holds.
Host recovery requires the actual previous immutable boot after paired service
and data restoration. A reboot acknowledgement alone cannot establish recovery.

Fresh tracked installations initialize their media baseline behind the
closed setup gate, then freeze one current complete selection and use the same
paired core transaction. The protected first-boot record binds the original
installation policy, baseline digest, target digest, request ID and machine.
Reboot continuation retains that target and skips media redeployment. Exact
installations retain their original selection. Failed or unaccepted convergence
keeps setup closed. No baseline or Installer provenance is relabelled to claim
that an older image was rebuilt for the newer shared release.

Administrative core API actions bind both the update request and reviewed digest
plus a separate delivery ID. A systemd continuation owns progress after HTTP/CP
loss; retrying the delivery observes the original launch and never relaunches it.
Retrying preparation reads the retained frozen request before resolving a moving
channel. A new explicit Resume reconciles the same graph. Unknown native effects
remain needs-attention with their original started intent. Completion in the UI
requires both the accepted shared receipt and released maintenance holds.

Managed installations expose one read-only System source and one update control. Pointer and
native apps retain their independent channel controls. An old host's missing core
endpoint permits legacy behavior only when selected core identity is positively
absent; damaged or unavailable evidence fails closed. Browser delivery identity
is retained across reload, while status polling and background discovery perform
no update mutation. Real device/render and interrupted-connection acceptance must
be recorded separately from source tests.

Failed verification or partial inactive-slot preparation can be cancelled before
activation. The coordinator persists exclusive cancellation intent, preventing
resume or new action launches, then settles only its exact native units and all
cgroup descendants. Cleanup holds the host lock and checks running slot, current
image and exact candidate/transaction ownership. It removes only inactive boot
entries and its candidate metadata; it does not restore databases, mutate the
running payload or erase a preceding recovery chain. Lost cleanup responses retry
the same cancellation. An activation request made before staging is intent, not proof that a checkpoint
started. Cancellation remains available while every checkpoint-or-later step is
pending and exact native preparation children have settled. The retained activation
intent is preserved. Checkpointed requests still require paired
recovery; unknown or foreign native ownership keeps cancellation unfinished.

The piped Installer bootstrap (`installer/scripts/install.sh`) reads the
channel index, checks `core-release.json` against the index digest, and runs the
`installer` member only after its SHA-256 and size match. It passes the tag and
the `core-release.json` digest to the native Installer, which refuses any other
document. See [releases.md](releases.md) for channels and the index.

### Stable reader bootstrap

Provider settlement reads the raw local Incus API response with an explicit
default-project boundary. Incus may print no bytes for empty query metadata in
its ordinary renderer. A successful synchronous response containing an empty
object proves an empty operation collection; blank output, null metadata,
malformed/error responses and running or unknown operations remain blocked.
After a durable commit or rollback, final maintenance release retries known
active provider operations for up to two minutes, respecting caller cancellation.
Each retry revalidates the complete machine, reservation, inventory, power and
ingress ownership contract. It does not cancel operations or whitelist commands.
Unknown/malformed observations fail immediately. Timeout retains maintenance and
the checkpoint; `youeye update core resume --request <original-request-id>`
reconciles the same completed request without reapplying its committed payload.

`youeye-system-update-bootstrap --core <https-core-release-url> --sha256 <digest>
[--inputs <protected-dir>] [--activate]` supports an installed Core whose old
reader cannot process a newer release. It fetches `core-release.json` over HTTPS
(the URL must be `<source>/releases/download/<tag>/core-release.json` for the
document's own source and tag), requires `authority: "digest"`, downloads only
the `spine` member artifact (or its `blob-<sha256>` mirror on HTTP 404), checks
its size and SHA-256 and retains it with the exact document under
`/var/lib/youeye-state/core-update/bootstrap/<artifact-sha256>/`. `--sha256` is
required and must equal the document digest; without it nothing is fetched. `--inputs` reads the same two files from a
protected offline directory. It then runs
`update core bootstrap --request stable-bootstrap-<digest> --manifest-sha256 <digest>`.

The exact binary and document remain in a protected content-addressed
State directory. A retained bootstrap record binds them to one normal paired
update request. The current boot receives one owned drop-in under `/run/systemd/system`,
pointing to this coordinator without writing the immutable `/etc` tree. The
protected coordinator and journal survive reboot; the runtime drop-in does not.
A compatible target host uses its baked reader to continue the retained
coordinator. Boot continuation waits for Incus's completed readiness check,
including its autostart containers. Host-IP startup and steady-state maintenance
take the ordinary shared lifecycle lease, so they cannot restart held containers
or change their network while a System update or recovery owns the reservation.
Recovery observation of an unfinished apply keeps missing service-stage evidence
unknown. It checks previous-release authority and durable host commitment before
fencing; it neither requires forward-only schema probes nor replays the apply.
An explicit recovery request records its recovery intent before observing an
interrupted apply, including when the journal still says applying. Previous-release
authority, the uncommitted receipt and an existing checkpoint are checked first;
owned-child fencing and paired restoration remain separate mandatory steps.
If interrupted or rolled back onto an older host, rerun the same
verified bootstrap command with the same exact manifest and inputs. It restores
the runtime override and resumes the retained apply or recovery graph; it does
not create a second update. Automatic continuation on the incompatible older
host is not promised, and retained recovery/data holds must not be removed.
An older host can also start its own DNS container before that continuation.
After verified previous-host recovery, the coordinator may record the already
running Pi-hole as an observation, without issuing or inventing a start. This
requires its originally running power state, unchanged UUID, exact recovery
ownership and disabled autostart. Other unexpected starts, originally stopped
containers and forward-update startup still fail closed; final authenticated
health and all paired recovery checks remain required.
Every invocation rechecks the target and original Spine artifact. Host
health observes the canonical baked executable against the running image,
separately from the temporary coordinator. Staging alone does not activate;
`--activate` requests the ordinary counted host transition.

After verified commit, rollback or cancellation, cleanup removes only that
exact boot override and retires the bootstrap record. The binary/artifact stay
until no process needs them and ordinary retention can remove that exact set.
No host executable, channel choice, app data or recovery guarantee
is replaced by the bootstrap path. Runtime acceptance must include the actual
old-reader transition and interrupted continuation; source tests alone do not
establish compatibility.

### Deferred API reader bridge

For an administrator-managed temporary API adapter, `api serve` accepts the
paired flags `--core-reader <protected-Spine-path>` and
`--core-reader-manifest-sha256 <exact-Stable-manifest-digest>`. The reader must
occupy its ordinary content-addressed `core-update/bootstrap/<artifact-sha>/youeye`
path with the exact `core-release.json` beside it. Startup checks the official
Stable selection and the reader's SHA-256 and size against its `spine` member.
It creates no System transaction, bootstrap registration, boot continuation
override or native update action. Check resolves the live selected source and
rejects a release whose digest differs from the explicitly selected bridge.

Only the owner's ordinary Stage request prepares a native transaction. After
current-request admission, the adapter registers the original reader,
installs the ordinary boot continuation, and starts the existing idempotent
native control runner with that coordinator. Native actions never use
the locally built API adapter as their executable. Repeated deliveries retain
their request and command identities; a stale target or failed registration
cannot fall through to the incompatible baked coordinator. Resume cannot
create the initial reader registration in place of a retained Stage delivery.

Use an owned runtime-only API service override for this temporary adapter;
never replace the immutable host executable or edit the System journal. Before
the owner stages, removing that override or rebooting restores the baked API
and leaves the update unstaged. After Stage, the existing bootstrap's
interruption, cancellation, paired recovery and exact-request re-entry rules
apply. Retire the API override after the selected installed host can provide
its own compatible service. Source checks and a successful discovery do not
constitute installed-update or recovery acceptance.

Private repository main uses Alpha; public main uses Stable. Raw branch identity
is preserved independently of the suffix. First boot with require-current stays
closed when current discovery is unavailable. An explicit prefer-current policy
may retain only its media baseline on a positively identified DNS/network
unavailability error. It does not fall back on digest mismatches,
bad clocks, malformed responses or missing releases. The
protected fallback record is bound to policy, machine and exact baseline; it
permits only a no-op fresh convergence while setup remains closed. Exposed
installations and effectful updates retain normal current-policy checks.

Installed updates download changed service artifacts and required host documents.
Native A/B staging owns host payload downloads; it does not fetch Installer/ISO
artifacts as part of an installed update. Identical service members reuse
retained file indexes and verify the actual live files. Their
completed schema markers remain unchanged. A fresh baseline no-op can therefore
validate locally without downloading the complete media again.

The installed coordinator retains a protected sequence floor for each exact
source and raw branch outside paired data restoration. Cancellation, recovery
and channel changes do not lower it. Equal sequences must retain identical
manifest bytes. A true no-op may verify the installed baseline below the floor
without changing it; a new effectful request cannot select that older release.

## Read-only installed observation

`youeye update core observe` and the explicit API request
`GET /api/appliance/core-update/status?observe=1` produce bounded fresh membership
evidence. Ordinary status polling only reads retained state. The observer checks
current authority, actual partition/machine identity, immutable host and
baked Spine, and host-observed CP/UI static bytes plus completed schema markers.
It brackets the scan with exact receipt and transaction reads and returns
`unverified` or `pending` when those checks cannot establish current membership.
It never creates users, sessions, migrations, update jobs or installation receipts.

The API exposes sanitized original member identities and the shared version,
digest and sequence, never raw machine binding or protected acceptance evidence.
This is payload membership evidence; full operational acceptance
remains a separate release gate.

The appliance build-inputs reader (`youeye.build-inputs.v1`) accepts canonical
versions and exact `youeye-v<version>` component tags, preserving the original
case of the branch. The build entry validates it before any image work.

Fresh Control Panel reconciliation compares the installed bundle with the verified selected CP member, while binding the running image and baked Spine independently. Reused media may describe an older CP payload; that media label is not the service target. Missing or invalid selected state fails closed, and legacy media without a core selection retains its sealed-version check.

### Manifest response cache and installed verification

Next 16.4.2 stores the static web manifest response under
`.next/server/route-cache/APP_ROUTE/<owner-sha256>/$/manifest.webmanifest.body`
and `.meta`, separately from compiled route files. The owner digest is SHA-256
of `/manifest.webmanifest/route`. CP and UI use the same layout. A normal browser
or PWA manifest request can populate it on an otherwise unchanged installation.

Installed verification permits only these two non-executable regular data files
and their four directory ancestors, and only when the payload index
contains `.next/server/app/manifest.webmanifest/route.js` as a regular file.
It rejects links, multiply linked files, special mode bits, other owners/routes,
other suffixes and added executable files. entries always retain their
original byte, type, mode and link checks. archives must not contain this
runtime cache. Other Next response-cache layouts require an explicit review;
there is no general `.next/server` exemption.

The authoritative host scanner opens directories through anchored descriptors
without following links. It tolerates disappearance of these exact runtime data
paths during concurrent requests; missing paths still fail. The Go fixture
verifier uses the same scanner, and the Node reference enforces the same narrow
layout and file rules. Runtime cache bytes are mutable data, not payload
identity. No cache clearing, runtime relocation or guest-wide dependency change
is required by this repair.

A confirmed installed-payload rejection during `verify-members` records a failed
native result with the phase, CP/UI role, path class and a fixed diagnostic reason.
It does not persist arbitrary paths, file contents or provider errors. The result
records that verification execution started but failed before activation; it does
not claim the action was never invoked. Reconnect reads this terminal result and
same-request calls do not execute it again. Cancellation, unavailable observation
and unknown effects retain their existing uncertainty and reconciliation rules.

An affected installed reader still rejects this cache before target activation.
Use the existing verified Stable reader bootstrap described above when that old
reader is selected. Merely installing a target verifier cannot repair the old
preparation step. The exact target and original Spine artifact, retained
request and paired recovery rules remain mandatory. A held
Stable target needs the administrator-provided baseline-plus-target test transport;
changing its hostname is not a compatibility fixture. Source tests do not establish
an installed old-reader transition, owner acceptance, or public release.


### DNS address restoration during a held update

The native health coordinator refreshes the two installed Pi-hole TCP/UDP port
53 listen addresses to the currently ashost address before restoring its
original running state. This narrow operation requires the frozen container UUID,
exact lifecycle hold, stopped instance, installed proxy contract and settled
provider operations. It preserves all other device fields and the ordinary
host-migration fence. Originally stopped instances remain stopped.

Host address detection uses the kernel's route-selected IPv4 source, checked
against the asaddresses of its up interface. Managed app/container bridges
and tunnels cannot supply the LAN address; an ordinary host bridge can when the
route explicitly selects it. Without routing evidence, only one unambiguous
address on an eligible LAN interface is accepted. Slow DHCP retries remain
bounded. Interface enumeration order and a hard-coded private subnet exclusion
are not address authority.

Checkpoint receipts retain the old addresses and distinguish forward and recovery
bindings. Lost device acknowledgements reconcile observed addresses. An already
requested, uncertain container start is never generally retried. Explicit recovery
may perform one separately recorded DNS repair start only after the original
recovery child is positively settled under both leases and a changed DNS binding
has been recorded and repaired. Its own durable start intent also forbids replay
when the resulting power state is unknown. The original power receipt remains;
this does not rerun migrations, restore data again or release maintenance early.

Host staging binds its downloader to the verified complete core selection. Exact
original member URLs may resolve to the publisher's hash-named asset after
an original-URL 404, using the same bounded transport as member verification.
Source identity, checksum, redirect and non-404 failure checks remain.

If a host reboots during incomplete recovery, explicit continuation first proves
that the original recovery child has settled and that the host boot identity has
changed. Frozen originally running containers receive separate, boot-bound
startup receipts; unknown starts on the same boot remain non-replayable. CP/UI
also require their protected previous component marker and completed schema
receipt before cold startup, followed by the normal full payload and running
service checks. This restores held power without repeating paired data restore or
schema migration. Originally stopped applications stay stopped.

A changed DHCP address on another proven recovery boot appends a boot-bound DNS
binding receipt while preserving previous bindings and start intents. The separate
per-boot power receipt owns that boot's start. Address changes or stopped
observations on the same boot cannot reset its start authority; uncertain provider
effects, foreign device edits and observation-only calls remain fenced.
