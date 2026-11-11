# Independent appliance copy protocol

An independent copy preserves ordinary local data while acquiring new machine
and service authority. A raw VM clone, domain rename or template seal is not this
operation. A fresh installation initializer cannot replace an existing installed
receipt.

The development implementation connects source inventory/reservation, paired
state/data identity, platform and app authority, native verification and commit.
Infra owns provider cold-copy, quarantine, source restoration and retained recovery.
Installed feature acceptance remains required before advertising operational copy
support; source tests alone do not establish a usable end-to-end capability.

## Core receipt

`CoreCopyRequest` binds an immutable request ID, distinct source/destination SMBIOS
identities, the exact source receipt digest and System core-release.json digest.
`BeginIndependentCopy` requires actual destination hardware observation and freezes
that request before identity preparation. Incomplete native System transactions
and conflicting copy journals deny admission.

`PrepareIndependentCopyIdentity` consumes the admitted request and discovers the
destination's actual hardware and partition contract. It creates fresh appliance
installation/device references and coherently changes the paired data ownership
record. A protected journal retains the old and new pair before either atomic
write. A retry accepts only those two recorded states, repairs an interrupted
pair and preserves its generated identity. It rejects unrelated state changes.
User files, user/group UUIDs, passwords, grants, schema versions and System slots
are not rewritten by this primitive.

`VerifyIndependentCopy` requires a native read-only callback proving the actual
destination hardware, partitions, digest-bound static membership, independent service
identity and operational health. It preserves the installed release and sequence.
Only verified completion writes the destination's committed receipt. Source-bound
update journals and request receipts move to inert provenance. Repeated copies
retain earlier completed copy history, while reusing an existing request ID with
a changed payload is rejected.

## Required operational coordinator

Before source shutdown, the native coordinator must inventory installed apps,
resources and identity-bearing integrations. Unknown/unhandled integrations,
unfinished lifecycle work and foreign writable backing reject preflight without
changing source data. It must acquire native lifecycle/data-consistency exclusion
and advertise an explicit versioned capability only when the complete protocol is
available in the installed source.

Infra reserves the source-restoration and destination resources, observes exact
source power, gracefully stops it and takes a full cold disk copy. The destination
boots under provider-enforced network quarantine with controlled maintenance
access. It receives new hardware/MAC, OS and SSH identity, an independent domain,
and no inherited operator/worker or external control-plane enrollment.

Native coordinators rotate platform signing/session, bridge, app service and
other machine authority. They invalidate copied sessions and reconcile app
installation/admission projections while preserving local users and data. Names
and external integrations must have explicit independent dispositions; source
registrations and certificates cannot be reused or revoked on the source's behalf.
Unknown state retains quarantine and the destination for reconciliation.

Networking becomes ordinary only after service credential/configuration probes,
installed native verification and the complete copy receipt succeed. Source power
restoration rechecks its exact identity, current Session state, holds and reserved
capacity. Cleanup is a separate exact-identity action.

## Focused acceptance

Tests cover digest-bound membership, refusal of source identity, immutable retries,
interrupted paired state/data writes and inert source journals. Operational
acceptance additionally copies a disposable lab containing sample data, observes
independent identity/SSH and simultaneous basic authenticated health on source
and destination, and proves that changing the copy leaves the source data intact.
Unit evidence alone does not establish a usable native copy command.

## Native inventory and local identities

The hidden `appliance independent-copy inventory`, `reserve-source`,
`quiesce-source`, `restore-source` and `release-source` commands expose the
source-side native protocol. The mutating
commands consume a root-owned protected request file. A source reservation is
retained after uncertain observation; release requires the original hardware,
receipt and fresh installed verification. There is no timeout-based release.
The operational capability marker remains absent pending installed acceptance
of the connected native and Infra coordinators.

Source quiescence retains the exact container UUIDs, running states and boot
intent, disables automatic startup and gracefully stops the writers. Repeating
an interrupted step observes those identities and states before proceeding.
Source recovery restores only its original running/boot intent. Automatic host
convergence cannot enter a retained copy reservation.

The hidden `prepare-host` phase requires the inherited quiesced inventory and
exact digest-bound Spine/host membership. It imports and mounts only existing copied
datasets; missing datasets or different mountpoints require recovery. It adopts
the destination reservation, stops inherited writers and prepares paired
installation/data ownership plus machine and SSH identity. Its result explicitly
requires continued quarantine and a reboot. It does not report service authority,
native copy completion or ordinary network readiness.

Host preparation also journals fresh CP/Identity/UI session secrets, native CLI
and bridge tokens, the deployment secret, and Pointer's local JWT/encryption
secrets while the copied containers remain stopped. Each write accepts only the
frozen source bytes or this request's generated bytes. Interrupted acknowledgements
reuse those generated values. The supported source inventory checks these files
before stopping the source. Identity database, domain and app reconciliation still
remain separate required phases.

