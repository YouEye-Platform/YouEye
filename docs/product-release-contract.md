# Product releases (native apps, Pointer, Market catalog)

The native apps (Notes, Wiki, Search, Translate, Weather, Cinema), Pointer and the Market catalog are released from
their own repositories and promoted like the System (see [releases.md](releases.md)). Nothing is signed; integrity
comes from HTTPS and SHA-256.

## Tags and versions

- Apps and Pointer: `v<version>`; Market catalog: `catalog-v<version>`. Versions are `X.Y.Z-rc.N` and never name a
  channel; there are no branch-prefixed tags.
- The Control Panel finds a product only through the box's channel index (Spine `GET /api/releases/index`); it
  never lists releases and never derives a repository from an app manifest.

## The document

`product-release.json` (`youeye.product-release.v1`, `authority: "digest"`):

```json
{"schema":"youeye.product-release.v1","product":"notes","version":"0.6.1-rc.1","tag":"v0.6.1-rc.1",
 "source_tree":"<40 hex>","sequence":1762950000,"minimum_reader":1,"authority":"digest",
 "build_manifest_base64":"<base64 of youeye.product-build.v1>"}
```

The embedded `youeye.product-build.v1` lists every asset as `{name, sha256, size_bytes, release?}`, names the
primary asset and records `contract_sha256`: the digest of the installer contract (`youeye-app.yaml` for native
apps, `pointer-build-contract.json` for Pointer, `catalog-snapshot.json` for the Market catalog). No source,
branch, channel, commit or URL is inside, so the bytes are the same on every host. The accepted document's SHA-256
(which must equal the channel index entry) is the installed identity.

## Market catalog

The catalog release carries `catalog-snapshot.json` (the contract), `catalog.tar` (the primary asset: a plain,
deterministic tar of exactly the files the snapshot lists) and `product-release.json`. The official Market is read
from `catalog.tar`; every file is checked against the snapshot. Native-app entries in `catalog.yaml` name only the
app id (`- id: notes` with `integration: native`); the box resolves them through its channel index.

The reader is `control-panel/src/lib/releases/product-release.ts`. Unknown fields and duplicate JSON keys are
rejected.
