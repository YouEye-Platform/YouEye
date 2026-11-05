# Signed standalone Spine testing

A standalone Spine candidate can test the reader, signed release discovery,
ordinary downloads and explicit native command routing before building an
appliance. It remains a development binding. The installed System receipt and
baked executable retain their existing signed identity; a healthy candidate API
does not prove full installed membership, boot, activation or recovery acceptance.

Infra builds the production-profile payload twice in clean pinned executors,
compares exact bytes, independently validates it and retains its original signed
six-file envelope. The external iteration labels are not payload release labels.
The protected guest directory must contain exactly `spine-linux-amd64`,
`provenance.json`, `sbom.spdx.json`, `release-public.pub`, `SHA256SUMS` and
`SHA256SUMS.sig`, under
`/var/lib/youeye-state/spine-candidates/<artifact-sha256>/`.

```text
<root>/spine-linux-amd64 development spine-candidate activate
  --root <root> --candidate-id <id> --sha256 <artifact-sha256>
  --source-commit <original-source-commit> --identity <SMBIOS-UUID>
<root>/spine-linux-amd64 development spine-candidate status
  --candidate-id <id> --sha256 <artifact-sha256>
  --source-commit <original-source-commit> --identity <SMBIOS-UUID>
<root>/spine-linux-amd64 development spine-candidate verify-core
  --candidate-id <id> --sha256 <artifact-sha256>
  --source-commit <original-source-commit> --identity <SMBIOS-UUID>
<root>/spine-linux-amd64 development spine-candidate deactivate
  --candidate-id <id> --sha256 <artifact-sha256> --identity <SMBIOS-UUID>
```

Every operation requires root and execution from the original named signed
artifact. Trust comes from the current official `main`/Stable `spine` authority,
including enrolled overrides and revocation; the downloaded public key is
informational. Files must be bounded regular root-owned files with one hard link,
protected modes and no symlinks. The signature must cover the exact artifact,
provenance, SBOM and informational key. Provenance pins the original source,
production version/trust, build manifest/toolchain, clean projected build tree,
source epoch, independent comparisons and authenticated paired-metadata marker.

Activation requires the exact actual SMBIOS UUID and a currently verified
baseline bound to the actual appliance partition/state identity. Ordinarily this
is the committed System receipt (`baseline_kind: "committed"`). Existing v1
bindings without a kind retain that committed-only meaning.

Before the first deployment can create that receipt, explicit recovery may use
`baseline_kind: "frozen-media"`. This requires the protected `needs_attention`
progress record, an incomplete first deployment, and a settled deployment
service. The reader authenticates the original installer selection, its metadata
and every current scoped role authority, exact release policy, signed appliance
bundle, immutable image marker, baked Spine and actual hardware/partitions.
The binding retains their exact fingerprint and machine identity. Corrupt or
unknown state, changed bytes/policy, revoked keys, or a malformed committed
receipt fail closed. A missing committed receipt alone never supplies authority.
Candidate binding creates no installed receipt or first-setup completion marker.

Both baseline kinds refuse unfinished native updates, registered production
bootstraps, live controllers/actions, app/backup/container maintenance and
independent copies.
Binding changes hold ordinary native lifecycle locks without creating an update
request or reservation. The admission gate and lifecycle lease share one wait
budget of at most 60 seconds, bounded by an earlier caller deadline or
cancellation. Exclusive admission stays closed while existing ordinary readers
drain; new work cannot continually overtake the binding. Once both locks are
held, native verification and API cutover retain the original operation context.
Timeouts identify the lock and run no binding effects. Unfinished native state
still rejects the operation after draining. They also take the original first-deploy shell's exact
protected `first-deploy/lock` with a nonblocking flock for the entire binding
change and API cutover. An active first-deploy attempt rejects the change; runtime
status/reader verification does not take that lock, so an admitted recovery retry
can continue. Unknown unit states or unsafe/missing lock evidence fail closed.
Binding changes affect only their owned volatile API override,
protected `active.json` and signed development marker. An exact repeated
activation reconciles its existing binding; a different one cannot replace it.

