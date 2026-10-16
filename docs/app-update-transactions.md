# Recoverable application update contract

Control Panel's Market updater composes a persistent receipt, resource inventory,
exclusive lifecycle admission, encrypted recovery workspace and Incus/PostgreSQL
provider. Startup reconciles incomplete operations before watchdogs and queues.
Market's authenticated update controls expose progress and explicit recovery.
Completed recovery also acknowledges a retained health warning when the latest
operation has verified commit or rollback and no unfinished operation remains.
This acknowledgement never replays provider effects or clears newer recovery.
The canonical app, Market, Settings and embed update paths share administrator
and CSRF validation for Market applications. Intermediate steps never report a
completed update; pending recovery or cleanup is returned as pending. Provider
output and exceptions are excluded from these responses.
Appliance acceptance remains a separate requirement from unit-test coverage.

An identical signed product build can use `operationKind: release-metadata` in
the same journal. It reserves the app and exact containers, checkpoints only
release registration metadata, and keeps payload writers running. Recovery
selects the metadata provider from the durable operation kind; an absent kind
retains legacy payload recovery. This path cannot declare mutable runtime,
volume or database resources. See [product release identity](product-release-contract.md)
for eligibility and installed-evidence limits.

Accepted product release sequence floors may advance during a payload update.
They are excluded from the credential/ownership revision checked before reopening
the app, and remain preserved during rollback. Release admission still rejects
sequence rollback or substitution; changes to credentials, admission policy,
ownership or secret files still prevent recovery from reopening stale authority.

## Recovery boundary

An update needs one compatible recovery set covering runtime code, durable
storage, dedicated PostgreSQL data and app-scoped control metadata. Container
rollback alone cannot restore custom volumes or SQL migrations.

`planAppUpdateInventory` compares frozen installed and target manifests, install
metadata and current provider observations. The caller must obtain observations
under lifecycle exclusion, then revalidate identities before effects. A manifest
declaration is not proof of ownership, writer closure, capacity or restore support.

The inventory:

- Includes every container and its root storage pool.
- Deduplicates custom volumes by pool/name. A writable subpath makes the complete
  backing volume mutable even when its base attachment is read-only.
- Checks declared attachments against actual expanded Incus attachments.
- Keeps the exact platform-created read-only CA trust directory mount outside
  app data recovery. Its app-scoped source, destination and mount options must
  match; writable, foreign and other host-path storage still fail preflight.
- Requires an available old runtime, supported restore method, checkpoint space
  and a cleanup reserve.
- Includes one dedicated database in shared PostgreSQL or a declared logical
  database in an app-owned PostgreSQL container. Platform and maintenance
  databases are excluded.
- Refuses writable shared storage and database writers outside the app boundary
  with `unsupported-shared-resource`. Version 1 does not implement distributed
  shared-app migrations.
- Allows unchanged read-only shared inputs without rewinding their data.
- Refuses container, storage or database topology changes without a compatible
  recovery declaration. The initial planner does not create new resources.

Ownership observations must come from exact provider identities and app-owned
network/storage metadata. PostgreSQL observations must establish actual database
ownership, scoped logical recoverability and all permitted writers; an empty
active-session list alone does not prove that future clients cannot write.
PostgreSQL client addresses use `host(client_addr)` for exact matching against
verified runtime IPs. Ordinary invoker trigger routines do not independently
grant table write access; security-definer triggers and other executable routines
remain part of the conservative foreign-writer check.

## Protected receipt

`AppUpdateJournalStore` persists `youeye.app-update.v1` records under protected
Control Panel state. Directories are private to the service user; receipts use
mode `0600`, atomic replacement and file/directory synchronization. Reads reject
symlinks, special files, unsafe permissions, invalid states and records exceeding
one MiB, including files that grow during reading.

The receipt contains immutable manifest/artifact digests, resource identities,
original container running states, metadata revision digests, checkpoint
references, completed steps, recovery policy and a commit or rollback receipt.
It accepts no credential values, SQL, manifests, metadata bodies or arbitrary
exception text. Error fields contain bounded public codes. Sensitive recovery
payloads use an operation-scoped private AES-256-GCM workspace with operation/name
binding, a persistent private key and bounded reads. Missing keys for retained
payloads are an error; recovery never regenerates a replacement key.
PostgreSQL remote scratch is private, bounded, recorded before creation and
owned by one operation. Remote `flock` prevents recovery from removing files
while a dump/restore command is still executing after the Control Panel dies.

Each mutable resource requires the appropriate verified checkpoint method:

