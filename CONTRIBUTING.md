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
