# Recoverable app updates

A Market app update is a journaled transaction: either the new version commits, or the app is put back exactly as
it was. Code: `control-panel/src/lib/market/update-*.ts` (journal, inventory, admission, provider, PostgreSQL,
recovery) and `updater.ts`.

## Entry points

- `POST /api/market/update` (and the same update in Settings, the Market and embeds): admin session and CSRF token.
  Intermediate steps never report "updated"; pending recovery or cleanup is reported as pending. Provider output
  and exceptions are not returned.
- `GET /api/market/update/status?appId=…`: phase and bounded error codes, never credentials or checkpoint paths.
- `POST /api/market/update/recovery` with `{ appId, id }` (the operation ID from status): runs recovery of that
  operation. Repeated requests are serialized; a finished operation is a no-op. Finished recovery also clears the
  app's retained health warning when no other operation is unfinished.
- On Control Panel start, unfinished operations are reconciled before watchdogs, the update queue or install
  reconciliation start (`reconcileAppUpdateOperations` in `update-operations.ts`).

## Operation kinds

The journal record's `operationKind` selects the recovery provider:

| Kind | What it changes | Provider |
|---|---|---|
| `payload` (or absent) | containers, volumes, database, metadata | `IncusAppUpdateProvider` |
| `release-metadata` | only the app's release registration, for the same build under a new release (e.g. a promotion) | `ReleaseMetadataUpdateProvider` (`update-release-metadata.ts`) |
| `pointer-release-metadata` | the same for Pointer | `PointerReleaseMetadataProvider` (`lib/pointer/release-metadata.ts`) |

A metadata operation reserves the app and its containers, checkpoints only the registration and leaves the app
running. It may not declare runtime, volume or database resources. Product release documents are described in
[releases.md](releases.md).

Native app packages are downloaded from the app's product release (`youeye.product-release.v1`) and checked
against the SHA-256 and size it lists (`native-artifact.ts`).

Accepted product release sequence numbers can move forward during a payload update. They are not part of the
security check before reopening and are kept on rollback; a release that goes backwards is still refused.

## What must be recoverable

An update needs one recovery set for runtime code, durable storage, the app's own database and its control
metadata. Rolling back a container alone does not undo volume changes or SQL migrations.

`planAppUpdateInventory` (`update-inventory.ts`) compares the frozen installed and target manifests, the install
metadata and what Incus and PostgreSQL report. The caller gathers those observations under the lifecycle lock and
checks them again before any effect. The inventory:

- includes every container and its root storage pool;
- counts each custom volume once (by pool and name); a writable subpath makes the whole volume mutable;
- checks declared attachments against the real Incus devices;
- keeps the platform's read-only CA trust mount out of the recovery set (its source, path and options must match
  exactly; any other host path fails);
- requires the old runtime to exist, a supported restore method, space for checkpoints and a cleanup reserve;
- includes the app's dedicated database in the shared PostgreSQL, or its logical database in an app-owned
  PostgreSQL container (never platform or maintenance databases);
- refuses writable shared storage and database writers outside the app (`unsupported-shared-resource`);
- allows unchanged read-only shared inputs;
- refuses container, storage or database topology changes; it does not create new resources.

Database ownership must be proved: the actual owner, scoped logical recovery and every permitted writer. An empty
session list does not prove that no one else can write. Client addresses are matched with `host(client_addr)`
against the app's verified IPs. Security-definer triggers and other executable routines count as possible foreign
writers.

## The journal

`AppUpdateJournalStore` keeps `youeye.app-update.v1` records in `/var/lib/youeye/state/app-updates`:

- private directories, files mode `0600`, atomic replace with fsync; symlinks, special files, bad modes, invalid
  states and records over 1 MiB are refused;
- a record holds digests of the manifests and artifacts, resource identities, the containers' original running
  states, metadata digests, checkpoint references, completed steps, the recovery policy and the commit or rollback
  receipt;
- it never holds credentials, SQL, manifest or metadata bodies or exception text; errors are short public codes;
- sensitive recovery data goes to an operation-scoped workspace encrypted with AES-256-GCM, with a persistent
  private key. A missing key for retained data is an error; a new key is never generated in its place.

Checkpoint methods:

| Resource | Checkpoint |
|---|---|
| container | stopped runtime copy or root snapshot |
| custom volume | volume snapshot |
| dedicated PostgreSQL database | logical recovery point |
| app metadata | scoped metadata recovery point |

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