Genuine committed-only bindings retain status schema
`youeye.spine-candidate-status.v1`. Frozen-media bindings use
`youeye.spine-candidate-status.v2`, including after explicit reconciliation to
committed: their original `frozen_media_sha256` remains present. A v2 status
requires a nonempty top-level `baseline_kind` matching the binding, its complete
baseline machine identity and the exact 64-character media fingerprint. A v1
status never represents frozen media or a retained media fingerprint; an old
reader must reject the unknown v2 schema rather than infer committed membership
from ignored additional fields.

Each status includes the exact
`youeye.spine-candidate-binding.v1` hardware/source/baseline binding and freshly
verifies the actual API service MainPID executable hash plus Unix-socket health.
Its `baseline_kind` identifies the authenticated baseline separately from the
signed development reader. A frozen-media binding is never a committed install.
Reading status never repairs a binding. A present malformed, missing-payload or
stale-baseline binding fails closed. It never becomes an ordinary baked fallback.

When normal first deployment calls `update core initialize`, it creates the
genuine committed receipt. That is a baseline transition: the old frozen-media
candidate is rejected until the operator explicitly reconciles it. The first
recovery attempt may therefore settle after initialization, before the remaining
health/setup steps complete. Keep that progress and receipt, allow the exact
first-deploy service and native work to settle, then run the original candidate:

```text
<root>/spine-linux-amd64 development spine-candidate reconcile-baseline
  --candidate-id <id> --sha256 <artifact-sha256>
  --source-commit <original-source-commit> --identity <SMBIOS-UUID>
```

This bounded operation checks the candidate's exact invocation, signed set,
actual API/drop-in, genuine same-release committed receipt, unchanged machine
and retained original media evidence. Under the existing lifecycle locks it
changes only the matching binding's baseline kind. It preserves the original
frozen-media fingerprint and leaves receipts, passed steps, progress and setup
completion untouched. An exact retry is idempotent; status never performs this
transition. Re-read status, then use the supported first-deploy recovery
continuation for the remaining steps. No particular numbered attempt is promised
to complete, and the original media/policy guard remains in force until the
development binding is retired. Reconcile this transition before deactivation
as well; do not replace the real receipt or reset progress to obtain acceptance.

Native CLI, API continuation and action children select the verified test
executable only while that explicit development binding remains valid. A
registered signed production bootstrap takes priority and retains its original
target-Spine contract. Only its exact registered executing path/hash can use
that production-reader authority; equal bytes at another path cannot inherit it.
The canonical baked executable remains baked when it is the current command.
Corrupt production registration never falls back to test state. Retire the
development candidate before a production Stage/update; priority does not promote
that development binding or make it part of the installed System.
Candidate binding does not register or replace the production coordinator.
Deactivation removes only exact owned files, verifies the baked API executable
and socket health, then retires the binding. Interrupted deactivation retains
the binding until that verification passes and can be explicitly reconciled.

`verify-core` authenticates the currently selected complete signed release, then
uses the ordinary CP/UI envelope pipeline with a new owned temporary cache.
Its explicit uncached-verification context bypasses frozen installation objects
through every release-cache wrapper while keeping signed discovery, scoped keys,
authorized mirrors, redirects and hash verification. It creates no native update
intent, checkpoint, application mutation or installed receipt. The temporary
payload cache is removed afterward. The returned receipt names the exact signed
manifest and verified roles; a failed download remains a failed test. A held
unpublished payload that exists only in installation cache cannot satisfy this
ordinary-network test.

The API override lives in `/run`; a reboot removes that override. Retained
candidate files/binding are explicit diagnostic state and do not make the test
binary part of the immutable host. Reconcile the exact binding after interruption
or reboot. Before real installed-update/boot/recovery acceptance, use the final
complete appliance containing the accepted exact bytes and ordinary System gates.
