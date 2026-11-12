# Timeline collection and exact encryption secrets

Timeline collection is a per-account choice, separate from viewing encrypted
history and from deleting it. Personal onboarding presents an explicit On/Off
choice. Off does not create a key. Turning collection off retains encrypted
history and records owned by apps.

The UI owns the authoritative, versioned preference in `system_settings`, keyed
by the internal account UUID. A missing preference permits no collection and
requires an explicit choice; it does not infer consent from an existing key.
Unreadable or malformed state is unknown and rejects writes. Existing accounts
keep their keys/history and can explicitly enable collection in Privacy.

Consent transitions, encrypted event commits and key changes share a PostgreSQL
transaction advisory lock per account. Preference mutations require an expected
revision and request UUID. Repeating the same request and effect is idempotent;
a stale or changed effect conflicts. Personal completion commits in the same
transaction as consent. Completion failure rolls back the preference too.

Producers must capture the event time before reading fresh, authenticated
`GET /api/v1/timeline/collection` state. If enabled, submit the returned revision
as `collection_revision` with the event. Never cache consent, queue a payload,
retry a rejected event after re-enable, or generate a new timestamp to replay
old activity. The receiver rechecks the revision and interval under the database
lock immediately before encryption and insertion. Missing, off, unreadable,
stale and pre-interval writes fail closed. App permissions and acting-user
admission remain required independently of consent.

New ingestion encrypts immediately with the active symmetric key or the saved
RSA public key. It never falls back to plaintext pending storage. Consent
transitions and unlock discard legacy pending rows: their original collection
interval is not established, so they cannot be safely replayed. No pending
payload is copied into logs. App-owned records are unaffected.

Encryption secrets use the existing PBKDF2-SHA256, 600,000 iterations, UTF-8 input
and per-account salt. Inputs are exact: no trimming, digit restriction, case
folding, normalization or truncation. The compatible minimum is four UTF-16 code
units and the request bound is 1,024 units. An emoji can count as two units;
combining sequences and composed characters remain distinct. Reject lone UTF-16
surrogates to avoid silently replacing them during UTF-8 encoding. Existing
numeric PINs retain their derived key identity.

Secret creation serializes same-input retries and preserves the original RSA
identity. Legacy symmetric-only keys acquire an RSA pair after successful
verification; partial/corrupt RSA material fails without replacing it. Secret
changes reencrypt symmetric entries, wrap the private key and invalidate old
viewing sessions in one transaction. Any failed decryption aborts the transition,
leaving the previous key and data active. Encryption is not a claim that the
server cannot access an unlocked account, or a promise of secret recovery.

## Verification

`ui/tests/timeline-secret.spec.ts` covers exact encoding, compatibility and
boundaries. Each native app and Canvas tests its producer's no-payload behavior.
The opt-in PostgreSQL integration program in `ui/tests/integration` bundles the
production queries against a unique temporary schema and in-memory cookie
fixture. It copies table structures only, creates fixture users, tests consent
and completion rollback, real lock contention, stale intervals, exact-secret
retries and key rotation rollback, then drops its own schema. Supply an explicitly
selected PostgreSQL connection with the UI schema; never print connection data.
These checks do not establish installed update/rollback/recovery acceptance.

Older writers lacking the interval contract are rejected. A rollback must not
restore writers that ignore the authoritative preference; component quick
restore alone does not establish that compatibility. Full signed System and
paired-recovery validation remain separate acceptance requirements.

Personal onboarding opens directly at the Timeline PIN form. **Next** validates
the exact PIN/phrase and proceeds to review. **Disable Timeline**, beside Next,
proceeds without requiring a PIN and without creating a fresh encryption key.
Neither choice collects activity before completion is confirmed. Help and errors
use plain language; the original exact-secret validation and cryptography remain
unchanged. Back preserves the draft, and completion still reconciles lost replies.
