# App service credential contract

The v1 source connects strict current-generation verification, protected runtime
provisioning, readiness and administrator lifecycle actions. Every authenticated
app service request requires a valid Bearer credential bound to the exact installed
app ID. A registration without credential metadata grants no service access.
The service resolver also checks the stable active acting user and local
household admission. Credential operations share app lifecycle exclusion with
updates and restore; current credential/admission revisions are part of update
security observations. Source integration does not establish installed acceptance.

An app credential authenticates the source of an event. Timeline and notification
ingestion bind that source to the canonical authenticated app; a conflicting
`app_id` in the request body is rejected. A valid app credential does not authorize
the administrator user directory or browser administration routes.

## Authority and secret storage

Control Panel owns one protected credential record per canonical installed app
under `/var/lib/youeye/state/app-service-credentials`. This directory is separate
from app data and container checkpoints. An ordinary app rollback must not
overwrite it.

The secret contains 256 bits of cryptographically random material. V1 defaults
to no expiry, with explicit rotation and revocation. Secrets belong only in this
protected record and server runtime configuration. They must not appear in app
manifests, browser responses, frontend bundles, URLs, logs, or operator status.

Records use immutable installation IDs, generations within an installation,
and revisions that continue across reinstall. Secret files are owned by the
Control Panel process user and have mode `0600`; directories have mode `0700`.
Reads and writes share a filesystem lock. Atomic rename and directory sync finish
before a secret can be returned to a caller.

Ordinary config rendering reads the current record; it never provisions a
missing credential. Missing/corrupt records, unfamiliar ownership/permissions,
and symlinks require repair and deny authentication. An existing directory with
no record is not treated as a new installation.

## Versioned verifier publication

`POST /api/ui-bridge/app-credentials/[appId]` accepts only the authenticated
Control Panel bridge. App credentials and browser/admin cookies do not authorize
this operation, and a wrong bridge credential cannot fall back to a cookie.

The JSON envelope contains exactly `credential` and `expectedRevision`, or
`credentials` and `expectedRevision` for a durable outbox batch. Batches apply only
the final projection atomically; an intermediate retired generation is never
made visible. Acknowledgement removes only committed outbox entries. A backlog
that cannot be published refuses further credential mutation.
The credential projection has these fields:

| Field | Meaning |
| --- | --- |
| `schema` | `youeye.app-service-credential/1` |
| `appId` | Exact canonical registration ID |
| `installationId` | Immutable installation UUID |
| `generation` | Positive generation within this installation |
| `revision` | Monotonic publication revision across installations |
| `status` | `prepared`, `active`, or `revoked` |
| `verifierHash` | SHA-256 verifier, never the raw secret |
| `createdAt` | Installation credential creation time |
| `rotatedAt` | Rotation time, or null for generation one |
| `revokedAt` | Revocation time, present only for revoked records |
| `expiresAt` | Explicit expiry, or null |

Timestamps use canonical UTC ISO format. Unknown fields, including a raw secret,
are rejected. Publication requires the expected current revision and exactly
the next revision. Repeating an identical acknowledged publication is a no-op.
A delayed publication, skipped revision, changed hash within a generation, or
reactivation of a revoked/retired generation is rejected.

UI persists projections in `app_service_credentials`. This table deliberately
has no foreign key to app data: deleting an app registration must not erase the
credential revision tombstone. First publication is serialized even when no row
exists, using a transaction advisory lock. Non-revocation publication requires an
existing app registration.

Responses contain status, generation, revision and installation identity, with
no verifier hash or secret. Malformed input yields 400, failed authentication
401, a revision/lifecycle conflict 409, and verifier unavailability 503.

## Lifecycle ordering and recovery

The lifecycle coordinator requires a transport adapter that holds the shared
app/container maintenance lease, marks integration pending, quiesces the app,
and writes protected runtime configuration through the installer. It publishes
the prepared verifier, persists activation, publishes the active verifier,
restarts, performs an actual scoped service probe, and only then marks ready.

Lifecycle operations use the frozen manifest for the exact installed version and
preserve its recorded network mode. Native probes allow up to twenty seconds for
transport readiness after restart; an HTTP authentication denial fails
immediately. Updates must also pass that native probe before committing.
Pending credential operations suspend and publish current admission; successful
readiness restores and publishes admission without changing grants or owners.

If configuration, bridge publication, restart or probe fails, integration remains
pending. Retries reuse the protected operation/generation. They roll forward
after activation; they never restore a retired secret. Revocation erases the
local secret and publishes its tombstone while retaining the quiesced state.
A failed bridge acknowledgement must not be reported as completed revocation.

Credential lock recovery checks the owner's boot identity, PID and process start
time. It cannot steal a live lock or guess the owner of an incomplete lock.
Reinstall requires explicit ownership adoption after revocation and creates a
new installation identity and secret while retaining revision ordering.
The Market installer performs this credential adoption only after its existing
resource ownership preflight succeeds under the app lock, including a deliberate
install following keep-data uninstall. Interrupted retries keep that new
installation and generation. Rendering and reconcile cannot adopt a revoked
record, and an absent or corrupt record in an existing credential directory
still requires repair.

## Readiness and operator actions

The UI stores readiness independently from the credential projection. Publication
of a changed projection clears readiness. `GET /api/apps/v1/credential-probe`
accepts only the active current credential, even while unready, and returns only
its canonical app ID. It exposes no user or platform data. Normal authenticated
service routes reject that generation until readiness has been recorded.

