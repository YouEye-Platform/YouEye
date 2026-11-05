# Household app access and data ownership

This development contract separates application admission from launcher
preferences, runtime permission consent and the application's own roles.

An active administrator manages admission in the existing Market app settings.
Ordinary installs start with owner-only access. The verified installer becomes
the application owner; unattended installs resolve the explicit appliance
owner. An administrator may choose all active household users, selected users
or selected groups. The active application owner is included in every mode.
An empty selection admits only that owner. Administrative status alone does
not admit a user to an application.

Missing, malformed, unsupported, pending or quarantined policies deny access.
Inactive and deleted identities are denied in every mode. A new identity with
the same username or email does not inherit its predecessor's grants or data.
Groups use stable registry UUIDs bound to exact existing group keys. Labels
are display text; changing a label does not rename an identifier.

## Authority and enforcement

Control Panel owns the policies and current identity membership. Its exported
`evaluateAppAdmission(appId, identityUserId)` function returns:

```ts
{
  allowed: boolean;
  reason: AdmissionReason;
  installationId: string | null;
  revision: number | null;
}
```

`shared/admission.ts` defines the version 1 policy, principal, projection and
resource shapes and the pure `evaluateAdmission(policy, principal)` evaluator.
The authoritative policy binds a canonical app ID, immutable installation UUID,
owner identity UUID, mode, selected user/group UUIDs, revision, lifecycle state,
explicit public exposure, and creation/update timestamps.

Explicit client mappings enforce admission at authorization GET/POST, code
redemption, refresh, bearer validation and participating native session checks.
Only the core UI and Control Panel clients have separate platform access.
Unknown clients are denied.

Caddy supplies installed host, path and method context, removes supplied app
and identity headers, and applies the same decision to direct application URLs
and registered alternate routes. App manifests cannot disable this boundary.
The administrator's explicit public exposure setting bypasses browser admission
for the application's URLs; protected UI services remain user authenticated.
New Caddy bridge interfaces use a deterministic hash of the complete app ID,
within Linux's 15-byte name limit. Apps sharing an ID prefix therefore keep
distinct interfaces. Existing valid legacy attachments retain their names;
foreign bridges, unknown names and interface collisions fail before attachment.
WebSocket handshakes receive the same admission check as ordinary HTTP. The
authorization subrequest removes connection-upgrade headers so the identity
server handles it as an HTTP request. After admission, the application backend
receives the original upgrade request; denied users never reach that backend.
A declared participating native signed back-channel logout endpoint has an
exact POST-only machine exception. An arbitrary manifest callback is not a
public exception. Bundled apps that only perform session checks have no claimed
back-channel logout participation.

Participating logout deliveries deduplicate an event, rather than every future
revocation of the same identity session. Admission events carry the durable
revocation time; delayed delivery cannot move that cutoff forward to receipt
time. Notes persists the signed cutoff and rejects cookies issued at or before
it. A fresh authorization after a regrant can reuse the active identity session,
and a later revocation invalidates that new app cookie separately. Historical
Notes events without a signed timestamp conservatively deny their original
identity session.

UI uses `evaluateLocalAdmission(appId, identityUserId)` on its local projection.
It never makes a reverse admission query to Control Panel. Service requests
require a registered app, the existing app credential contract, an active acting
user, current admission and the applicable per-user runtime permission.
Services do not inherit browser administration authority. Ordinary browser APIs
accept the platform origin; app-origin header/profile and app-settings handlers
explicitly opt in and enforce their respective permission or namespace checks.
Native backends must derive the acting user from a validated session.

Installation keeps admission pending until protected service provisioning and
the native runtime probe finish. Final binding reopens only an active, enabled
installation with an active, unexpired credential and no pending verifier
publication. Quarantined ownership cannot be reopened by that transition.
Native reconciliation can recover a missing per-user ownership declaration
from the frozen installed manifest at its exact installed version. It does not
adopt a mutable catalog's declaration. Update reconciliation occurs after the
durable transaction and cleanup, under the same application lifecycle lock;
existing resource owners and current grants remain authoritative.

The integrated credential contract removes missing-token grace. A valid current
app credential, stable active acting-user UUID, local admission and the required
runtime permission must all agree. Admission does not implement row privacy
inside arbitrary external applications.

