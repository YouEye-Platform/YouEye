# Managed Pointer runtime

YouEye mounts Pointer's shared React interface in Settings → AI. Pointer supplies
versioned JavaScript, styles, fonts and asset notices; the host supplies React 19,
navigation, theme and the authenticated stable identity UUID. It loads the UI
from the installed Pointer release rather than copying screens into Control Panel.

Management uses the private management listener with a platform acting-user
token. Public inference uses the separate inference listener and a Pointer key.
Managed app templates expose separate `ai.defaultModel` and `ai.utilityModel`
aliases. Chat uses the group's first entry; utility tasks use its third entry.
The OpenWebUI task model uses the utility alias rather than the chat default.
The Settings test proxy keeps that key in memory and accepts only the fixed
models/chat operations. Management writes and tests require CSRF protection.
Request bodies are bounded while reading, including chunked requests. Public
build assets contain no account state and use a strict path allowlist.

## Persistence and recovery

The private `/var/lib/youeye/pointer/runtime` host volume is mounted at
`/var/lib/pointer`. OpenCodex engine homes and account state persist independently
of the release directory. A pre-existing nonempty unmounted engine home must be
relocated under a protected migration; reconciliation refuses to hide it beneath
a new mount. Unknown or foreign storage identities also fail closed.

Core backup holds Pointer lifecycle exclusion, gracefully stops its writers,
captures its PostgreSQL database and engine files as one encrypted backup, then
restores the original running/stopped intent. A failed restart retains maintenance
for explicit reconciliation. A backup cannot skip an unknown runtime; absence is
permitted only after proving there is no Pointer database or engine state.

Changing the managed identity issuer uses the database-owner transition command.
It preserves actor UUIDs, account/group ownership and engine homes, rejects an
existing destination actor domain, and never substitutes username/email mapping.
Server reconfiguration holds Pointer lifecycle admission and checks this
transition before writing site configuration, routes or a recovery journal.
If the initial site/Pointer transaction fails, it restores the old routes and
issuer before restarting Pointer. Incomplete recovery remains explicit; the
retained journal requires a retry with the same target. Session revocations
are never reversed by route recovery.
The Pointer container resolves the configured public identity hostname to local
Caddy through a single managed hosts record. Reconciliation replaces that record
when the domain or restored subnet changes, preserves unrelated entries and
rejects conflicting unmanaged records. JWKS fetching retains the public HTTPS
authority, trusted certificate and strict issuer/signature checks.
Existing-service reconciliation applies current managed configuration after a
Control Panel update. Registered LXD updates share lifecycle exclusion with
backup and restore; static update requests require administrator access and CSRF
validation. Pointer refreshes its managed environment from the installed release
before restart so its reported build identity follows the signed payload.

Identity activity changes and deletion acquire all affected app lifecycle gates
before changing Pointer's actor state. Disable closes Pointer first; activation
opens Pointer only after the identity commit. A failed identity write can leave
Pointer disabled safely. An explicit activation reconciles that state even when
the identity already reports active, and failures remain visible to the caller.

## Build and acceptance

The migrated package pins OpenCodex 2.79.0 and bundled Bun 1.4.2. Its source-owned
build uses the Pointer v2 build kit, a frozen reviewed package cache and denied
network for both installation and engine deployment. The managed artifact includes
the shared UI and tracked engine, font and icon notices. Dependency links are
confined to the packaged engine tree; runtime entrypoints cannot be links.

Source tests, build admission and a packaged artifact are distinct from installed
acceptance. Validate administrator and ordinary-user management, inference,
streaming/tools, account isolation, update/rollback, independent UI replacement,
paired backup/restore and guarded identity changes on the exact test appliance.
Record provider-specific limitations separately: successful text generation does
not establish media, embedding, semantic-search or token-count support.

Infrastructure deployment resolves each component’s effective repository together
with its selected branch, exact tag and artifact digest. An explicit UI or
`app:pointer` publisher override must not be combined with the global core
repository. Pointer’s default repository is its own app source. Signed artifact
verification keeps the embedded publisher identity and configured digest; public
GitHub defaults and signing-channel checks remain effective.

Re-enabling an existing managed AI connection reapplies the current manifest AI environment with its existing protected credential before activation. This converges utility-model mappings without replacing the app instance or key; a missing protected credential requires recovery. Retained-data adoption still requires the exact original manifest digest.
