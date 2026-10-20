# Core release identity

The source contract for new installations is `youeye.core-release.v1` in
`releasecache/core_release.go`. Its complete signed membership is immutable.
`X.Y.Z[-token.N]` is the assembly version; each member records the original
build version, repository, exact branch, source commit, input fingerprint,
release tag, artifact, checksum set, detached signature, provenance and SBOM.
Each blob has its original signed filename, exact HTTPS release-asset URL,
byte size and SHA-256. Publication aliases can distinguish CP and UI's
`standalone.tar` without rewriting either member's signed checksum document.

The manifest lists Installer, media, appliance metadata, the host update
manifest, System root, both
System UKIs, System updater, internal Recovery, Recovery UKI, update bootstrap,
Spine, CP/YouEye ID and UI. Membership is flat. No `latest` URL, recursive
parent lookup or substitute blob is permitted. An older manifest digest is
lineage evidence, not an instruction to inherit unspecified members.
Appliance and host update manifests retain their explicit document signatures
as well as the signed checksum-set references.
The appliance also pins the exact resolved release lock; its digest must match
the signed provenance's `resolved_lock_sha256`, including on detached media.

The assembly's `youeye-v<version>` tag and source commit identify the release
selection. Unchanged members retain their earlier build identity and exact
original URLs. Consequently, the committed System release can advance without
changing the immutable image marker. Installer and media can be reused only
when their readers and declared compatibility support the complete selection.

Versions retain three numeric positions. Prerelease counters are positive,
numeric and bounded to JavaScript's exact integer range. Tokens are lowercase
ASCII with interior hyphens. Git branch names remain case-sensitive and are
not authorization tokens. Source/channel policy precedes ordering. Historical
numeric-depth identities remain readable but do not define new allocations.

The signed dependency order puts Spine before CP and CP before UI. A manifest
requires an explicit reader capability and persistent State/Data compatibility
ranges. Unknown readers, missing members, duplicate roles, cycles, malformed
identities and mismatched artifact source/tag paths fail before effects.
Duplicate JSON object keys are rejected at every level so Go and TypeScript
cannot interpret the same signed bytes differently.

`ParseCoreRelease` validates structure and computes the exact-byte digest;
parsing alone establishes no trust. `VerifyCoreRelease` additionally checks
the detached Ed25519 signature against an already trusted, scoped key and its
SPKI fingerprint. Each host/CP authority must independently validate the
selected role's artifact signatures and current policy. An assembly signature
does not let a service publisher replace the host. Activation must revalidate
revocation and source policy without changing the frozen membership.

`VerifyCoreMember` checks the separately scoped role key, exact blob bytes,
signed checksum names and host document signatures. It streams payloads and
bounds metadata. The host journal stages before awaiting an owner-selected
restart, then captures paired rollback state at activation. Capturing State
and Data when staging starts would lose intervening owner changes on rollback.
Accepted request IDs remain bound to their original manifest after later
transactions finish. Reading or retrying an old ID returns its retained receipt
and cannot replay an old migration against newer installed state.

Fresh answer media uses `youeye.appliance.answer.v5` to carry the exact manifest
and signature bytes, encoded without JSON reformatting. Its release policy binds
the separate core-manifest digest as well as the image-manifest digest. Spine
checks the running immutable image separately from CP/UI member selection, and
hands the signed selection to CP for its own role verification. Original signed
checksum filenames remain authoritative even when remote assets are namespaced.

New media carries a `core-selection-required` capability marker. Interactive,
seeded and answer-file installs freeze and authenticate the complete selection
before disk writes. The selected assembly must contain the exact verified image
and baked Spine; image version alone is not sufficient. New media cannot fall
back to legacy appliance discovery. Existing v4 transport-cache answers require
a matching v5 selection on new media; they are never silently rewritten with a
new cache identity.

The first resumable checkpoint retains signed selection bytes and their policy
under protected State storage, bound to the original transaction, disk serial
and image digest. Resume authenticates that retained selection instead of
following a moving channel. A supplied resume answer cannot change it. Missing
retained evidence requires the original installation inputs and recovery; it
does not authorize choosing another release.

