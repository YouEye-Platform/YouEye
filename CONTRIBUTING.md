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

## Development version baseline

Before the next release, align each component's development version with its
latest published Stable base and choose an unused six-position development
iteration (for example, `0.5.1.0.0.1` after Stable `0.5.1`). Never lower a
component already on a newer base. A public snapshot can advance its release
version without advancing the development branch automatically; compare source
content separately from version numbers. Keep all registered version authorities
consistent. Existing release locks describe real published inputs: do not replace
their versions, tags or hashes with values for artifacts that do not exist.

Source preparation does not require a Development release. The release workflow
merges reviewed development source, assigns the destination version, then builds
and publishes only when explicitly started. Private Alpha uses five positions;
public Stable uses three. A source-only task must not create tags or releases.
