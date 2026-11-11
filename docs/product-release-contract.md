# Product releases (native apps, Pointer, Market catalog)

Independently versioned products — the native apps (Notes, Wiki, Search,
Translate, Weather, Cinema), Canvas, Pointer and the Market catalog — are
published as releases in their own repositories. Nothing is signed; integrity
comes from HTTPS and SHA-256.

## Tags

The tag is derived from the branch and version: `v<version>` on `main`,
`<branch>-v<version>` on any other branch, with a `catalog-` prefix for the
Market catalog (for example `catalog-v0.5.24-alpha.3`). The Control Panel picks
the newest tag for the branch it follows; for native apps that is the branch of
the selected Market source.

## Two accepted shapes

1. **Plain archive.** A release with `standalone.tar` (native apps, Pointer on
   first install). Its digest can be pinned by the app manifest's
   `artifactSHA256`; otherwise HTTPS alone protects it.
2. **Product release document.** `product-release.json`
   (`youeye.product-release.v1`, `authority: "digest"`) embeds the immutable
   build description `youeye.product-build.v1` (base64), which lists every asset
   by name, URL, SHA-256 and size, names the primary asset and records
   `contract_sha256`: the digest of the installer contract (`youeye-app.yaml` for
   native apps, `pointer-build-contract.json` for Pointer, `catalog-snapshot.json`
   for the Market catalog). The release `sequence` only moves forward per source
   and branch. The accepted document's SHA-256 is the installed identity.

The reader is `control-panel/src/lib/releases/product-release.ts`. Unknown
fields and duplicate JSON keys are rejected. Asset files that older releases
carried (`.sig`, `.pub`, `SHA256SUMS`, provenance, SBOM) are ignored.
