# Independent product release identity

An independently versioned product can declare `.youeye/release/artifact-promotion.json`
with schema `youeye.artifact-promotion.v1` and its stable product ID. Supported
products are Pointer, Market, Canvas, Cinema, Notes, Search, Translate, Weather
and Wiki. Infra's `pointer-server` build component maps to product `pointer`.
Historical sources without the declaration retain their legacy release contract.

`product-build.json` records immutable build version, original repository,
branch, source commit and tag, input and installer-contract digests, primary
artifact and the complete original asset set. Infra signs these exact bytes once
using the original build's scoped authority. The existing native archive,
checksum signature, provenance and SBOM remain unchanged and independently
verifiable. Source/catalog products bind their original source archive instead.
Pointer binds its managed-package build contract; it is not a Market app.

`product-release.json` records product version, channel, source, branch, tag,
sequence and release signer. It embeds the original build document and signature
as canonical base64. Its detached signature authenticates the release label;
it does not replace the original build signature. Public wrappers require a
publication-safe original build from the same public repository. The strict
bounded readers reject duplicate/unknown fields, incomplete signatures,
unsupported authority, changed bytes and mismatched selected product/source/tag.
Package-manager versions remain immutable build identity.

Native installation compares the signed installer contract after the catalog's
existing public-repository and image-URL resolution. Those bounded presentation
changes do not alter the signed YAML or authorize different container, database,
permission or hook instructions. A later identical-build release keeps that
accepted catalog presentation and changes only its authenticated release label.

System selections also separate the release publisher from the original image
signer. Alpha uses the provisioned development publisher even when the unchanged
image was built under Stable authority. The Core reader carries that publisher's
public key independently of the legacy image/recovery key file. Original members
still resolve their own source, branch and role authority; owner overrides and
revocations take precedence over every built-in key.

Private wrappers can deliver an original public-ready blob through a
`blob-<sha256>` asset on that exact private release. Transport does not change the
original source URL, expected hash, size or signing authority. Foreign redirects
remain forbidden. Discovery must distinguish legacy releases from an advertised
product release: partial or invalid new metadata never falls back to legacy.
Public wrappers can carry the same hash-addressed bytes before the original
build tag is published. Readers use that exact selected wrapper only after the
original returns HTTP 404; authorization failures, corrupt bytes and other
transport failures do not trigger substitution. Hashes and original signatures
remain mandatory. GitHub's bounded HTTPS asset redirect is permitted without
forwarding credentials.

The platform retains the exact release bytes/signature in protected install
metadata. After authentication it writes the small runtime projection
`/etc/youeye/installed-release.json`, outside the application code tree, using
an atomic rename and filesystem sync. The projection names both accepted release
and original build digests, plus the Incus runtime UUID. Runtime readers check file type, root ownership,
permissions and matching product/build version, and reread on each request.
Missing or invalid evidence displays an unknown release; the build identity
remains available. The persistent location survives a container reboot.

A release-label change for an identical signed build uses the existing durable
app update journal with `operationKind: release-metadata`. Eligibility checks
both signatures, the complete original build document, unchanged frozen install
contract, recorded archive digest, current runtime UUID and protected projection.
This is retained install evidence, not a fresh hash scan of every app file.
The running runtime must pass health; a stopped or replaced runtime is rejected
before label changes. No archive is downloaded, migration/hook run, or service
restarted. A changed build/contract/dependency uses ordinary update and recovery.

The recovery set contains only registrations and release projections. An
interrupted publication restores their previous values while retaining current
owner configuration, credentials and source/branch sequence floors. Current
trust is rechecked during projection publication and recovery. Per-track floors
reject lower sequences and conflicting equal-sequence manifests, including
forced updates. First installation records the accepted floor too.


## Pointer and catalog consumers

Managed Pointer stores its original signed receipt, runtime UUID and sequence
floors in protected `state/pointer-release/installed.json`. Its update path shares
native archive staging and original-envelope verification with Market apps.
An identical-build label change uses `pointer-release-metadata` in the existing
app journal. Recovery restores the previous projection and registration while
retaining sequence floors; it does not touch the engine, database, migrations,
credentials or service process. Settings reads the accepted receipt and checks
its runtime UUID instead of treating the package build version as the label.
Legacy Pointer installations gain this receipt on their next signed payload update.

First setup uses the same signed Product resolution and archive staging. A
`product-release.json` discovery result identifies a release; it is never the
runtime archive. Verify its selected source, branch, tag, version, sequence and
optional artifact pin, then authenticate and stage the original `standalone.tar`
before creating or replacing a partial Pointer container. Invalid or incomplete
Product evidence cannot fall back to the legacy archive path. Existing signed
legacy releases remain supported when no Product metadata is advertised and no
accepted Product receipt exists. Commit the installed receipt and runtime UUID
only after managed configuration, readiness and projection verification pass.
Failed setup retains its persistent data and does not claim installed acceptance.

Initial native container creation includes the deterministic system NIC in the
create request and disables automatic start until runtime installation succeeds.
This prevents the watchdog from starting a partially configured instance with a
dynamic lease while managed proxies use its static address. Static network
configuration must acknowledge success, including terminal asynchronous results,
before DNS publication and the explicit installer start. Failed configuration or
installation retains the automatic-start suppression for explicit retry/recovery.
Ordinary application NICs and persistent-volume bindings remain unchanged.

Market discovers signed catalog releases on the selected repository and branch.
The original build's `catalog-snapshot.json` authenticates the catalog and its
included manifests. Refresh freezes the original source commit and commits the
release receipt, verified catalog bytes and sequence floor together under an OS
lock. Identical-source promotions reuse retained catalog content. Offline refresh
can retain the last authenticated catalog; invalid new evidence is reported as a
refresh error, and accepted receipts are rechecked against current trust.
The Sources page shows the accepted release and its original build version.
Explicit administrator commit pins and catalogs without product metadata keep
their existing source contract.

A promoted catalog keeps relative external repository references in its
authenticated original build's source context. An Alpha mirror does not move
those dependency repositories to its own host. Catalog-local files continue to
use the selected mirror and the signed snapshot hashes. Native release lookup,
dependency manifests, images and subsequent update routing use the original
dependency context; independently selected app channels remain independent.

Canvas remains a source template. Its promoted release identifies an unchanged
source archive and commit; it has no installed runtime projection. A downstream
fork owns its own application version and deployment lifecycle.
