# Public release policy

YouEye's private development history and its public release surface are separate trust boundaries.

## Public source contents

A public source tree may contain product source, public documentation, neutral tests, release manifests, license material, and reproducible build definitions. It must not contain:

- agent or worker journals;
- private infrastructure names, endpoints, addresses, or machine identities;
- session, allocation, checkpoint, internal job, or internal artifact records;
- credentials, private keys, tokens, password material, or private support bundles;
- personal information unrelated to public attribution;
- third-party assets without an entry in `legal/third-party-assets.json`.

`./scripts/check-public-release-hygiene.sh` enforces the mechanical portion of this policy. Human review remains required for screenshots, trademarks, and third-party license obligations.

## Operational records

Planning, worker handoffs, build receipts, deployment evidence, and private environment details belong in the project's private operations system and private Wiki. Product behavior that users or contributors rely on must be distilled into public-neutral documentation before release.

## Source and release defaults

Public builds default to the YouEye GitHub repositories. Development, beta, Forgejo, and custom HTTPS sources remain explicit opt-in configuration and must preserve signed release, same-origin, checksum, and exact-source verification.

Stable trust and Stable publication are separate protected operations. Development trust must never be relabeled as Stable trust.

## Third-party material

`THIRD_PARTY_NOTICES.txt` is generated from `legal/third-party-assets.json`. Each distributable artifact must carry the product license, trademark policy, and applicable third-party notices. An SPDX SBOM complements but does not replace required license and attribution text.

## Public history

Removing private material in a new commit does not remove it from earlier commits. The first public GitHub publication must use an owner-approved curated baseline or a separately authorized history rewrite. Private Forgejo history must not be mirrored wholesale by default.