## Revocation and synchronization

Policy changes require an active administrator, CSRF protection and the current
revision. No-op changes preserve that revision. Membership/activity changes
advance affected revisions and durably invalidate denied users' client grants,
authorization codes and participating logout deliveries.
Identity updates and deletion use one store-owned transaction. Admission is
retained through disposition checks, Pointer suspension, the identity write and
postcommit Pointer activation. Direct store callers use the same guarded path;
membership-only changes preserve the current administrative role.
Market install, install-from-URL and uninstall also require administrator and
CSRF validation before parsing a lifecycle request or changing resources. This
applies to ordinary installs as well as retained-data adoption. Native CLI/PAM
requests use the existing authenticated native CSRF verification contract.

Control Panel pushes projections through the authenticated UI bridge. Each
projection binds the current UI process challenge, installation, revision,
sequence, principal mapping and at most 60 seconds of validity. UI applies
monotonic sequence/revision checks and a monotonic expiry deadline. Delayed,
duplicated or pre-restart renewals cannot extend an old lease. Restart begins
with no active leases.

A mutation returns pending until UI acknowledges the desired revision. The
authoritative gateway denies pending admission while an older internal UI lease
can last for its remaining bounded lifetime. Expired and unknown UI policies
deny locally. Unrelated applications keep independent leases. The CP renewal
loop pushes every 20 seconds; UI does not poll CP for permission.

An external application's independently cached session may outlive admission
revocation. Participating native session checks and signed back-channel logout
provide stronger behavior, but the platform does not promise universal immediate
logout of independent applications.

## Persistent resources and lifecycle

Resource declarations distinguish `system`, `app_global`, `per_user` and
`shared`. They bind a logical resource ID and installation UUID, data owner,
enforcement owner (`platform`, `app_native` or `needs_review`), lifecycle state
and, where applicable, immutable user/UI UUIDs or a stable share UUID with
explicit installation consumers. Per-user declarations bind their actual
identity owner; platform-managed resources also require the exact UI UUID
mapping. A path, label or Linux UID is insufficient ownership evidence.

An app may declare `data_ownership: { per_user: identity_uuid }` in its manifest
when its private namespaces use the validated OIDC subject. The six bundled
apps declare this contract. CP reserves `user-data:<identity UUID>` for each
known principal, including later-created identities, under the immutable
installation. These are conservative logical namespace records, not a claim
that every user has written data or that the platform isolates rows in the
app's database. The application enforces row privacy. Omitting this declaration
in a later manifest cannot remove an already-recorded ownership contract.
Unknown apps continue to use app-global/needs-review declarations.

An app-global database may contain private rows enforced by the application.
Existing resources without a verified privacy declaration remain
app-global/needs-review. App administration transfer preserves resource data
owners and never transfers another user's private rows or files.

Incus volume names and pool placement remain unchanged. Custom volumes acquire
verified installation/data-owner tags; cleanup checks the exact name, type,
logical declaration and ownership before deleting data. Foreign or unresolved
volumes are refused. Shared data is retained while an attached consumer remains.
Runtime instances also bind and verify their installation and original data
owner. Cleanup without install metadata is refused. Keep-data uninstall closes
admission, stops each runtime and creates a verified offline root copy before
removing active containers. Copies have no network, proxy devices or profiles,
and cannot auto-start. Custom volumes, database data, grants, installation
identity and original data owners remain intact. A durable private record tracks
preparation, retention and consumed-copy cleanup across interruptions.

Deleting a user requires separate app administration transfer and explicit
private-data disposition. The current safe disposition retains/quarantines the
original data owner. Quarantining app-global/shared data also quarantines the
application. Appliance-owner and recovery access cannot be deleted or disabled.
Quarantining a per-user namespace denies that principal's admission to this app
in both CP and its UI projection, without disabling unrelated applications.
Reusing a deleted user's name creates a separate UUID and namespace.

