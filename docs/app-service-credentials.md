# App service credentials

An installed app talks to the dashboard's service APIs (Timeline, notifications, profile, connections, …) with a
**service credential**: a Bearer secret bound to that one app. This page covers how the Control Panel makes,
stores, publishes, rotates and restores it. Code: `control-panel/src/lib/apps/service-credential-*.ts`,
`shared/app-service-credential.ts`, and on the dashboard `ui/src/lib/db/queries/app-service-credentials.ts` and
`ui/src/app/api/ui-bridge/app-credentials/`.

## What a credential allows

- Every app service request needs a valid Bearer credential for the exact installed app ID (header
  `X-YouEye-App`). An app registration without credential data gets no service access. App IDs are exact: no
  implicit `ye-` or `app-` prefix.
- The dashboard also checks the acting user: a stable active user, admitted to the app (its local admission
  projection, [app-admission.md](app-admission.md)), with the needed runtime permission.
- A credential proves which app sent an event. Timeline and notification ingestion bind the event to that app; a
  different `app_id` in the body is refused.
- A credential never grants browser or admin authority: service context always has `isAdmin: false`, the user
  directory and admin routes refuse it, and explicit machine headers never fall back to a browser cookie.
- Native backends must take the acting user from their own validated session. The six native apps and Canvas use
  server-only helpers that read the credential from the protected runtime and replace any supplied authority
  headers.

## Storage (Control Panel)

- One protected record per installed app under `/var/lib/youeye/state/app-service-credentials`
  (`service-credential-store.ts`). It is separate from app data and container checkpoints, so an app rollback
  cannot overwrite it.
- The secret is 256 random bits. It has no expiry by default; rotation and revocation are explicit.
- Secrets live only in this record and in the app's private runtime configuration. They never appear in manifests,
  browser responses, frontend bundles, URLs, logs or status output.
- Records carry an immutable installation ID, a generation number within the installation, and a revision that keeps
  increasing across reinstalls.
- Files are owned by the CP process user, mode `0600`; directories `0700`. Reads and writes share a file lock;
  writes use atomic rename and directory sync before the secret is returned.
- Rendering config reads the record; it never creates a missing one. Missing or corrupt records, wrong
  owner/mode and symlinks need repair and deny authentication. An existing directory without a record is not
  treated as a new install.
- The runtime config that carries the secret must be a private file under `/etc` in the container
  (`service-credential-runtime.ts`); browser-public env mappings and public config paths are refused. The written
  env file is read back after writing.

## Publishing the verifier (dashboard)

The dashboard stores only a SHA-256 verifier, never the secret.

`POST /api/ui-bridge/app-credentials/<appId>` accepts only the CP's bridge token; app credentials and browser
cookies cannot call it. The body has exactly `credential` and `expectedRevision`, or `credentials` and
`expectedRevision` for a batch from the CP's outbox (only the final state of a batch becomes visible).

| Field | Meaning |
|---|---|
| `schema` | `youeye.app-service-credential/1` |
| `appId` | exact app ID |
| `installationId` | installation UUID |
| `generation` | positive generation within the installation |
| `revision` | increasing publication revision |
| `status` | `prepared`, `active` or `revoked` |
| `verifierHash` | SHA-256 verifier |
| `createdAt`, `rotatedAt`, `revokedAt`, `expiresAt` | UTC ISO times (`rotatedAt` null for generation 1; `expiresAt` null for none) |

- Unknown fields, including a raw secret, are refused. A publication must name the current revision and be exactly
  the next one. Repeating an acknowledged publication is a no-op. Skipped revisions, a changed hash within a
  generation, or reactivating a revoked or retired generation are refused.
- Projections are stored in `app_service_credentials` with no foreign key to the app, so removing an app keeps the
  revoked tombstone. The first publication for an app is serialized with an advisory lock.
- Errors: `400` malformed, `401` bad bridge auth, `409` revision or lifecycle conflict, `503` verifier store
  unavailable. Responses never contain the verifier or the secret.
- If the outbox cannot be published, further credential changes are refused until it is.

## Lifecycle

