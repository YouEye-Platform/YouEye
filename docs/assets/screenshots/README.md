# Product screenshot provenance

The previous development captures were removed from the public-bound tree because their rendered contents could not be reliably audited for personal data and third-party material with the available source evidence. Their immutable file identities remain recorded in `legal/screenshot-inventory.json` for private traceability; the images themselves are not runtime dependencies.

Ordinary source validation checks the inventory schema and proves that each listed image is absent, so it works in shallow and filtered source checkouts. Maintainers with the complete repository history can additionally run `node legal/third-party-assets.test.mjs --verify-screenshot-history` to verify every recorded byte count and SHA-256 against its exact historical Git object. That strict mode fails if a commit or object is unavailable or does not match.

Public replacements must use synthetic accounts, neutral `example.test` domains, documentation-only network addresses where shown, and content created for the documentation capture. Review each replacement for personal names, email addresses, account avatars, private domains or addresses, machine identifiers, user-created content, and third-party media or marks. Record the capture version and approval here before committing it.
