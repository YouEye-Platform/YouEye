# Contributing to YouEye

Thank you for helping improve YouEye.

## Before you start

- Read [LICENSE](LICENSE) and [TRADEMARK.md](TRADEMARK.md). Third-party material remains under its own terms.
- Base changes on `dev`. Release promotion and public publishing use separately authorized workflows.
- Keep product repositories public-safe. Do not commit credentials, private endpoints, personal information, machine identities, deployment transcripts, worker journals, or internal build and session records.
- Use neutral examples such as `example.test` and documentation-only addresses.

## Development

Match the surrounding code and use the repository's existing package and test commands. JavaScript workspaces use pnpm. Go modules are under `spine/` and `installer/`.

Run focused tests while developing, then the affected component's full checks. Public-bound changes must also pass:

```sh
./scripts/check-public-release-hygiene.sh
./scripts/check-public-release-hygiene_test.sh
```

If a change adds third-party code, fonts, icons, images, or other bundled material, update `legal/third-party-assets.json` and regenerate `THIRD_PARTY_NOTICES.txt`.

## Documentation and operational evidence

Commit durable product behavior and user/operator guidance here. Keep work-session bookkeeping, private infrastructure evidence, acceptance transcripts, and release-control records in the project's private operations system rather than this repository.

## Security

Do not open a public issue containing a vulnerability, credential, private key, token, or personal information. Use the project's private security contact and follow the disclosure instructions published with the public beta.

## Application lifecycle changes

Changes to application lifecycle operations must follow
[the recoverable app-update contract](docs/app-update-transactions.md).
Use `withAppLifecycle` for app mutations and preserve durable reservations
through unfinished recovery; watchdogs and reconciliation must honor them.
Recovery takes the exact recorded operation ID and a journal executor lock.
Never expire an operation because its process died, replay non-idempotent
migrations, or infer data recovery from a running container. Validate the
authenticated Market status/recovery workflow on the assigned development
target. Unit tests and quick overlays do not prove full-release acceptance.
Credential and admission writers must use the
[security and policy integration contract](docs/app-update-transactions.md#integration-contract-for-security-and-policy-writers),
including admitted generation checks and the limits of security reconciliation.

## Release version identity

New releases use `X.Y.Z[-token.N]`, retaining all three numeric positions.
Development targets the next Stable base: after `0.5.3`, use
`0.5.4-dev.N`; private main uses `alpha.N`, public Beta uses `beta.N`, and
feature releases use a collision-checked branch token with a numeric counter.
The exact case-sensitive Git branch remains separate from the display token.
Select source/channel before comparing versions; `.10` follows `.9`.

The release coordinator reserves identities with a stable request key before
building. Retry the same frozen attempt; never repurpose a used identity or
rewrite historical tags, locks or artifact versions. Failed attempts may leave
gaps. Source-only preparation does not start builds or publication, and the
existing branch/merge workflow remains in effect.

Installer, appliance, Spine, Control Panel/YouEye ID and UI share one YouEye
release sequence. Unchanged payloads retain their original build versions and
signed provenance within the complete release manifest. Pointer, native apps,
Canvas and Market retain independent product versions.
