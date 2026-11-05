# Managed Pointer runtime

YouEye mounts Pointer's shared React interface in Settings → AI. Pointer supplies
versioned JavaScript, styles, fonts and asset notices; the host supplies React 19,
navigation, theme and the authenticated stable identity UUID. It loads the UI
from the installed Pointer release rather than copying screens into Control Panel.

Settings uses a fluid workspace capped at 120rem, with a 13rem desktop navigation
column and a mobile section picker. AI routes are nested in that navigation;
Pointer mounts with `navigation: "host"` so it supplies page content and
attribution while Settings owns navigation, account and theme controls. Direct
links and retained `/playground` and `/connections` aliases remain supported.
The host maps semantic colors, border, radius and focus tokens across the shadow
boundary using `--pointer-host-*` properties. Settings uses bundled IBM Plex
Sans/Mono fonts; their OFL notices are retained beside the assets.
Resolve the host properties on the enclosing section, before inheritance into
the Pointer shadow host. Defining references such as
`--pointer-host-primary: var(--primary)` on the shadow host itself creates a
cycle when Pointer defines its own `--primary`. Verify real computed colors,
card borders and action contrast in the installed host, not only literal-token
fixtures.

The embedded navigation option requires a compatible Pointer UI. Hosts that omit
it retain Pointer's independent navigation. Deploy both interface changes before
evaluating the integrated layout; compatible API transport alone does not prove
that the two UI revisions match.

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

### Settings navigation

Settings uses its available width for detailed pages and embeds the shared
Pointer workspace with host-owned navigation and semantic light/dark colors.
AI navigation groups keys under **Instances/API**; old key detail links still
resolve and select that section. Providers displays existing connections, with
**Add Provider** opening the logo/search chooser and supported setup flow.
Model discovery reconciles owner-scoped engine inventory when Models opens;
a saved provider definition alone does not imply a connected account.

Management traversal validation applies to the route pathname. Encoded query
values may carry canonical model IDs containing `/`; they do not select an
upstream route. Model detail uses the summary endpoint's `model` filter rather
than placing such IDs into a route segment. Forbidden management prefixes,
encoded route separators, dot segments, fragments and raw backslashes remain
rejected.

### Consolidated AI pages

AI navigation now has one **Overview** for both overview and usage, and one
**Test model** page for direct testing and recorded comparison. Request diagnostics
and Proxy test have been removed as destinations. Old Usage/Request diagnostics
links resolve to Overview; old Compare/Proxy test links resolve to Test model.
The adapter's module-loading placeholder follows the requested page layout,
while Pointer supplies the matching data-loading rows, cards and forms. Model
loading follows the selected table/grid view without introducing placeholder tabs.
These UI changes preserve the existing authenticated request and telemetry APIs.
