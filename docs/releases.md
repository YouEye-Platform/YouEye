# Releases, channels and promotion

Every product is built once and promoted unchanged through four channels:

| Channel | Host | Branch | Release type |
|---|---|---|---|
| `dev` | development forge (Forgejo) | `dev` | prerelease |
| `alpha` | development forge | `main` | prerelease |
| `beta` | GitHub `YouEye-Platform` | `beta` | prerelease |
| `stable` | GitHub `YouEye-Platform` | `main` | normal (latest) |

Products: YouEye (the System), the native apps (Notes, Wiki, Search, Translate, Weather, Cinema), Pointer and the
Market catalog. Nothing is signed; integrity comes from HTTPS and SHA-256.

## Signing is off

Releases are unsigned until signing returns, through an update, before the public Release. Every release document
says `"authority": "digest"`, and readers refuse any other value (`releasecache/core_release.go`,
`control-panel/src/lib/releases/product-release.ts`). Trust works like this: the channel index names a document's
SHA-256; the document names every file's SHA-256 and size; the box records the accepted document's SHA-256. All
downloads use HTTPS with normal certificate checks. When signing returns, it attaches at `authority`.

## Versions: one build, a name per channel

| What | Name | Example |
|---|---|---|
| A build (every publish; the dev channel) | `X.Y.Z-dev.N` | `0.6.2-dev.2` (the second build of 0.6.2) |
| The same build on alpha | `X.Y.Z-alpha.N` | `0.6.2-alpha.1` |
| The same build on beta | `X.Y.Z-beta.N` | `0.6.2-beta.1` |
| The same build on stable | `X.Y.Z` | `0.6.2` |

- `VERSION` in each repository holds the line (`0.6.2`); the publish tool picks the next free `dev.N` and passes the
  full **build version** to the build as `YOUEYE_VERSION`. Binaries, `version.json` and build manifests carry the
  build version. A failed build bumps `N`.
- **Promotion never rebuilds and never changes a file.** It writes one new small release document that names the
  build under the channel's name and binds the very same files by SHA-256. A fix found on alpha is new code: a new
  build (`dev.3`) promoted as `alpha.2`. Stable happens once per line; the next stable is a new line.
- **Only builds are ordered** (`X`, `Y`, `Z`, then `N` of `X.Y.Z-dev.N`). Release names are for people: a box on
  alpha showing `0.6.2-alpha.1` may run an older build than a box on dev showing `0.6.2-dev.5`.
- Go binaries get the build version through `-ldflags`; the Control Panel, UI, apps and Pointer write it into a
  `version.json` (or their build manifest) at build time. `package.json` versions are a `0.0.0` placeholder.

## Build identity

A build is identified by its **git tree** (`git rev-parse <commit>^{tree}`), which is the same on every host. The
public GitHub repositories receive only one snapshot commit per beta or stable promotion, carrying exactly that
tree and parented on the previous public commit. Development history never goes public, and Forgejo and GitHub
never share commits.

## Release documents

- **System:** release `youeye-v<name>` with `core-release.json` (`youeye.core-release.v1`, see
  [core-release-contract.md](core-release-contract.md)). Its `version` is the release name and its `build` the build
  version; on dev they are equal.
- **Apps and Pointer:** release `v<name>`; **Market:** `catalog-v<name>`. Each has `product-release.json` (see
  [product-release-contract.md](product-release-contract.md)) embedding the immutable build manifest
  (`build_version` = the build).
- Documents **name** files (`{name, sha256, size_bytes, release?}`) and never locate them. A client downloads
  `<repository>/releases/download/<tag>/<name>`, using the repository and tag where it found the document (or the
  blob's `release` tag in the same repository). No source, branch, channel or commit URL is inside.
- Where the files are: a dev release holds its build's files (or names an earlier release for unchanged parts); an
  alpha release on the development forge names the Forgejo releases that hold them (System) or holds copies
  (products); beta and stable releases on GitHub hold a copy of every file, so a public release is self-contained.

## Channel index (no release listing)

Boxes never list releases and never call a release API (`api.github.com` allows 60 anonymous requests per hour
per public IP; a home with two boxes used that up within hours). No product code or default names a private host;
the only built-in source is the official repository (`OfficialRepository` and `OfficialIndexHost` in
`releasecache/repository.go`); `scripts/check-public-release-hygiene.sh` refuses a tree that names the development
forge before it goes public. Boxes read one small file per channel (`releasecache/channel.go`,
`control-panel/src/lib/releases/channel-index.ts`):

```json
{"schema":"youeye.channel.v1","channel":"stable","published_at":"2026-11-12T10:00:00Z",
 "products":{
   "youeye":{"repository":"https://github.com/YouEye-Platform/YouEye","tag":"youeye-v0.6.2","version":"0.6.2","build":"0.6.2-dev.2","document":"core-release.json","sha256":"…"},
   "notes": {"repository":"https://github.com/YouEye-Platform/Notes","tag":"v0.6.1","version":"0.6.1","build":"0.6.1-dev.1","document":"product-release.json","sha256":"…"}
 }}
```

- Location: asset `index.json` of release `channel-<channel>` in the YouEye repository of the channel's host:
  `<youeye repository>/releases/download/channel-<channel>/index.json`. For the official repository's `beta` and
  `stable` channels a copy is served at `https://releases.youeye.me/v1/channels/<channel>.json` and tried first.
- The client downloads the entry's document and refuses it unless its SHA-256 equals the index entry. `build` is the
  entry's build version, used for ordering.
- Products: `youeye`, `pointer`, `market`, `notes`, `wiki`, `search`, `translate`, `weather`, `cinema`.
- **Read leniently, so later indexes never cut a box off:** unknown keys at any level are ignored, a product this
  reader doesn't know is skipped, and an invalid entry makes only that product unavailable (`Invalid` in Go,
  `invalid` in the CP). Only a different `schema` means an incompatible index. A new product or field therefore
  needs no stepping stone.
