# Recoverable app updates

A Market app update is a journaled transaction: either the new version commits, or the app is put back exactly as
it was. Code: `control-panel/src/lib/market/update-*.ts` (journal, inventory, admission, provider, PostgreSQL,
recovery) and `updater.ts`.

## Entry points

- `POST /api/market/update` (and the same update in Settings, the Market and embeds): admin session and CSRF token.
  Intermediate steps never report "updated"; pending recovery or cleanup is reported as pending. Provider output
  and exceptions are not returned.
- `GET /api/market/update/status?appId=…`: phase and bounded error codes, never credentials or checkpoint paths.
  Beside the `operation` record it gives `result`, what the app's last update said as it returned (`operationId`,
  `success`, `errorCode`, `message` in the stream's words, `at`; kept in memory, so none after a Control Panel
  restart), `results` (the app's last five such results, newest last, so a later update of the app does not hide an
  earlier one's), `running` (an update of the app is on its way to a result in this Control Panel) and `market`
  (false for a built-in app, which its own updater updates). The update stream's progress events carry
  `operationId` once the update's operation exists, so a client whose stream drops follows its own result.
- `POST /api/market/update/recovery` with `{ appId, id }` (the operation ID from status): runs recovery of that
  operation. Repeated requests are serialized; a finished operation is a no-op. Finished recovery also clears the
  app's retained health warning when no other operation is unfinished.
- On Control Panel start, unfinished operations are reconciled before watchdogs or install reconciliation start
  (`reconcileAppUpdateOperations` in `update-operations.ts`). The same pass clears finished operations' recovery
  labels and deletes finished receipts older than 30 days (with their `executors/<operation>.lock`), keeping each
  app's latest receipt and any whose labels could not be cleared.

## Operation kinds

The journal record's `operationKind` selects the recovery provider:

| Kind | What it changes | Provider |
|---|---|---|
| `payload` (or absent) | containers, volumes, database, metadata | `IncusAppUpdateProvider` |
| `release-metadata` | only the app's release registration, for a newer release that carries the installed payload (the same build under another name is no update since 0.6.17, [native-apps.md](native-apps.md)) | `ReleaseMetadataUpdateProvider` (`update-release-metadata.ts`) |
| `pointer-release-metadata` | the same for Pointer | `PointerReleaseMetadataProvider` (`lib/pointer/release-metadata.ts`) |

A metadata operation reserves the app and its containers, checkpoints only the registration and leaves the app
running. It may not declare runtime, volume or database resources. Product release documents are described in
[releases.md](releases.md).

A native app's release is adopted this way when the new release document names the identical build (byte-equal
build manifest, same artifacts) and its manifest equals the installed copy apart from the version labels (`version`
and `frozen.version`) and the listing files (`metadata.iconUrl`, `detail.screenshots`); the frozen source text, setup
files and digest must be equal. The record's `productReleaseSHA256` then names the adopted document, so the next
check says "already up to date". A stopped app takes the ordinary update instead (adoption needs the running runtime).
A rollback is verified against the stored (JSON) form of the registration. Installed copies are cached per app by
the record's `manifestDigest` and version: a native app's digest is its Market listing's and does not change with its
release.

Native app packages are downloaded from the app's product release (`youeye.product-release.v1`) and checked
against the SHA-256 and size it lists (`native-artifact.ts`).

Accepted product release sequence numbers can move forward during a payload update. They are not part of the
security check before reopening and are kept on rollback; a release that goes backwards is still refused.

## What must be recoverable

An update needs one recovery set for runtime code, durable storage, the app's database and its control metadata.
Rolling back a container alone does not undo volume changes or database migrations.

`planAppUpdateInventory` (`update-inventory.ts`) compares the frozen installed and target manifests, the install
metadata and what Incus and PostgreSQL report. The caller gathers those observations under the lifecycle lock and
checks them again before any effect. The inventory:

- includes every container and its root storage pool;
- counts each custom volume once (by pool and name); a writable subpath makes the whole volume mutable;
- checks declared attachments against the real Incus devices;
- keeps the platform's read-only CA trust mount out of the recovery set (its source, path and options must match
  exactly; any other host path fails);
- requires each container to have exactly one NIC on its own app network; further NICs must be connections
  (`net-<app>`) with an active network connection to that app, its network and its scoped ACL; and every active
  network connection must still have its NIC (`connection-interface-missing`);
