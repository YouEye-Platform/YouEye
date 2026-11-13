# Setup readiness and interrupted setup

The setup wizard (`control-panel/src/app/setup/`, `app/api/setup/*`) changes the whole box: domain, TLS, Caddy,
DNS, Pointer, the Control Panel's and dashboard's YouEye ID clients, or a restore from a backup drive. This page
explains what setup checks before it changes anything, and how it survives a lost browser or a crash.

## Readiness check

Setup does not offer a System update. Before any setup or restore effect it checks that the installed System is
settled (`lib/setup/readiness.ts`, `assertSetupReadiness`):

- Spine's core status (`youeye.core-status.v1`) is managed and has an installed, machine-bound release receipt;
- the Control Panel's component manifest digest equals the installed receipt's `manifest_sha256`;
- there is no update transaction, or the last one is complete (`committed`, `rolled-back` or `cancelled`).

The receipt is the record from install or the last update (`payload_observation: not-observed`); this is not a
fresh scan of the installed files or a health check. If the check fails, setup stops with Retry and recovery
guidance: finish or recover the update first (see [releases.md](releases.md)).

## One setup operation at a time

Setup and restore effects run inside `withSetupMutation` (`lib/setup/lifecycle.ts`):

- they hold the shared platform lifecycle lock (the same one app updates use) and a setup lock
  (`setup-operation.flock`) for the whole asynchronous operation;
- they write a marker `setup-operation.json` (`youeye.setup-lifecycle/1`) in the app-update journal directory
  (`/var/lib/youeye/state/app-updates`). It holds only the owner, the kind (`setup` or `restore`) and the operation
  ID; it is written with fsync and mode `0600`;
- only the same owner, kind and operation ID can continue a marked operation. A different request is refused with
  "An unfinished setup operation must be resumed before another can start";
- successful work removes the marker. A failed restore keeps it;
- a System update checkpoint is refused while a marker exists or cannot be read.

Process loss releases the locks (they are kernel locks) but keeps the marker and journals.

## Setup progress

Setup streams its steps over Server-Sent Events. Steps that must be done: `config`, `caddy`, `dns`, `ai`,
`sso_control`, `sso_ui`. Retrying one step cannot finish a setup whose other steps are unfinished.

If the stream breaks or ends without completion, the browser does not submit setup again. It reads
`GET /api/setup/status` (admin session), which returns each step's state and `pending`, `error` or `complete`.
Complete needs all three: `setup_completed` in `youeye.yaml`, the identity setup finished, and no setup marker. A
saved config alone is not proof. Unreadable evidence returns `503` and never means "done".

Setup ends by asking Spine to restart the Control Panel (to load the new SSO environment). The browser then waits
for readiness; a timeout there is an error, and retrying only repeats that wait.

## Restore during setup

A fresh box can be set up from a backup drive (`POST /api/setup/restore`; `lib/setup/restore-recovery.ts`):

- The restore journal is `/var/lib/youeye/backups/.setup-restore/` (`youeye.setup-restore/1`). It binds the owner,
  browser session, machine credential digest, operation UUID, drive, recovery point, selected apps and a
  fingerprint of the encrypted input.
- New requests use `action: start` (the default). Only `action: resume` with the same operation UUID, drive,
  recovery point, app selection and recovery key (in the body) continues retained work. Both need the claimed
  owner's session and CSRF token.
- `GET /api/setup/restore?operationId=<uuid>` (no-store) returns `status`, `phase`, `active`, `recovery`,
  `messageCode`, `message`, and the original `mediaId`, `backupId` and `appIds`.
  - A running operation reports `status: running`, `recovery: none`; keep polling.
  - An interrupted one reports `status: failed` with `recovery: resume`, `finalize` or `operator-required`.
- A wrong recovery key fails validation and can be resumed with the right key.
- Each retry re-imports the recovery point from the drive (an old import is moved aside first, so changed bytes
  on the drive are never hidden) and skips completed steps.
- Finishing records completion before removing the marker and never re-applies a completed restore.
- A setup restore whose operation ID already has a normal backup-restore status is refused (`409`,
  `operator-required`).

**Operator-required.** If the journal shows partial app, volume, SQL or routing changes that cannot be
reconciled, or an import or restart whose outcome is unknown, `GET` still works, `resume` returns `409` with
`code: operator-required`, and the lock stays held. Resolve it with the appliance recovery tools before going on.
Changing IDs or deleting the marker is not a recovery.

## TLS during setup

Names enrollment and preview, ACME and certificate upload also take the shared lifecycle lock, and need readiness
when called from a setup session. Certificate changes take an exclusive TLS lock (`tls-operation.flock`,
`lib/acme/mutation.ts`); ACME work keeps it even when the HTTP request times out. An uploaded certificate is size
bounded and checked (key match, names, issuer signatures, validity) before it is stored or activated. If
activation fails, the previous proxy and stored certificate are put back; a failed put-back is reported as an
error. A valid chain does not prove that the browser trusts its issuer; setup checks the named origin from the
browser at the end.

## Title in setup

The wizard's title step uses Title Studio ([title-studio.md](title-studio.md)). It keeps the saved shared title and
its revision and sends that revision with each save, so a stale save is refused. Browser Back keeps the local
draft; a reload shows the saved design, not an unsaved draft.

## Tests

`control-panel/tests` cover receipt mismatch, damaged or unfinished state, lock contention, resuming a retained
operation and the System checkpoint refusal. They do not prove a first deploy, a physical restore or browser trust
of the box's origin; check those on a test VM.