| Resource | Checkpoint method |
| --- | --- |
| Container | Runtime copy or root snapshot |
| Custom volume | Volume snapshot |
| Dedicated PostgreSQL database | Logical PostgreSQL recovery point |
| App-scoped metadata | Scoped metadata recovery point |

A receipt does not independently verify the referenced recovery point. Provider
adapters must verify presence, completeness, exact identity and actual restore
support before recording checkpoint evidence. Raw PostgreSQL directories must
not be transplanted between database versions.
Incus custom-volume snapshots inherit parent metadata. The provider records the
original description in the encrypted recovery plan, verifies that its temporary
snapshot name is absent, tags the parent, creates and verifies the owned snapshot,
then restores the parent description. Interrupted creation reconciles that tag;
foreign metadata edits are refused.

## State and external operations

Normal phases are `preflight`, `quiescing`, `checkpointing`, `prepared`,
`applying`, `verifying`, `committed`, then `cleanup`. Failure uses `recovering`,
`rolled_back` or `recovery_required`.

Record a unique step intent before an external operation and acknowledge it only
after observing its outcome. An existing step identity cannot be reused to
blindly replay a migration. After interruption, reconcile actual state and
restore before retrying unless an explicitly safe resume contract exists.

Preparation requires verified checkpoint coverage for every mutable resource.
Commit and verified rollback require all earlier step intents to be reconciled.
The commit receipt survives cleanup errors; committed data cannot be converted
back into rollback because temporary recovery-point deletion failed.

Reservation release records its own intent/result for each resource. An
interrupted release remains pending and is resumable without deleting foreign
reservations. Cleanup is complete only after every owned reservation is durably
released.

## Coordination and recovery interface

The journal reserves app, container, volume, database, metadata and capacity identities in
deterministic order. Admission checks unfinished receipts as well as reservation
creation, so a receipt with missing locks still prevents another update. A short
durable admission guard also serializes final reservation release. These records
never expire merely because a PID died or time elapsed.
Capacity reservations serialize updates sharing pools or protected Control Panel
state. Space is rechecked under admission before mutation; two updates cannot
each consume the same preflight estimate. A capacity reservation is exclusion
evidence, not a storage object to snapshot or delete.

`withAppLifecycle(appId, work)` holds an OS lock through asynchronous mutation
and checks unfinished journal reservations. Update, uninstall, restore, backup,
storage changes and integration/credential mutations use this boundary.
Nested calls share their admitted context. Recovery supplies the exact
`recoveryOperationId`, then obtains the journal executor separately. The recovery
parameter grants no authority to mutate unrelated resources.

`AppUpdateJournalStore.withExecutor(inputOrId, work)` holds a Linux `flock` on a
stable inode. Process death releases executor ownership, preserving durable
resource reservations. No stale-PID timeout or inode deletion permits concurrent
executors. `withAdmission` serializes resource admission and release.

The provider persists the frozen recovery plan before effects, disables app
autostart and inserts an operation-owned ingress denial. It stops ordinary app
containers while retaining the database engine for logical backup. PostgreSQL
fences the dedicated database and proves writer closure. Immutable stopped
runtime copies, custom-volume snapshots, a validated logical archive and scoped
metadata form the recovery set.
Stopped recovery copies disable local and profile-inherited NIC/proxy devices,
preserving storage attachments without reserving live MAC addresses or ingress.
Recovery verifies operation/source ownership before isolating an older copy,
then restores the canonical runtime's frozen devices and profiles after rename.

Hooks and executable migrations run under a temporary idle init, with ordinary
services stopped. All code replacements finish before ordinary target code
starts. Generated configuration, declared environment and commands are applied
under the checkpoint; installed credentials/settings are retained rather than
regenerated from empty canonical defaults. Native replacement checks the
declared on-disk service directory. Unsupported hook dependencies fail safely.
First startup migrations and health checks run with ingress fenced, retaining
the entire recovery set until the installed version and migration gates commit.
Configuration in native/LXD custom volumes is written through the scoped volume
API while the runtime is stopped; root configuration uses the checkpointed
instance filesystem. Nested read-only mounts cannot fall back to root writes.

On an uncommitted interruption, recovery restores the complete set instead of
replaying arbitrary hooks or SQL. Logical restore targets one dedicated database,
preserves current roles/passwords and reconciles current grants. An app-owned
PostgreSQL engine keeps its exact runtime and raw data volumes: app updates do
not perform PostgreSQL major-version upgrades or rewind the cluster.