For standalone Incus, copy preparation replaces the local server certificate
using [the native certificate update command](https://linuxcontainers.org/incus/docs/main/reference/manpages/incus/admin/update-certificate/),
enrols a new CP client certificate and removes the inherited client trust. It
verifies the resulting server and trust inventory before writing the CP's new
client files. Clusters, external Incus identity providers and extra client trusts
currently require an explicit adapter and reject source preflight.

The initial inventory supports the six native application authority layouts
(Cinema, Notes, Search, Translate, Weather and Wiki), with exact local clients,
frozen manifests, settled credential publication and local persistent backing.
Additional secrets, foreign clients/storage, pending lifecycle work, retained
runtime roots and configured external integrations require explicit adapters.
Configured Pointer provider authority and engine state, SMTP, external DNS and
app AI integrations are currently rejected before source shutdown. This neither
discards their data nor calls those configurations supported.

Native identity preparation invalidates login sessions, refresh families, auth
codes and setup handoffs, rotates signing and confidential client credentials,
and preserves local user/password/group records and the appliance owner.
A separate native transaction rebinds app installation IDs and their resource
references, retaining user grants, data owners and audit history. The durable
old-to-new mapping authorizes only that exact rebind; ordinary policy writers
retain their immutable identity and monotonic revision checks. New policies
remain pending until protected app runtime configuration, new service
installation credentials and current-generation probes converge.

The private native platform endpoint now has separate identity, domain, app
and verification phases. Its protected journal pins the source inventory and
the exact imported destination Names bundle. Domain preparation removes only
the copied Names/TLS authority, uses the existing URL-change coordinator with
the installed frozen manifests, and requires actual process restart settlement
before rebinding apps. It does not release or revoke the source's lease. Names
broker calls and background maintenance obey the native copy reservation.
Every phase still reports that quarantine is required; these local phase receipts
do not replace the complete native/provider coordinator or live copy acceptance.

Host preparation also replaces the persistent ZFS host ID and Caddy's generated
CA/certificate caches. It preserves Caddy routes and ordinary site data. Custom
certificate loaders, signing keys and remote storage require an explicit adapter.
The next phase observes a different kernel boot ID as well as the prepared
machine, host and SSH identities; writing identity files alone is insufficient.

The hidden `start-core` command checks the exact destination reservation and
prepared authority, maps the native Pi-hole listener to the observed maintenance
address, starts the core services and repairs their existing host/bridge access
bindings. Pi-hole uses a fresh native password and explicitly clears copied API
sessions, including a graceful persistence cycle. Source inventory rejects
separately configured Pi-hole app/2FA authority and password environment overrides.
DNS settings and query data are retained. Native phases serialize through a
separate executor lock while the durable lifecycle reservation remains in force.

`prepare-identity`, `prepare-domain`, `prepare-apps` and `prepare-verify` connect
the native CLI to the private platform phases using a protected destination Names
bundle and the retained source inventory. These commands still require provider
quarantine; `prepare-verify` is an intermediate platform receipt, not final native
acceptance or permission to release networking.

The hidden `commit` command verifies current paired identity, a later kernel
boot, loaded service credentials, digest-bound installed members, operational health,
local DNS and the certificate actually served for the independent Names domain.
The platform verifier observes the live signing key, OAuth configuration and app
credential generation. It then commits the copy receipt and releases the native
destination reservation. A repeated acknowledgement uses the retained completion
and fresh installed observation rather than restarting identity preparation.
Its result still requires provider network release. The Infra provider and
recovery coordinator is wired in source; live acceptance remains required before
operational capability is advertised.

Platform PostgreSQL and supported app database roles receive fresh passwords
through their existing local administrator. Native TCP authentication verifies
the new credential before proceeding. Database owners, grants, schema, user
passwords and data remain intact. App roles with elevated or shared authority
require an adapter. Completed source app-update records move to a protected
provenance directory outside the destination's live recovery namespace; uncertain
renames reconcile without deleting the retained records.

The supported host network layout is native IPv4 DHCP. Source preflight rejects
static addressing, extra network units and custom client identifiers. Host
preparation removes the source MAC selector from the retained DHCP profiles and
network unit before the required reboot. The provider verifies a distinct address
before Names preparation; it does not assume a new MAC alone refreshed DHCP.

Copy-of-copy host preparation discards inherited private platform replay journals
and Infra staging inputs while inherited services are stopped. Those files can
contain credentials still valid on the source. Public native copy receipts retain
provenance; destination replay journals created by the current operation survive
retry. Infra restages only the current request and independently assigned Names
bundle, and removes the bundle staging file after native commitment.