The bridge-only `POST /api/ui-bridge/app-credentials/[appId]/ready` takes the exact
`installationId`, `generation` and `revision`, plus optional Boolean `ready`.
`ready: false` suspends integration without issuing a credential. The true
transition follows protected runtime readback, current-verifier proof and, for
native apps, an actual request from the app container's protected environment.
An expired generation cannot be marked ready. A stale receipt cannot open a
newer generation.

Administrator `GET /api/market/credentials/[appId]` reports non-secret state,
generation, revision, operation and outbox progress. Administrator and CSRF
protected `POST` accepts one of:

- `{"action":"provision"}` to provision a missing installation record.
- `{"action":"reconcile"}` to roll forward the persisted generation.
- `{"action":"rotate","expectedRevision":2}` to retire current material.
- `{"action":"revoke","expectedRevision":2}` to revoke and stop the app.
- `{"action":"reinstall","expectedRevision":3}` after explicit ownership adoption
  and revocation, creating a fresh installation identity.

Revision numbers are examples; read the current status before a mutation.
Reconciliation must never guess a missing/corrupt secret. Install/config refresh
reads the protected record. Ordinary integration changes suspend readiness and
probe the same generation before reopening. Failed probes stop writers and leave
pending metadata for deliberate repair. The native env file is private and read
back after writing. OCI environment changes also require exact readback.
Credential-bearing templates are restricted to private `/etc` files in v1;
browser-public env mappings and public config paths are refused.

## Encrypted restore and revision recovery

App/core backup metadata records secret-free credential provenance. Runtime
exports remain encrypted and can include old configuration, but restore never
adopts their Bearer credential as destination authority. The protected authority
is outside the app/core volume restore set, preserving newer target tombstones.

Before reinstall, the authenticated restore worker reads the current UI projection
through `/api/ui-bridge/app-credentials/[appId]/restore-fence`. Its POST compares
that exact observation and can cross a revision gap **only to publish a revoked
projection**. It cannot activate or restore a secret, rewind revisions, or affect
another app. Lost acknowledgement reuses the durable tombstone. Normal publication
retains its stricter sequential compare-and-set contract.

Restore then prepares a new installation credential, defers installer readiness,
reinjects only credential-bearing runtime configuration after archived data has
been applied, and probes before reopening service access. Full/core database
restore keeps UI stopped until all restored credential rows have readiness cleared.
A verifier suspension failure leaves UI unavailable for explicit recovery.

A different destination gets a different installation identity and secret. The
source remains independently active unless explicitly revoked there; restoring
an archive does not remotely revoke a separate machine. Historical full-server
restore can restore historical accounts/configuration/data, but app runtime
credentials are still replaced and retained target tombstones are not rewound.
An explicit partial selection, including a core-only selection with no app
archives, retains other installed runtimes. Before changing core state, their
archived routing and SSO installation identities must match the target; otherwise
restore refuses and asks for the corresponding app archives. Retained apps stay
stopped with pending intent, and their target network leases are preserved.
An equal verifier preserves the protected secret and generation. If the restored
UI is older, a durable deny-only restore fence precedes a new generation within
the same retained installation. Retrying the fence resumes that operation;
an explicitly revoked target record remains revoked. Missing target authority
requires repair and cannot be imported from archived hashes. Reconciliation
reinjects/probes before readiness; failure leaves stopped, pending runtimes.

This credential reconciliation is implemented and covered with filesystem and
database tests. Real encrypted core/app restore, whole-operation lifecycle
exclusion and combined ownership/update rollback remain integration acceptance;
do not infer those passes from this protocol.

## Integration and acceptance still required

The acting-user path must consume the accepted household local projection evaluator
and active principal mapping before final integration. UI must not request policy
from CP or duplicate its tables. Existing runtime permissions remain additional
checks. Service context always has `isAdmin: false`; app credentials cannot grant
browser/admin authority. Explicit machine headers cannot fall back to a browser
cookie. Canonical app identity is exact, with no implicit `ye-`/`app-` prefix alias.

Every native backend must derive acting user from its validated server session.
The six supported apps and Canvas use server-only helpers that require protected
runtime identity and replace all supplied authority headers; missing credentials
fail before an unsigned request. Public health/manifests retain their separate
public contracts.

Real authenticated native/Canvas flows, competing lifecycle operations, same-target
rollback and fresh-target encrypted restore remain required acceptance. Shared
migration-journal integration must retain newer credential/grant authority across
checkpoints. Quick artifacts do not prove the combined signed beta matrix.

## Isolated production HTTP regression

`ui/tests/app-credential-http.spec.ts` exercises the built Next.js server and
production database queries, including private settings, browser administration,
malformed/mixed machine authority with a valid admin cookie, expired/disabled/
revoked credentials, verifier-store failure, runtime permissions and event source
binding. It starts its server on loopback with synthetic session signing material.

Build the same source first with `pnpm --dir ui build`. Provision a disposable
PostgreSQL database whose name starts with `credential_acceptance_`, and supply
its connection string through the protected `APP_CREDENTIAL_TEST_DATABASE_URL`
environment variable. Then run from `ui`:

```sh
APP_CREDENTIAL_HTTP_TEST=1 pnpm exec node --import tsx --test tests/app-credential-http.spec.ts
```

The test seeds only synthetic identities and credentials. Its unavailable-store
case temporarily renames a table in that isolated database. Never point it at an
installed UI database. Remove the database and its role after the run. The default
suite skips this separately enabled test; a skipped result is not HTTP acceptance.
This regression does not replace deployed native-app or restore acceptance.

Restore-fence acknowledgment is idempotent when the destination already holds
the exact revoked projection, including a fresh read that observes that same
fence. This confirms existing denial and never grants access. An inconsistent or
ahead expected projection at the same or a later revision remains a conflict,
and activation must still use the ordinary sequential generation transition
after a new installation is prepared.
