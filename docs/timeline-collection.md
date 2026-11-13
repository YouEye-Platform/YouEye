# Timeline collection and encryption

The Timeline is the dashboard's encrypted activity history (`ui/`). Apps report events ("note created", "film
watched"); the dashboard stores them encrypted per person. This page covers the per-person on/off choice and the
secret that protects the history.

## Collection is a choice

- Each person chooses whether activity is collected. It is separate from viewing and from deleting history.
- Personal onboarding opens at the Timeline PIN form. **Next** checks the PIN or phrase and goes on to review.
  **Disable Timeline**, next to it, goes on without a PIN and creates no key. Nothing is collected before
  onboarding is confirmed.
- Turning collection off keeps the existing encrypted history and the records apps own.
- The preference (`youeye.timeline-collection/1`) is stored by the dashboard in `system_settings`, keyed by the
  account's internal UUID (`ui/src/lib/db/queries/timeline-collection.ts`). It has a revision.
- No preference means no collection. An existing key is not taken as consent. Unreadable or malformed state is
  "unknown" and refuses writes. People who had keys before keep them and can turn collection on in Settings →
  Privacy.

## Writing a preference

- Changes need the expected revision and a request UUID. The same request repeated is a no-op; a stale or
  different change is a conflict.
- Consent changes, encrypted event writes and key changes for one account take the same PostgreSQL advisory lock
  (`ui/src/lib/db/timeline-lock.ts`).
- Finishing personal onboarding commits in the same transaction as the consent; if it fails, the consent is rolled
  back too.

## Producing events (apps)

1. Take the event time first.
2. Read `GET /api/v1/timeline/collection` with the app's credentials and the acting user.
3. If collection is on, send the event with `collection_revision` set to the returned revision.

The dashboard re-checks the revision and the collection interval under the lock, right before encrypting and
inserting. Missing, off, unreadable, stale and out-of-interval writes are refused. Never cache consent, queue
events for later, retry a refused event after collection is turned back on, or give an old event a new timestamp.
App permissions and admission of the acting user are checked as well. Writers that do not send the interval are
refused.

## Encryption

- A new event is encrypted at once, with the active symmetric key or the saved RSA public key. With neither key the
  event is refused (`409 key_required`). Nothing is stored in plain text, not even briefly.
- The key comes from the person's secret: PBKDF2-SHA256, 600,000 iterations, per-account salt
  (`ui/src/lib/crypto/encryption.ts`).
- The secret is used exactly as typed (`shared/timeline-secret.ts`): UTF-8, no trimming, case folding or
  normalisation. Length is 4 to 1,024 UTF-16 code units (an emoji can count as two). Lone surrogates are refused,
  so two different inputs never become the same bytes. Old numeric PINs keep working.
- Every key row has an RSA key pair, checked after each unlock. Damaged RSA material fails and is not replaced.
- Changing the secret re-encrypts the symmetric entries, re-wraps the private key and ends old viewing sessions in
  one transaction. Any decryption failure aborts the change and leaves the old key and data in place. Creating a
  secret twice with the same input keeps the first RSA identity.
- The server can read an unlocked account's history, and a forgotten secret cannot be recovered.

## Tests

- `ui/tests/timeline-secret.spec.ts`: exact encoding, limits and compatibility.
- `ui/tests/integration/` (opt-in): runs the real queries against a temporary schema in a PostgreSQL database you
  choose. It creates fixture users, tests consent and onboarding rollback, lock contention, stale intervals, retries
  and key rotation rollback, then drops its schema. Never point it at an installed box's database or print the
  connection string.
- Each native app and Canvas test that their event producer sends no payload when collection is off.