An encrypted logical app restore reconstructs the scoped app login, including
statement, error and duration logging suppression required for private owner
SQL migrations. Logical archives do not restore arbitrary role settings or
administrator/preload privileges. This policy also applies to older logical
archives that contain no role catalog; a declared database bootstrap
administrator is left unchanged. The updater still verifies the actual owner
session and refuses SQL when logging or preload settings are unsafe.
Security reconciliation captures quiet PostgreSQL output. Retained scripts from
the earlier capture format may contain one known leading command tag; recovery
normalizes only that exact prefix after validating the immutable retained bytes.
Unknown prefixes are refused before dropping the scoped database.
Explicit SQL executes as the dedicated nonprivileged owner, never as an
administrator followed by `SET ROLE`. The owner session must already suppress
statement, error and duration logging. Restricted shared/session preload settings
are inspected through maintenance, including applicable role/database defaults
and parameter SET authority; owner-readable settings are checked in the actual
migration session. This does not grant `pg_read_all_settings`, alter role policy,
or send a migration payload before the checks pass. Fixture provisioning includes
the required logging defaults; incompatible logging/plugin policy fails safely.

Recovery verifies code identity, installed version, declared health and original
desired state. Failed verification stops writers and refences the database.
`recovery_required` retains reservations and checkpoints; a separate
`recovery-fence-unverified` code records a fence that could not be established.
New security metadata prevents restoring obsolete credentials or user grants.
Only app update-owned metadata fields are restored into current metadata.

After durable commit or verified rollback, reopening restores original desired
states and ingress. A stopped app-owned PostgreSQL engine is temporarily started
and checked before reconciling its scoped grants; an originally stopped engine
is stopped again afterward. Recovery never starts the shared platform engine.
Cleanup removes only operation-owned copies, snapshots and
staging. Missing-payload cleanup retries verify every external checkpoint is
already absent. Cleanup failure cannot roll back committed data.

Administrators use `GET /api/market/update/status?appId=…` and CSRF-protected
`POST /api/market/update/recovery` with `{appId, id}` where `id` is the recorded
operation ID returned by status. Status contains
bounded phase/error information, never credentials or checkpoint download paths.
Repeated recovery requests are serialized; completed operations are no-ops.

## Integration contract for security and policy writers

Credential and admission writers reuse the existing lifecycle boundary; the
update journal does not authenticate callers or decide user access policy.
Perform the caller's authorization checks, then hold admission through the
complete asynchronous mutation:

```ts
import { withAppLifecycle } from '@/lib/market/update-admission';

await withAppLifecycle(appId, async () => {
  // Caller-owned credential/policy logic: read current state and persist it here.
  await mutateAppSecurity(appId);
});
```

`mutateAppSecurity` represents the integrating caller's implementation, not an
export from the updater. Re-read current generations and policy inside the
callback. Await all effects before returning; detached work cannot retain the
admission after its callback settles.

| Interface | Contract |
| --- | --- |
| `withAppLifecycle(appId, work, options?)` | Serializes ordinary mutations of one exact app across processes. An unfinished update refuses admission with `AppLifecycleAdmissionError`, code `recovery_required`. |
| `options.resources` | Checks additional exact resource identities against unfinished updates. It does not itself acquire locks for ordinary mutations of other apps. |
| `withContainerLifecycle(name, work, options?)` | Resolves recorded app ownership, checks recovery-copy markers and retains lifecycle admission for container actions. Do not derive an app ID by splitting a container name. |
| `isAppUpdateReserved(appId)` | Advisory observation for watchdogs/status. Use the admitted callback for mutations; a prior false result is not admission. |
| `AppUpdateJournalStore.withExecutor(inputOrId, work)` | Update/recovery executor ownership, separate from lifecycle admission. Ordinary credential writers do not create or edit update receipts. |
| `updateNeedsRecovery(record)` | True until `cleanupComplete`, including committed cleanup and verified rollback awaiting cleanup. Phase, PID age or a running container cannot release reservations. |
| `updateResourceKey(resource)` | SHA256 of the JSON tuple `[kind, scope, name]`. Owner and mutability do not distinguish two locks for the same resource. |

Resource kinds are `app`, `container`, `volume`, `database`, `metadata` and
`capacity`. Volume scope is its storage pool; database scope is the exact engine
instance. Do not add credential values, policy bodies or arbitrary fields to
`youeye.app-update.v1`: the validated receipt is payload-free.
For a mutation touching several apps, acquire each app's lifecycle boundary in
a deterministic app-ID order and retain all callbacks until the operation
settles. Each caller still owns its writer-closure and security-generation
checks. Do not use `recoveryOperationId` to bypass an update reservation:
that option belongs to explicit recovery of the exact recorded operation,
which also obtains its journal executor.