Keep-data uninstall retains the installation identity, grants and declarations.
Reopening requires the active application owner's explicit authenticated adoption
(`adoptRetainedData: true` on the install API), current administrator authority
and CSRF protection. The original manifest/version is required; recorded
publisher metadata is resolved by the server. App Settings offers the explicit
adoption choice. A transferred administrator cannot reopen quarantined private
data. A declared UUID namespace belonging to a known deleted principal may stay
quarantined inside an adopted runtime; its ownership, tombstone and denial are
preserved. This exception cannot reopen an active person's quarantined data,
an unknown namespace or quarantined app-global/shared resources.
After explicit delete-data, a fresh reinstall permits deleted declared logical
namespaces of other known household principals. Tombstoned namespaces remain
quarantined. Installation reconciles users created while the app was uninstalled,
including when a later manifest omits an already-recorded declaration. Foreign
runtime/volume ownership still requires disposition.
Reinstall copies the retained roots, so a failed install cannot delete the
recovery originals. Native initialization commands are not replayed on adoption.
After a complete data-deleting uninstall, that owner may reinstall only when
the deleted physical declarations have no foreign owner. Other cases require
explicit disposition. Ordinary updates and app rollback preserve newer grants
and identity deletion markers.

Encrypted core backup includes retained-root instance archives, private metadata,
custom volumes and declared shared database dumps. Restore checks logical
bindings against the restored authority before importing; missing principals or
foreign resources do not become public. Root pools may be mapped to available
target storage without changing installation/data-owner identities. Retained
roots remain offline until authenticated adoption. A target with existing
retained data requires explicit disposition before historical full restore.
Real full encrypted restore and the authenticated browser lifecycle are separate
acceptance requirements; source tests and Incus root preservation do not prove them.

## Backup and restore

Encrypted core backup contains the authoritative identity database, policies,
stable principal/group/share mappings, declarations, revisions, audit and
tombstones. App archives also contain versioned `admission.json` metadata.
Unsupported or inconsistent ownership metadata fails closed.

Ordinary app restore validates the current installation and complete ownership
bindings, including UI mappings and shared consumers. It does not restore old
grants or remap unknown principals through display labels. Unknown or foreign
ownership requires explicit quarantined disposition.

App replacement removes shared PostgreSQL resources only for a shared-database
installation. Own-database and database-free apps do not request a shared drop.
A validated replacement can resume cleanup when Incus positively reports that
an exact declared runtime is already absent. Unavailable or mismatched responses
and existing runtimes with foreign tags still fail closed; policy, resource,
quarantine and volume checks remain required. Ordinary and keep-data cleanup
retain their existing runtime/retained-root verification.

Full restore may restore the coherent historical account and policy state from
the explicitly selected backup. It restores the identity database before UI
and ordinary ingress restart, clears projection acknowledgements, and requires
a fresh authenticated push. A failed database restore keeps those consumers
closed. Restoring on another network or pool does not change logical owners.
The surviving CP process reapplies its current additive schema migrations after
the historical database replacement and before reopening those consumers.

The implementation's behavioral/database checks cover their stated cases.
Authenticated multi-user browser workflows, lifecycle/update rollback and
encrypted fresh-target restore remain required development acceptance; source
checks and service health alone do not prove them.

Native channel updates record the exact applied tag manifest digest and reference. Owner adoption can recover a legacy stale catalog binding only from the latest protected, completed committed update: its manifest and every verified native artifact must match the original installed version, container inventory and installation timeline. Missing, unfinished, rolled-back or mismatched evidence leaves retained data closed. Ownership, retained roots, storage and database validation remain mandatory.

Imported and retained native runtimes must have exactly one pool-backed root disk before reconciliation. Adoption keeps that root explicitly, including when the retained runtime has no inherited profile, and replaces other devices with the target manifest data mounts and app network. Missing or ambiguous roots fail before provider mutation.


## Managed app identity DNS

An isolated app bridge resolves the stable `id.youeye` authority to its own
Identity doorway. Both newly allocated and existing proved bridges carry
`address=/id.youeye/<gateway>` and `local=/id.youeye/` in their managed DNS policy.
The local domain returns an empty successful answer for unsupported record types
instead of forwarding them upstream. This preserves IPv4 resolution for runtimes
that combine A and AAAA lookups, including Alpine/musl. Other domains retain the
configured forwarding policy. Reconciliation verifies the exact owned bridge and
reads back the complete policy; duplicate managed mappings fail closed.

Post-start configuration permission checks wait for the container exec transport
to become ready. A running state alone is insufficient. Permission changes and
exact mode readback still fail closed after that bounded readiness wait.