Public first deployment stages only the exact CP/UI verification envelopes in
the protected content-addressed cache. It verifies the original role signatures
before deriving installed file indexes. No private transport cache is required.
Existing corrupt blobs fail closed; missing blobs use constrained HTTPS artifact
retrieval. Official GitHub asset redirects are bounded and cross-origin requests
strip authorization and cookies. API discovery retains its separate policy.

A new signed assembly with identical complete members, dependency graph and
compatibility contract uses a metadata-only transaction. It verifies current
policy, signing authority, sequence, installed files and authenticated service
health, then commits the accepted release receipt. It does not download payloads,
replace services, run migrations, capture a checkpoint or restart the host.
The exact-digest no-op remains distinct. Changed members or compatibility take
the normal update path, and interrupted receipt commits reconcile under the
original request identity.

Host staging uses the assembly's exact aliased URLs and checks original signed
payload names against the independently verified host manifest. Its durable host
journal binds the assembly digest; activation rereads its protected signed bytes.
Boot blessing and host commitment require the coordinator's checkpoint and service
acceptance steps. An already committed host may be reused by later service releases.

Native action intent is persisted before execution. Action IDs bind the target
manifest permanently, with process boot/start identity and retained results.
Action and continuation ownership checks accept systemd's empty representation
of the host root working directory as well as `/`, while requiring explicit
empty RootDirectory and RootImage observations. Missing properties, alternate
working directories and isolated roots remain rejected.
An uncertain action cannot become absent merely because its process disappeared;
only the native operation's exact retained evidence can establish completion.
Track discovery bypasses the frozen installation transport cache and still uses
the selected provider or verified signed distribution. An explicit tag and
manifest digest may resolve an unpublished candidate from protected media. If
that exact tag is absent from the snapshot, discovery checks the live source;
it never silently substitutes the installed release. Network or verification
failures do not turn a tracking selection into a stale offline selection.

Complete staging verifies each role and reserves sufficient free cache capacity,
while identical blobs share protected content-addressed storage.

The first shared installed receipt binds installation/device/disk/partition
identities, exact retained selection and native deployment evidence. First boot
records it after signed media, service membership, static installed file checks,
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

The System channel stores the assembly source, case-sensitive raw branch,
ordered fallback chain and optional exact manifest pin. Independent application
channels remain separate. Initialization preserves owner pins; CP/UI member pins
stay frozen when System follows a track. Discovery uses signed sequence within
the selected branch, rejects conflicting sequences and never ranks by timestamps.

Core checkpoint admission shares a kernel read/write lock with ordinary app,
container and inventory work. Active operations must settle, and unfinished app
receipts require recovery before activation. A protected durable reservation
continues exclusion after process loss or reboot; only the matching committed
core journal and installed machine receipt permit normal release of that hold.
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

CP/UI static file indexes derive from exact role-authenticated archive bytes.
Native observation checks all files, links, modes and added paths rather than
trusting package version labels. Runtime environment files and Next's cache are
outside the signed code identity. New UI installations place uploaded branding,
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
part of the later authenticated health gate; incompatible state remains held for
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
metadata placement preserve the exact signed application-file index.

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

Fresh tracked installations initialize their signed media baseline behind the
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

Managed installations expose one System channel and update control. Pointer and
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
the same cancellation. Activated/checkpointed requests still require paired
recovery; unknown or foreign native ownership keeps cancellation unfinished.

The piped Installer bootstrap first looks for a complete canonical release. It
verifies the assembly signature, reader capability, source/raw branch, scoped
original host authority and Installer checksum/member hash before execution.
Aliased publication filenames keep their original signed checksum names. A Beta
assembly may reuse its independently verified Stable Installer/media. Exact
bootstrap passes the complete manifest digest to the native Installer. Protected
per-track signed sequence floors survive retries; public catalog expiry and
anti-replay checks remain in the existing distribution reader. Historical v1
installation/component records remain available to old readers; a canonical core
record does not become an independent component upgrade for them.

### Stable reader bootstrap