- Optional per entry:
  - `download_base`: an HTTPS URL (no query, no trailing slash). The release's document and files are then
    downloaded from `<download_base>/<tag>/<name>` instead of `<repository>/releases/download/<tag>/<name>`, so
    the publisher can move files off GitHub (a CDN change, an org rename, rate limits) without a box update.
    The base must also hold every other tag the release's blobs name (`release` fields of reused image files):
    they are fetched from `<download_base>/<that tag>/<name>`. Nothing sets it yet; a file mirror on
    `releases.youeye.me` is a Backlog item.
  - `stepping_stones` (`youeye` only): older releases a box installs first when it can't install the head
    (`{tag, version, build, document, sha256, minimum_release, minimum_reader[, download_base]}`; see
    [core-release-contract.md](core-release-contract.md#older-readers-and-stepping-stones)). An unreadable stone is
    skipped. `Tools/release/index stone add|remove <channel> <version>` manages them; they stay when the head moves.
- Downloads may be redirected to any HTTPS host (every file is checked by SHA-256 and size); leaving HTTPS,
  credentials, fragments and release-listing APIs are refused.
- An HTTP 403 or 429 from a release host is reported as "release host refused or rate-limited the request" and
  retried with backoff — never as a network failure. `install.sh` also retries 5xx and network failures the same
  way (30, 60, 120 s) and does not retry a 404.

Who reads it:

| Client | Reads |
|---|---|
| `install.sh` | the channel's `youeye` entry, then `core-release.json` and the Installer by digest |
| Installer | the index, or an exact `--release-tag` + `--core-manifest-sha256` handed over by `install.sh` |
| First-boot network check | one GET of the index (a 403/429 answer still proves the network works) |
| Spine (`youeye update core check`) | the `youeye` entry of the box's channel |
| Control Panel | native apps, Pointer and the Market catalog through Spine `GET /api/releases/index` |

## The box's channel

The installer writes `/var/lib/youeye-state/bootstrap/release-policy.json`:

```json
{"schema":"youeye.release-policy.v1","repository":"https://github.com/YouEye-Platform/YouEye","channel":"stable",
 "core_manifest_sha256":"…"}
```

- `repository` never changes after installation. The only built-in default is the official public repository;
  any other one (for example a development forge) is used only because `--repository` was given at install.
- `youeye channel get|set <channel>` (or Settings in the Control Panel, through Spine `PUT /api/releases/channel`)
  switches between channels of the same repository.
- **A box never downgrades.** If the channel's current build is older than the installed build, the update check
  says so (`behind: true`) and the box waits for the channel to catch up. The same build under another channel's
  name is not older; taking it only records the new document (no file changes).

## Install

```sh
curl -fsSL https://releases.youeye.me/install.sh | sh                       # official stable
curl -fsSL https://releases.youeye.me/install.sh | sh -s -- --channel beta  # official beta
curl -fsSL <repository>/releases/download/<tag>/install.sh | sh -s -- --repository <repository> --channel dev
```

`install.sh` is an asset of every System release; `releases.youeye.me/install.sh` is the copy of the current stable
release.

## Publishing and promotion (tools in the YouEye Mega workspace)

- `Tools/release/publish` — next `dev.N`, build, `core-release.json`, Forgejo prerelease, dev index.
- `Tools/release/app-release <repo>` then `Tools/release/index set dev …` — the same for apps, Pointer, Market.
- `Tools/release/promote <product|all> <alpha|beta|stable>` — never rebuilds; writes the channel's document
  (`alpha.N`, `beta.N`, `X.Y.Z`) for the same build:
  - **alpha:** a promotion commit with the build's exact tree on the development forge's `main`; the alpha release
    and index on the development forge.
  - **beta / stable:** after a public hygiene check of the tree (no private host names), one GitHub snapshot commit
    with that tree on `beta` / `main`; the GitHub release with a copy of every file, each verified by SHA-256; the
    GitHub index and the `releases.youeye.me` copy (`install.sh` too on stable).