- The journal reserves app, container, volume, database, metadata and capacity identities in a fixed order. An
  unfinished record blocks other updates even if a lock is missing. Reservations never expire because a PID died
  or time passed. Capacity reservations stop two updates from using the same free-space estimate.
- `withAppLifecycle(appId, work)` holds an OS lock for the whole asynchronous mutation and checks unfinished
  reservations. Update, uninstall, restore, backup, storage changes and credential or admission changes all use
  it. Nested calls share the outer admission.
- `AppUpdateJournalStore.withExecutor(id, work)` holds a Linux `flock` for the executor. Process death releases it
  but keeps the reservations.
- Core backup, full restore, install, uninstall and app restore take a shared installation-inventory lock
  (`withAppInventory`) before per-app locks, so no app appears or disappears between inventory and checkpoint.
- Recovery passes the exact `recoveryOperationId`; that grants nothing outside that operation.

## How the provider runs an update

1. Persist the frozen recovery plan. Turn off app autostart and add an ingress denial owned by the operation.
2. Stop the app's containers, but keep its database engine running for the logical backup. Fence the dedicated
   database and prove no one else writes to it.
3. Checkpoint: stopped runtime copies (their NIC and proxy devices disabled), volume snapshots, a validated logical
   archive and the scoped metadata.
4. Run hooks and migrations under a temporary idle init with services stopped. All code is replaced before any new
   code starts. Generated config, env and commands are applied under the checkpoint; existing credentials and
   settings are kept, not regenerated. Config in custom volumes is written through the volume API while stopped.
5. Start the new version with ingress still fenced. Run first-start migrations and health checks. The whole
   recovery set is kept until the installed version and migrations commit.
6. Verify code identity, installed version, declared health and the original desired state.
7. Reopen: restore the original running states and ingress. An app-owned PostgreSQL engine that was stopped is
   started to fix its grants, then stopped again. The shared platform engine is never started by recovery.
8. Clean up only what the operation owns (copies, snapshots, staging). A cleanup failure cannot undo committed
   data.

On an uncommitted interruption, recovery restores the whole set instead of re-running hooks or SQL. A failed
verification stops writers and fences the database again; `recovery_required` keeps reservations and checkpoints
(`recovery-fence-unverified` when the fence itself could not be set). Only update-owned metadata fields are
restored; newer credentials, grants, admission and deletion markers stay as they are. If security data (service
credentials, admission policy, owners, secret files) changed since the plan, recovery stops instead of copying old
secrets back.

## PostgreSQL rules

- Logical restore targets one dedicated database and keeps the current roles, passwords and grants (grants are
  captured before the drop, saved encrypted, and reused on retry).
- An app-owned PostgreSQL engine keeps its runtime and data volumes; app updates never do major-version upgrades.
- Migration SQL runs as the app's own non-privileged owner, never as an admin with `SET ROLE`. The session must
  already suppress statement, error and duration logging; preload and logging settings are checked first. Unsafe
  settings refuse the migration.
- Restoring an app's own database creates the app owner only from the frozen manifest's `PGUSER` and private
  `PGPASSWORD` secret; the container's `POSTGRES_USER` (default `postgres`) replaces the database. The app role
  gets no superuser or create-database rights. Missing or ambiguous owners are refused.
- An app backup of a stopped app-owned database starts it briefly, dumps it and stops it again.
- Captured `psql` output from an earlier format may start with one known command tag; recovery strips only that
  exact prefix and refuses anything else.

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
| `isAppUpdateReserved(appId)` | advisory only, for status; not a lock |
| `updateNeedsRecovery(record)` | true until `cleanupComplete` |
| `updateResourceKey(resource)` | SHA-256 of `[kind, scope, name]` |

Resource kinds: `app`, `container`, `volume` (scope: pool), `database` (scope: engine), `metadata`, `capacity`. Do
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

## URL changes and watchdog starts

URL reconfiguration holds each app's lock across its env, config, restart, metadata and SSO work, re-reads the
metadata after locking, and resumes an interrupted change only for the same requested URL. Watchdog starts use the
same lock, re-check Incus state, autostart, intent, maintenance and storage, and hold the lock until the Incus
operation ends. Dashboard manifest sync and AI status writes are serialized with these too.

## Tests

The update suite uses fake providers; it proves driver behaviour, not the real thing. Real hook, SQL, runtime and
config failures, process death and reboot, both PostgreSQL ownership kinds, catalog app behaviour and encrypted
backup and restore must be tried on a test VM.
