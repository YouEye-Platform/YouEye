# Product releases (native apps, Pointer, Market catalog)

The native apps (Notes, Wiki, Search, Translate, Weather, Cinema), Pointer and the Market catalog are released from
their own repositories and promoted like the System (see [releases.md](releases.md)). Nothing is signed; integrity
comes from HTTPS and SHA-256.

## Tags and versions

- Apps and Pointer: `v<version>`; Market catalog: `catalog-v<version>`. A build is `X.Y.Z-dev.N`; promotion writes a
  new document for the same build named `X.Y.Z-alpha.N`, `X.Y.Z-beta.N` or `X.Y.Z` (see [releases.md](releases.md)).
  Ordering uses the embedded build manifest's `build_version`, never the release name.
- The Control Panel finds a product only through the box's channel index (Spine `GET /api/releases/index`); it
  never lists releases and never derives a repository from an app manifest.

## The document

`product-release.json` (`youeye.product-release.v1`, `authority: "digest"`):

```json
{"schema":"youeye.product-release.v1","product":"notes","version":"0.6.1","tag":"v0.6.1",
 "source_tree":"<40 hex>","sequence":1762950000,"minimum_reader":1,"authority":"digest",
 "build_manifest_base64":"<base64 of youeye.product-build.v1>"}
```

The embedded `youeye.product-build.v1` has `product`, `kind` (`native`, `source` or `catalog`), `build_version`,
`source_tree`, `input_sha256`, the `primary` asset name (`standalone.tar` for native apps) and `assets`, each
`{name, sha256, size_bytes, release?}`. `contract_sha256` is the digest of the installer contract
(`youeye-app.yaml` for native apps, `pointer-build-contract.json` for Pointer, `catalog-snapshot.json` for the
Market catalog). No source,
branch, channel, commit or URL is inside; a promotion changes only `version` and `tag` and keeps
`build_manifest_base64` byte for byte. The accepted document's SHA-256
(which must equal the channel index entry) is the installed identity.

## Market catalog

The catalog release carries `catalog-snapshot.json` (the contract), `catalog.tar` (the primary asset: a plain,
deterministic tar of exactly the files the snapshot lists) and `product-release.json`. The official Market is read
from `catalog.tar`; every file is checked against the snapshot. `catalog.yaml` names the native apps by id only
(`native: [notes, wiki, search, translate, weather, cinema]`); the box resolves each one through its channel index.

The reader is `control-panel/src/lib/releases/product-release.ts`. Unknown fields and duplicate JSON keys are
rejected.

## Never older, never different

The Control Panel keeps a floor per product: the installed build version and its build digest. It refuses a
channel entry whose build is older ("waiting for the channel to catch up"), and one that claims the installed build
version with other contents.
