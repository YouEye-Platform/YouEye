# Setup readiness and retained work

Ordinary managed onboarding checks retained installation acceptance automatically.
It does not offer a routine System/update slide or start an update. The protected
Control Panel identity must match the machine-bound installed manifest, and the
transaction must be absent or terminal. Missing, unreadable, mismatched and
unfinished state interrupts setup with Retry and recovery guidance.

This check reads the protected receipt. Its `payload_observation: not-observed`
does not represent a new scan of installed files or a fresh health check.
Unsupported legacy installations need their supported recovery/update route
outside this ordinary managed wizard.

Actual setup and restore effects also acquire the existing shared platform
lifecycle lock and check readiness. A second exclusive setup lock stays held
through asynchronous effects. A protected, fsynced operation marker contains
only the owner, operation kind and exact operation ID. It survives process loss;
only matching work can enter it. Successful work explicitly settles the marker.
Restore retains that marker on failure. Its fsynced source and step journal in
`/var/lib/youeye/backups/.setup-restore` binds the original owner, browser
session, machine credential digest, operation UUID, drive, recovery point,
selected apps and encrypted input fingerprint. An acknowledged validation
failure can resume the same operation with a corrected recovery key.
`GET /api/setup/restore?operationId=<uuid>` returns `operationId`, `status`,
`phase`, `active`, `recovery`, `messageCode` and safe `message` text, with the
original `mediaId`, `backupId` and `appIds` for new records and
`Cache-Control: no-store`. An active kernel lease means `status: running` and
`recovery: none`; a lost reader must keep checking status. Inactive unfinished
work reports `status: failed` and `recovery: resume`, `finalize` or
`operator-required`. Only explicit `POST /api/setup/restore` with
`action: resume` and the original operation UUID, drive, recovery point,
app selection and body-only recovery key may continue. New requests use
`action: start` (the default). A different request never replaces retained work.
Both POST actions require the original claimed session and CSRF proof.
Safe replacement steps reset from freshly authenticated, fingerprint-matched
input; completed steps are skipped. The importer moves an old cache aside so
it cannot conceal changed bytes on the drive. Finalization records completion
before settlement and never reapplies a completed restore, even if
`setup_completed` is already true or the final SSE response was lost.
Unknown partial app, volume, SQL or routing changes, an unacknowledged native import
or restart, and legacy receipts require operator reconciliation: GET remains
readable, resume returns `409` with `code: operator-required`, and exclusion
stays held. The operator must resolve the original native invocation and its
bound input/applied effects through supported appliance recovery before
settling retained work; changing IDs or deleting markers is not a recovery.
Damaged/unreadable evidence returns `503` and never means no operation exists.
The backup lease now uses a kernel lock; process loss releases the lease while
retaining the setup journal. An old `.operation.lock` remains evidence for
operator recovery and is never stolen by age.
Native System checkpoint admission refuses any retained or unreadable marker.
Deploy the matching Spine implementation before the Control Panel implementation.

The existing setup owner/session, CSRF checks, operation lease, step journal and
restore identity remain authoritative. A disconnected progress reader does not
cancel backend setup or prove success. Errors retain work for reconciliation.
Setup requires successful steps, completion persistence and an acknowledged
Control Panel restart request before settlement. The browser separately waits
for readiness; its timeout remains an error.

If the setup stream disconnects or ends without completion, the browser checks
`GET /api/setup/status` with its existing administrator session instead of
submitting setup again. This read-only response exposes retained step states
and `pending`, `error` or `complete`. Completion requires the persisted config,
identity completion and absence of the validated native setup-operation marker;
config completion alone cannot hide a later native finalization failure.
Unavailable or unsafe evidence never proves completion. After a bounded wait,
Check setup status repeats only this read. Explicit setup errors remain errors,
and a readiness timeout after completion retries only the readiness handoff.

Names enrollment/preview and manual ACME/upload endpoints also enter shared
native admission, with readiness required for setup sessions. Certificate
operations use an exclusive TLS lock. The actual ACME work retains its lock
even when the HTTP wait times out. Uploaded material is bounded and checked for
key match, SAN coverage, issuer signatures and validity before storage or proxy
activation. Activation failures attempt both previous proxy and storage state;
an unconfirmed recovery remains an error. Chain consistency does not prove a
browser trusts its issuer; named-origin connection readback remains required.

The setup wizard retains saved shared MyTitle data and its revision. Saves use
that revision to reject stale appearance updates. Browser Back retains the local
draft; a reload restores saved data, not unsaved secrets or an unsaved draft.
Scoped IBM Plex font assets include their source revision, hashes and licence.

Focused tests cover receipt mismatch/damage/unfinished state, asynchronous lock
contention, retained-operation resume and native System refusal. These source
tests do not prove first deployment, physical restore, browser origin trust or
digest-bound update/recovery acceptance.