Provider settlement reads the raw local Incus API response with an explicit
default-project boundary. Incus may print no bytes for empty query metadata in
its ordinary renderer. A successful synchronous response containing an empty
object proves an empty operation collection; blank output, null metadata,
malformed/error responses and running or unknown operations remain blocked.

The signed `youeye-system-update-bootstrap --core <exact-core-manifest-url>`
bridge supports an installed complete Core whose old reader cannot retrieve
the new public release. The separate legacy Plan 1 development mode remains
unchanged. The Core bridge requires the official Stable assembly and an original
Stable Spine envelope; it reads the installed owner's current scoped trust,
honors revocation/overrides, and verifies both assembly and original role
signatures before executing downloaded code. `--inputs` accepts a protected
offline directory containing `core-release.json`, `core-release.json.sig`,
`artifact`, `checksums`, `signature`, `provenance` and `sbom`; it preserves the
original public source identities and all checks. It does not import or patch
an installation candidate cache.

Spine transport accepts the signed original filename or its published `spine-`
prefix under the exact signed Stable build tag. For promoted releases whose
original build tag is unpublished, only HTTP 404 permits the selected assembly's
`blob-<sha256>` mirror. Permission errors, transport failures and wrong bytes do
not trigger that fallback; both original signatures and exact sizes/hashes remain
mandatory.

The exact binary and original envelope remain in a protected content-addressed
State directory. A retained bootstrap record binds them to one normal paired
update request. The current boot receives one owned drop-in under `/run/systemd/system`,
pointing to this coordinator without writing the immutable `/etc` tree. The
protected coordinator and journal survive reboot; the runtime drop-in does not.
A compatible target host uses its baked reader to continue the retained signed
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
Every invocation rechecks the signed target and original role envelope. Host
health observes the canonical baked executable against the running image,
separately from the temporary coordinator. Staging alone does not activate;
`--activate` requests the ordinary counted host transition.

After verified commit, rollback or cancellation, cleanup removes only that
exact boot override and retires the bootstrap record. The binary/envelope stay
until no process needs them and ordinary retention can remove that exact set.
No host executable, owner trust, channel choice, app data or recovery guarantee
is replaced by the bootstrap path. Runtime acceptance must include the actual
old-reader transition and interrupted continuation; source tests alone do not
establish compatibility.

Private repository main uses Alpha; public main uses Stable. Raw branch identity
is preserved independently of the suffix. First boot with require-current stays
closed when current discovery is unavailable. An explicit prefer-current policy
may retain only its signed media baseline on a positively identified DNS/network
unavailability error. It does not fall back on invalid/revoked signatures,
expired metadata, bad clocks, malformed responses or missing releases. The
protected fallback record is bound to policy, machine and exact baseline; it
permits only a no-op fresh convergence while setup remains closed. Exposed
installations and effectful updates retain normal current-policy checks.

Installed updates download changed service envelopes and required host documents.
Native A/B staging owns host payload downloads; it does not fetch Installer/ISO
artifacts as part of an installed update. Identical signed service members reuse
retained authenticated file indexes and verify the actual live files. Their
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
current signed authority, actual partition/machine identity, immutable host and
baked Spine, and host-observed CP/UI static bytes plus completed schema markers.
It brackets the scan with exact receipt and transaction reads and returns
`unverified` or `pending` when those checks cannot establish current membership.
It never creates users, sessions, migrations, update jobs or installation receipts.

The API exposes sanitized original member identities and the shared version,
digest and sequence, never raw machine binding or protected acceptance evidence.
This is payload membership evidence; full authenticated operational acceptance
remains a separate release gate.

The appliance release-lock reader accepts canonical short versions and exact
`youeye-v<version>` member tags, preserving the original case of the branch.
Detached locks retain original per-member versions and hashes; retained legacy
locks remain readable. The build entry uses this same validator before any
image work, and the Train input adapter emits the shared product tag.

Fresh Control Panel reconciliation compares the installed bundle with the verified selected CP member, while binding the running image and baked Spine independently. Reused media may describe an older CP payload; that media label is not the service target. Missing or invalid selected state fails closed, and legacy media without a core selection retains its sealed-version check.
