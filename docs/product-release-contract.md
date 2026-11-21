# Product releases (native apps, Pointer)

The native apps (Notes, Wiki, Search, Translate, Weather, Cinema) and Pointer are released from their own
repositories and promoted like the System (see [releases.md](releases.md)). Nothing is signed; integrity comes from
HTTPS and SHA-256. The Market is not a product: it is published as static files
([market-format.md](market-format.md)), and no channel index carries it since 0.6.13
([the frozen Market entry](releases.md#the-frozen-market-entry)).

## Tags and versions

- Apps and Pointer: `v<version>`. A build is `X.Y.Z-dev.N`; promotion writes a
  new document for the same build named `X.Y.Z-alpha.N`, `X.Y.Z-beta.N` or `X.Y.Z` (see [releases.md](releases.md)).
- Releases are ordered like the System's: the line of `version`, then `sequence` (the build's publish time, kept by
  every promotion; `app-release` refuses one that is not higher than every earlier release of the repository).
  Release names are labels and never compared ([releases.md](releases.md#ordering-line-then-sequence)).
- The Control Panel finds a product only through the box's channel index (Spine `GET /api/releases/index`); it
  never lists releases and never derives a repository from an app manifest.

## The document

`product-release.json` (`youeye.product-release.v1`, `authority: "digest"`):

```json
{"schema":"youeye.product-release.v1","product":"notes","version":"0.6.4","tag":"v0.6.4",
 "source_tree":"<40 hex>","sequence":1795100000,"minimum_reader":2,"authority":"digest",
 "build_manifest_base64":"<base64 of youeye.product-build.v1>"}
```

The embedded `youeye.product-build.v1` has `product`, `kind` (`native` or `source`), `source_tree`,
`input_sha256`, the `primary` asset name (`standalone.tar` for native apps) and `assets`, each
`{name, sha256, size_bytes, release?}`. `contract_sha256` is the digest of the installer contract
(`youeye-app.yaml` for native apps, `pointer-build-contract.json` for Pointer). No source,
branch, channel, commit or URL is inside; a promotion changes only `version` and `tag` and keeps
`build_manifest_base64` byte for byte. The accepted document's SHA-256
(which must equal the channel index entry) is the installed identity.

**Two shapes.** The reader (`RELEASE_READER`, 2 since 0.6.12) reads both:

| Shape | `minimum_reader` | Build manifest | Written by |
|---|---|---|---|
| old | `1` | has `build_version` (the dev name of the build), so a promoted document still names it inside the base64 | every product release so far (`Tools/release/product`, `DOCUMENT_READER` 1) |
| new | `2` | no `build_version` | the same tool with `DOCUMENT_READER` 2, planned from the native apps' 0.6.4 and Pointer's 0.6.3 |

`build_version` is checked when present and never used for ordering or display. A Control Panel up to 0.6.11
(reader 1) says "needs a newer reader" for a new-shape document and waits; it updates the app once the box has
0.6.12 or later.

**Matching the channel index.** The Control Panel checks a document against the entry that named it by digest,
repository, tag and version (`verifyChannelEntryDocument`); the entry's temporary `build` field is ignored.

## Native apps in the Market

The official Market's index names native apps by id only (`native: [notes, wiki, search, translate, weather,
cinema]`; any other market's `native` list is ignored); the box resolves each one through its channel index and
reads its listing and manifest from the release's `youeye-app.yaml`, cached by the entry's digest.

The reader is `control-panel/src/lib/releases/product-release.ts`. Unknown fields and duplicate JSON keys are
rejected.

## Never older, never different

The Control Panel keeps a floor per product (`acceptProductSequence`, `compareToProductFloor` in
`product-release.ts`): in the Market install record of a native app (`productReleaseFloors`) and in Pointer's
release state. It refuses a release with an older key, line then sequence ("The channel offers notes 0.6.4; this box
has 0.6.5-dev.1; waiting for the channel to catch up"), and one with the same key but other contents. The same
build under another channel's name only updates the release record. The update checks for native apps and Pointer
and the provenance record (`lib/updates/provenance.ts`, `key`) use the same key.

A floor is written in both shapes until the Release cleanup: `{line, sequence, build, buildSHA256,
manifestSHA256}`, where `build` is the build manifest's `build_version` or, in the new shape, the release version
(a Control Panel up to 0.6.11 orders by it and requires it). A floor written before 0.6.12 has no `sequence`: it is
taken from the installed release document when that is the document the floor names. Otherwise lines decide, and
within one line the old build rule orders two build names (`-dev.N`) only; a new-shape release of that line is
newer unless it holds the floor's own build.