- requires the old runtime to exist, a supported restore method, and free space on the pools of the app's root and
  own volumes: on ZFS and btrfs the root in full (a rebuild rewrites it) plus 10 % of its volumes plus 1 GiB, elsewhere
  twice root and volumes plus 10 %; a Postgres dump's staging always counts in full. Only the root device's usage is
  read from the instance state (Incus lists custom volumes there too); shared folders never count;
- includes the app's dedicated database in the shared PostgreSQL (never platform or maintenance databases);
- treats a database the app runs itself (`database: { sidecar: … }`) as what it is: one of the app's containers and
  its volumes. The engine's database files must be in declared volumes, at least one writable, that no other
  container mounts (`own-database-storage-undeclared`, `unsupported-shared-resource`). There is no database
  resource for it (see [Databases](#databases));
- leaves **shared folders** (`shared:` groups such as `media`) out of the recovery set: they are never checkpointed,
  restored, reserved or counted, whoever writes them; their definition must not change
  (`shared-input-definition-changed`); the result names them;
- refuses app storage and database writers outside the app (`unsupported-shared-resource`);
- refuses container, storage or database topology changes; it does not create new resources.

A database in the shared PostgreSQL must prove its ownership: the actual owner, scoped logical recovery and every
permitted writer. An empty session list does not prove that no one else can write. Client addresses are matched
with `host(client_addr)` against the app's verified IPs. Security-definer triggers and other executable routines
count as possible foreign writers.

## The journal

`AppUpdateJournalStore` keeps `youeye.app-update.v1` records in `/var/lib/youeye/state/app-updates`:

- private directories, files mode `0600`, atomic replace with fsync; symlinks, special files, bad modes, invalid
  states and records over 1 MiB are refused;
- a record holds digests of the manifests and artifacts, resource identities, the containers' original running
  states, metadata digests, checkpoint references, completed steps, the recovery policy and the commit or rollback
  receipt;
- records are `operations/<appId>_<operationId>.json` (receipts written before 0.6.9 keep `<operationId>.json`). A
  record that can't be read blocks only the app its file name names: that app's admission, recovery and status
  refuse, other apps go on, and the Control Panel raises a critical issue naming the file. A damaged record with no app
  in its name blocks every app, and box-wide readers (copy, Spine's System-update barrier) refuse on any damage;
- it never holds credentials, SQL, manifest or metadata bodies or exception text; errors are short public codes;
- sensitive recovery data goes to an operation-scoped workspace encrypted with AES-256-GCM, with a persistent
  private key. A missing key for retained data is an error; a new key is never generated in its place.

Checkpoint methods:

| Resource | Checkpoint |
|---|---|
| container | stopped runtime copy (`ye-rollback-…`, its NIC and proxy devices masked) |
| custom volume | volume snapshot (`update-<operation>`) |
| database in the shared PostgreSQL | logical recovery point |
| app metadata | scoped metadata recovery point |

A database the app runs itself has no row of its own: its restore point is its engine's runtime copy and its
volumes' snapshots, taken with the whole app cleanly stopped.

Providers verify that a checkpoint exists, is complete, is the right one and can be restored before recording it.
Raw PostgreSQL directories are never moved between database versions. Volume snapshots are tagged so an
interrupted snapshot can be reconciled; foreign metadata edits are refused.

## Phases

`preflight` → `quiescing` → `checkpointing` → `prepared` → `applying` → `verifying` → `committed` → `cleanup`.
Failure goes to `recovering`, then `rolled_back` or `recovery_required`.

- Each external operation is recorded as a step intent first and acknowledged only after its outcome is observed.
  A step ID is never reused to replay a migration. After an interruption, the actual state is reconciled and the
  checkpoint restored rather than retried.
- `prepared` needs verified checkpoints for every mutable resource. Commit and verified rollback need every earlier
  step reconciled.
- The commit receipt survives cleanup errors; committed data is never rolled back because a temporary checkpoint
  could not be deleted.
- Reservations are released one by one, each with its own intent; cleanup is complete only when all are released.

## Locks

- The journal reserves the app's own app, container, volume, database and metadata identities in a fixed order. An
  unfinished record blocks other updates of the same resources even if a lock is missing. Reservations never expire
  because a PID died or time passed. Nothing is reserved that another app's update also needs (no shared capacity or
  shared-folder reservations, since 0.6.9), so one stuck update never blocks other apps' updates. Instead the CP runs
  one app update at a time (an in-process queue in `updater.ts`); free space is re-checked when the recovery plan is
  initialized. The maintenance fence's Caddy write is serialized with the CP's other Caddy writers and retried on a
  revision conflict.
- `withAppLifecycle(appId, work)` holds an OS lock for the whole asynchronous mutation and checks unfinished
  reservations. Update, uninstall, restore, backup, storage changes and credential or admission changes all use
  it. Nested calls share the outer admission. While it runs, the app is marked held in this process (probes read
  that instead of taking the lock), and its begin and end are announced to the app's reconcile queue, with who took
it: `user` inside `withUserOperationLockWait`, else `background`
  ([control-panel.md](control-panel.md#app-health-and-automatic-restarts)).
- `AppUpdateJournalStore.withExecutor(id, work)` holds a Linux `flock` for the executor. Process death releases it
  but keeps the reservations.
- Core backup, full restore, install, uninstall and app restore take a shared installation-inventory lock
  (`withAppInventory`) before per-app locks, so no app appears or disappears between inventory and checkpoint.
- Recovery passes the exact `recoveryOperationId`; that grants nothing outside that operation.

## Stops and starts

Containers are stopped cleanly (`stopContainer` in `lib/incus/snapshot.ts`): Incus asks the container to shut down
(`force: false`) and waits. A container still running after the timeout raises `ContainerStopTimeoutError`; nothing
is killed. The timeout (`stopTimeoutSec`) is 120 s for a container with role `database` and 60 s for every other.
Only the timeout is a timeout: a stop that Incus refuses or fails early (another operation on the instance, a dropped
connection) leaves the container its whole time, its state is read every second until then, and it counts as stopped
if it stops meanwhile. Such a stop may never have reached the container, so the clean stop is asked again every 5 s
while it still runs, with the time that is left: a container is never killed at the deadline without having been
asked to shut down. A stop that Incus took is not asked twice. A stop that ends in any other state (the container is gone) throws the real error.

Outside updates, a stop or restart that must succeed (`stopContainerOrForce`, `restartContainer`) is the same clean
stop with the container's role timeout, forced only after it, with the logged warning "[incus] `<container>` did not
stop cleanly within N s; forcing it to stop". That covers the owner's stop and restart, uninstall, app restore,
credential quiescence, the restarts after a URL, AI, site-name or SMTP change, a setup file's `restart` step, and the
stops of an app whose network could not be verified or is gone. A restart restarts only a running container. Incus is
asked for a forced stop directly only for a container that is deleted right after (a test checks every source file).

The order comes from each container's role (`orderContainers` in `lib/apps/container-order.ts`):

- **stop:** app, worker, sidecar, cache, database, so a database loses its clients first;
- **start:** database, cache, sidecar, worker, app.

Within one role the declared order holds (reversed for a stop). The role is the install record's (`database` for
the container named by `database: { sidecar: … }`). The primary (main) container is always `app`. Any other
container's role is read from its own name in the manifest (the part after `app-<id>-`, never the app id): a name
containing `postgres`, `mysql`, `mariadb`, `mongo` or `database`, or the word `db`, gives `database`; `redis`,
`valkey`, `keydb`, `memcached` or `cache` give `cache`; `worker`, `queue`, `cron`, `scheduler` or `job` give
`worker`; anything else is `sidecar`.

- **Quiesce** stops every container in stop order. A timeout ends the update before its first checkpoint:
  `writer-stop-timeout`, "Update not started: `<container>` did not stop in time. Nothing was changed." Recovery
  restores nothing (nothing changed), starts what was stopped and reopens the app.
- **Recovery** (restore and the recovery fence) tries a clean stop twice. It forces the stop only when a kill can
  cost nothing: every restore point the plan needs for that container exists (its runtime copy and the snapshot of
  each mutable volume it mounts), and the update had reached its apply phase (an `applying` or `verifying` step on
  the record), which is when `restore()` puts the restore points back. It then logs "[app-update] `<app>`
  `<operation>`: `<container>` did not stop cleanly during recovery; forcing it (its restore point exists and is
  restored next)". Before the apply phase nothing is restored, so nothing is killed: the stop stays clean and
  recovery is retried. A restore point is never taken from a killed container.
- **Reopen** after a commit uses clean stops only: the data is live, so a container that does not stop leaves the
  reopen pending (retried by recovery) instead of being killed.
- **The migration runner's** idle init (`trap : 1 2 3 15 28 30 37; sleep 86400 & wait`) ends on the signals a
  clean stop sends; a bare `sleep` as PID 1 would ignore them and wait out the timeout.

Starts (`startRuntime`, `verifyRestored`) follow start order, and a `database` or `cache` container must be ready
before the next one starts: the app's own PostgreSQL engine, or any container with a `postgres` health check,
answers `pg_isready -U <app user>` inside the container; any other one passes its declared HTTP health check, if it
has one. Logs are never parsed. The app's own health checks run once every container is up. The rule is
`readinessCheck` in `lib/apps/container-readiness.ts`; the reconcile queue and installs start containers in the same
order, and the queue waits for the same readiness. The check comes from the manifest of the version that runs: the
new one for the first start and for a reopen after a commit (the installed frozen copy; if it cannot be read the
plan's is used and that is logged), the plan's (old) one after a rollback.

## How the provider runs an update

1. Persist the frozen recovery plan. Turn off app autostart and add an ingress denial owned by the operation.
2. Stop every container cleanly in stop order, the database last. Fence a database in the shared PostgreSQL and
   prove no one else writes to it.
3. Checkpoint: stopped runtime copies (their NIC and proxy devices masked as `none`), volume snapshots, a validated
   logical archive of a shared-PostgreSQL database, and the scoped metadata.
4. Run hooks and migrations under a temporary idle init with services stopped. All code is replaced before any new
   code starts; the app's own database engine is not rebuilt and keeps its image, environment and configuration.
   Generated config, env and commands are applied under the checkpoint; existing credentials and settings are
   kept, not regenerated. A secret new in the release (never declared by the installed version) is generated first, one journal step
   each (`generate-secret-<name>`, since 0.6.20). Config in custom volumes is written through the volume API while
   stopped.
5. Start the new version in start order with ingress still fenced. Re-point the app's connection ACLs and check
   every connection NIC is still there (`verify-connections`). Run first-start migrations and health checks. The
   whole recovery set is kept until the installed version and migrations commit.
6. Verify code identity, installed version, declared health and the original desired state.
7. Reopen: give a shared-PostgreSQL database its original grants back while the app's containers are stopped, then
   restore the original running states in start order, autostart and ingress. The shared platform engine is never
   started by recovery.
8. Clean up only what the operation owns (copies, snapshots, staging). A cleanup failure cannot undo committed
   data.

On an uncommitted interruption, recovery restores the whole set instead of re-running hooks or SQL:

- every container is stopped (recovery stops above);
- each runtime copy is copied again and swapped in under the container's name with the original devices and
  profiles;
- the restored container gets the original MAC addresses (`volatile.<nic>.hwaddr`) in a write of their own:
  putting a masked NIC back makes Incus clear that NIC's volatile keys, a MAC set in the same request included. The
  container keeps its address on the app network, so Caddy routes, doorways and connections keep working. A MAC
  write that Incus refuses ("the MAC addresses of restored `<container>` could not be written") or a MAC that does
  not hold is logged ("did not keep its MAC addresses") and the rollback goes on;
- volumes go back to their snapshots, a shared-PostgreSQL database to its logical archive, and the update-owned
  metadata to its checkpoint (the shown `credentials` included, since 0.6.20);
- the secrets the journal's `generate-secret-<name>` steps name are deleted (intended or completed: an absent one is
  fine); no other secret is touched;
- the containers that ran before start again in start order.

A failure before the apply phase restores nothing: what still runs keeps running, and the rest is started. A failed
verification stops writers and fences the database again; `recovery_required` keeps reservations and checkpoints
(`recovery-fence-unverified` when the fence itself could not be set). Only update-owned metadata fields are
restored; newer credentials, grants, admission and deletion markers stay as they are.

**Security state** (`securityParts` in `update-provider.ts`): the app's own security fields of install.json (owner,
installation, sign-in, domain, database identity, shared folders, storage, AI connection, credential state; never
fields the update writes, such as the shown `credentials`, nor `updatedAt`), every file under its app directory (`secrets/` included,
bounded; links and devices refused), its credential projection, its admission policy (revision and state, no
timestamps; no box-wide user list: the policy revision moves whenever this app's admission changes) and its
non-private admission resources. It is compared only in `restore()`, after the generated secrets are deleted,
and only to log: a rollback never restores
security state (the credential and install record can't change meanwhile: their writers need the app lock the update
holds), and an unreadable state never blocks recovery. Reopening after a commit compares nothing, and the PostgreSQL fence checks only the
operation and database identity. Operations stuck on builds before 0.6.9 therefore finish at the next Control Panel
start.

**An uncommitted update whose rollback is not verified** (`recovery_required`, or recovery still unfinished when the
update returns) returns `errorCode: 'recovery_required'`, whatever failed first: "The update failed and the app could
not be brought back: it stays in maintenance and its recovery points are kept. Retry recovery (youeye app recover
<app>)…". A first failure's own message ("Nothing was changed." after a stop timeout) is shown only once its rollback
is verified. Such an operation is still pending when the update returns, so the update API (`update-http.ts`,
`pendingUpdateReport`) answers it as pending with that message and `code: 'recovery_required'`: JSON `409` with
`status: 'pending'`, the stream a `pending` event. Other pending operations keep `code: 'operation_pending'`: a
committed one says what did not finish (below), and one that was rolled back with only its cleanup left says "Update
pending. Check its status or retry recovery."

**A committed update whose reopen did not finish** returns `success: false` with `errorCode:
'committed-reopen-pending'` (never "success" while the app is in maintenance); after a reopen, a later failure
(cleanup, access reconciliation) is `committed-post-update-failed`. The status's `reopened` tells the two apart. Every
failure, including recovery at Control Panel start, logs its cause.

## Databases

### A database the app runs itself

An app update's restore point for a database the app runs itself (`database: { sidecar: … }` in the manifest,
`database.mode: own` in the compiled model) is a snapshot of its volumes taken with the whole app cleanly stopped,
together with a copy of its old containers. No login, dump or engine knowledge is involved, so any engine, login
setup and extension set works (Immich: PostgreSQL 14, one `immich` superuser, vector extensions).

- The engine's files must be in declared volumes (its `data:`), at least one writable, that no other container
  mounts (`own-database-storage-undeclared`, `unsupported-shared-resource`).
- The engine's image never changes inside an app update (`postgres-runtime-change-excluded`): its files open only
  with the same engine version and extensions. The engine container is not rebuilt and keeps its environment and
  configuration. A major-version change (Immich's PostgreSQL 14 → 18) needs a declared migration step of its own,
  which does not exist yet.
- SQL migrations run in the shared PostgreSQL only; with the app's own database they are refused
  (`sql-migration-own-database-unsupported`).
- Any other sidecar with volumes (MariaDB, Valkey, SQLite in a volume) needs nothing more: it is a container with
  volumes like the rest of the app, stopped cleanly, snapshotted and restored with it.

App backups are different: they dump an app-owned PostgreSQL logically with the app's own login
(`backup.ownPostgres`, compiled from `database: { sidecar: … }`; `lib/backup/app-backup.ts`), because a backup must
survive a version change and a snapshot does not.

- A backup of a stopped engine starts it briefly, dumps it and stops it again.
- Restoring an app's own database creates the app owner only from the frozen manifest's `PGUSER` and private
  `PGPASSWORD` secret; the container's `POSTGRES_USER` (default `postgres`) replaces the database. The app role
  gets no superuser or create-database rights. Missing or ambiguous owners are refused.

### The shared PostgreSQL

A database in the shared platform PostgreSQL keeps its logical checkpoint: one database inside a shared server
can't be snapshotted alone.

- Logical restore targets one dedicated database and keeps the current roles, passwords and grants (grants are
  captured before the drop, saved encrypted, and reused on retry).
- Migration SQL runs as the app's own non-privileged owner, never as an admin with `SET ROLE`. The session must
  already suppress statement, error and duration logging; preload and logging settings are checked first. Unsafe
  settings refuse the migration.
- Captured `psql` output from an earlier format may start with one known command tag; recovery strips only that
  exact prefix and refuses anything else.

## Refusals

Refusals for databases and stops, with their messages from `lib/market/update-http.ts`:

| Code | When | Message |
|---|---|---|
| `writer-stop-timeout` | a container did not stop within its timeout while the update quiesced the app, and the app was brought back | "Update not started: `<container>` did not stop in time. Nothing was changed." (the provider's message, naming the container) |
| `recovery_required` | an update failed (for any reason, a stop timeout included) and its rollback could not be verified | "The update failed and the app could not be brought back: it stays in maintenance and its recovery points are kept. Retry recovery (youeye app recover <app>); the cause is in the Control Panel journal." |
| `postgres-runtime-change-excluded` | the new version changes the image or type of the app's own database container | "Update not possible in place: the new version changes the app's own database engine. Nothing was changed." |
| `sql-migration-own-database-unsupported` | an SQL migration for an app with its own database (no manifest field declares SQL migrations today) | "Update not possible in place: it runs an SQL migration, which an app with its own database can't use. Nothing was changed." |
| `own-database-storage-undeclared` | the app's own database engine has no writable declared volume of its own | "Update not possible in place: this app's own database does not keep its files in a declared volume of its own, so no restore point can be taken. Nothing was changed." |

Boxes before 0.6.14 refused every app with its own PostgreSQL that had extensions or a single superuser login
(`own-postgres-update-unsupported`), and one without `backup.ownPostgres` (`own-postgres-recovery-undeclared`);
neither code exists now.

## Integration contract for security and policy writers

Code that changes an app's credentials or access policy uses the same lock. Check the caller's authorization
first, then hold the lock through the whole change:

```ts
import { withAppLifecycle } from '@/lib/market/update-admission';

await withAppLifecycle(appId, async () => {
  // read the current state and persist the change here; await everything
  await mutateAppSecurity(appId);
});
```

(`mutateAppSecurity` stands for your own code.) Re-read generations and policy inside the callback. Detached work
loses the lock when the callback returns.

| Interface | Contract |
|---|---|
| `withAppLifecycle(appId, work, options?)` | serializes changes to one app across processes; an unfinished update refuses with `AppLifecycleAdmissionError` (`recovery_required`) |
| `options.resources` | also checks these resource identities against unfinished updates |
| `withContainerLifecycle(name, work, options?)` | container actions: resolves the owning app from records (never by splitting the name) and checks recovery-copy markers |
| `withAppLifecycles(appIds, work)` | several apps, locked in sorted order |
| `options.automatic` | the reconcile queue's own hold: the app is marked held, but no begin or end is announced |
| `isAppUpdateReserved(appId)` | advisory only, for status; not a lock |
| `isAppHeld(appId)` | an operation of this process holds the app; for probes, not a lock |
| `updateNeedsRecovery(record)` | true until `cleanupComplete` |
| `updateResourceKey(resource)` | SHA-256 of `[kind, scope, name]` |

Resource kinds: `app`, `container`, `volume` (scope: pool), `database` (scope: engine), `metadata`; `capacity` is
still read in records written before 0.6.9 and no longer created. Do
not add credentials, policy bodies or other fields to the journal record.

The service credential store holds the same lock for its reads and writes
([app-service-credentials.md](app-service-credentials.md)). Core backup and full restore hold every affected app's
lock plus the shared identity and Pointer locks; user creation and deletion hold the identity lock. Pointer backup
stops its writers for the dump and file capture, then restores its running state.

## Restore and setup

- Setup restore rebuilds a pending installation only after the archive's and the box's ownership, installation
  and owner UUIDs match; it never changes grants or makes a policy ready. Archived stopped/disabled intent
  survives; running apps must pass health after restore. Setup restore then schedules the normal Control Panel
  restart to load the SSO environment ([setup-readiness.md](setup-readiness.md)).
- A paired core and app restore keeps the managed Pointer installation, routing owner, group and acknowledged app
  credential. Every identity and credential preview must match the archive; a mismatch fails the restore instead
  of creating a duplicate or rotating the key.

## URL changes and automatic starts

URL reconfiguration holds each app's lock across its env, config, restart, metadata and SSO work, re-reads the
metadata after locking, and resumes an interrupted change only for the same requested URL. Automatic starts of app
containers go through the app's reconcile queue (`lib/apps/app-reconciler.ts`): it takes the same lock, re-checks
Incus state, autostart, intent, maintenance and storage under it, and holds it until the Incus operation ends. An
app reserved by an update is never touched; a user operation waiting for the lock goes first
(`isUserOperationWaiting`), for at most two minutes, also while the queue waits for a database under the lock. The
queue runs outside the context of the operation whose end asked (`outsideOperation`), and a reconfigure restarts an
app for the platform keys only when a value changed, once. Dashboard manifest sync and AI status writes are serialized
with these too. How the queue works: [control-panel.md](control-panel.md#app-health-and-automatic-restarts).

## Tests

The update suite uses fake providers; it proves driver behaviour, not the real thing. Real hook, SQL, runtime and
config failures, process death and reboot, both PostgreSQL ownership kinds, catalog app behaviour and encrypted
backup and restore must be tried on a test VM.