The current recovery provider restores only update-owned metadata fields into
the latest install record. Other fields, including unknown compatible policy
or generation fields, remain current. It hashes those fields and bounded
regular app security files; a change from the frozen recovery plan stops
restoration rather than copying obsolete secrets into restored roots/volumes.
The production service-credential store holds the same lifecycle gate for its
reads and mutations. Security observations include its current projection,
local admission policy, stable principals and resource ownership. Recovery
refuses unsupported authority changes; it does not restore an obsolete
credential generation. The PostgreSQL credential-use closure identifies each
app's actual frozen database engine, role and database, including stopped users.

Core backup and full restore hold all affected app gates, plus the shared
identity and Pointer gates. User creation and disposition also hold the shared
identity gate, including when no app is installed. Pointer backup stops its
writers gracefully from SQL dump through encrypted engine-file capture, restores
the original running intent and checks readiness for a previously active service.
A failed restart retains container maintenance for explicit reconciliation.

A full application backup also captures the required logical dump when its
recorded app-owned PostgreSQL container is stopped. Under the owning app gate,
it verifies the exact manifest/metadata target, temporarily starts that database,
waits for PostgreSQL readiness and restores its original Stopped state before
archiving. The shared platform database is never started through this path.
Fresh logical restore reconstructs a separate application database owner only
from the frozen manifest's exact `PGUSER` and private `PGPASSWORD` secret binding.
The declared database container's `POSTGRES_USER` (default `postgres`) performs
database replacement; imported tables remain owned by the app role. Restore
does not grant that role superuser or database-creation privileges. Missing or
ambiguous owner credentials and foreign/system database targets are refused.
The complete app stays under maintenance while its exact database is started
and checked for readiness, its logical data is imported, service credentials
are reconciled and the archived running or Stopped intent is verified.
Unknown runtime state or an unverified stop fails the backup and retains durable
container maintenance for reconciliation. A failed dump still restores stopped
intent before releasing maintenance. Brief contention on app lifecycle admission,
including the core backup's inventory and complete multi-app gate, is retried
within a bounded interval before the capture callback begins. Once
capture starts, errors cannot trigger another capture; reservations, insecure
locks and unavailable OS locking still fail immediately.

PostgreSQL reconciliation is separately scoped: preserve current roles and
passwords, capture current object/default grants before dropping the dedicated
database, persist that security snapshot encrypted, and reuse it on retry.
`AppUpdatePostgresIO.runtime()` reports lifecycle exclusion, ingress exclusion,
the security revision, exact engine identity and the complete installed
credential-use closure, including stopped workloads. Missing closure or changed
security revision refuses the operation. This interface is provider evidence,
not authorization to inspect or modify another app.

The combined integration check must prove that admitted credential/policy
mutations contend with update, recovery and cleanup; newer revocations and
removed grants survive rollback; and an unsupported generation change retains
`recovery_required`, maintenance and checkpoints without reopening obsolete
workloads. Passing the standalone update suite does not establish these
integrated outcomes.

Development acceptance must exercise actual hook/SQL/runtime/configuration faults,
process death and reboot, both PostgreSQL ownership variants, authenticated
catalog app behavior and encrypted backup/restore. Fake-provider tests prove
driver behavior only; they cannot substitute for those appliance checks.

Core backup and full restore hold a shared installation-inventory OS gate before enumerating apps. Installation, uninstall and app restore hold the same gate before per-app lifecycle admission, so a new app cannot enter or disappear between inventory capture and checkpoint completion. Nested full/app restore retains the same descriptor; a competing process is refused before metadata mutation.

Fresh/setup restore rebuilds an existing pending installation only after archive/current core ownership validation and exact installation/owner UUID checks. Missing, foreign, retained, deleted or quarantined policy authority is refused. This recovery path never changes grants or makes a policy ready. Archived disabled/stopped runtime intent survives reinstall and fresh credential reconciliation; completion requires all of that installation’s containers to read back Stopped. Running apps still require post-restore health. Setup restore has a session-bound durable operation status and the shared restore lock. After every restore gate passes and completion is durably recorded, setup restore schedules the normal delayed Control Panel restart to load the reconciled SSO environment. Routing-related stream loss polls the same operation instead of submitting it again; unknown status offers status checking, not a new restore.

Paired core/app restore also preserves the managed Pointer installation, instance, routing owner, selected group and acknowledged protected app credential. Before using the restored secret, reinstall reads the existing Pointer record and checks that every identity and credential preview matches the authenticated archive, with an active owner, no revocation/drift and an acknowledged delivery. A mismatch fails recovery; it does not provision a duplicate, take over routing ownership, rotate the key or archive the existing binding on rollback. Ordinary new installs still require a new credential delivery.