Every credential operation holds the app's lifecycle lock (shared with updates, restore and backup;
[app-update-transactions.md](app-update-transactions.md)) and runs these steps (`service-credential-lifecycle.ts`):

1. mark integration pending and quiesce the app;
2. write the protected runtime config;
3. publish the `prepared` verifier, persist activation, publish `active`;
4. restart the app and make a real probe: from inside the app container, call
   `GET /api/apps/v1/credential-probe` with the credential (up to 20 s for the app to come up; an authentication
   denial fails at once);
5. mark it ready (`POST /api/ui-bridge/app-credentials/<appId>/ready` with the exact installation, generation and
   revision).

- The probe endpoint accepts only the current active credential, even before ready, and returns only the app ID.
  Normal service routes refuse a generation until it is marked ready. Publishing a changed projection clears
  readiness; `ready: false` suspends the app's integration.
- While an operation is pending, the app's admission is suspended; readiness restores it without changing grants
  or owners.
- On failure the integration stays pending. Retries reuse the same operation and generation and roll forward; they
  never bring back a retired secret.
- Operations use the frozen manifest of the installed version. App updates must pass the same probe before they
  commit.
- Lock recovery checks the owner's boot ID, PID and process start time; a live lock is never taken over.

### Admin actions

`GET /api/market/credentials/<appId>` (admin) shows state, generation, revision and outbox progress, never the
secret. `POST` (admin and CSRF) with one of:

| Body | Effect |
|---|---|
| `{"action":"provision"}` | create a missing record |
| `{"action":"reconcile"}` | roll the stored generation forward |
| `{"action":"rotate","expectedRevision":N}` | new secret, retire the old one |
| `{"action":"revoke","expectedRevision":N}` | revoke and stop the app |
| `{"action":"reinstall","expectedRevision":N}` | after revocation and explicit ownership adoption: a new installation identity and secret |

Read the current revision first. A missing or corrupt secret is never guessed. Revocation erases the local secret
and publishes the tombstone; a failed bridge acknowledgement is not reported as revoked.

The Market installer adopts the credential for a reinstall (including after a keep-data uninstall) only after its
resource ownership check passes under the app lock.

(Not to be confused with `GET /api/market/credentials?app=<id>`, which shows an app's bootstrap admin account.)

## Restore

- Backups record only secret-free credential facts. Restore never takes a Bearer credential from an archive.
- The credential store is outside the restored volumes, so newer revocations on the target survive a restore.
- Before reinstalling a restored app, the worker reads the dashboard's projection and posts to
  `/api/ui-bridge/app-credentials/<appId>/restore-fence`. The fence may skip revisions **only to publish a revoked
  projection**; it cannot activate a secret or go back in revisions. Repeating a fence that already holds is a
  no-op.
- Restore then prepares a new credential, writes it into the runtime config after the archived data is in place,
  and probes before reopening service access. A full or core restore keeps the dashboard stopped until all
  restored credential rows have readiness cleared.
- A different machine gets a different installation identity and secret. Restoring there does not revoke the
  source box.
- A partial restore (including core-only) keeps other installed apps. Their archived routing and SSO installation
  identities must match the target, or restore stops and asks for those app archives. Kept apps stay stopped with
  pending intent until reconciliation re-injects and probes their credential.

## Tests

- Filesystem and database tests cover the store, publication rules and restore fence.
- `ui/tests/app-credential-http.spec.ts` runs the built dashboard server against a disposable database: private
  settings, admin routes, mixed machine authority with a valid admin cookie, expired/disabled/revoked
  credentials, verifier store failure, runtime permissions and event source binding. Build with
  `pnpm --dir ui build`, create a database whose name starts with `credential_acceptance_`, then in `ui/`:

  ```sh
  APP_CREDENTIAL_HTTP_TEST=1 APP_CREDENTIAL_TEST_DATABASE_URL=… pnpm exec node --import tsx --test tests/app-credential-http.spec.ts
  ```

  It seeds synthetic data and temporarily renames a table; never point it at an installed box. Drop the database
  afterwards. Skipped by default.

Real native-app flows, competing lifecycle operations and encrypted restore still need a test VM.
