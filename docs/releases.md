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

## Versions

- Every build is `X.Y.Z-rc.N`. `VERSION` in each repository holds the line (`0.6.1`); the publish tool picks the
  next free `N` for that line from the release tags and passes the full version to the build as `YOUEYE_VERSION`.
  Nothing in the source tree carries the rc number.
- A build keeps its version on every channel. A failed build bumps only `N`; the next line bumps `Z`.
- Versions order by `X`, `Y`, `Z`, then `N`. **The suffix never names a channel.**
- Go binaries get the version through `-ldflags`; the Control Panel, UI, apps and Pointer write it into a
  `version.json` (or their build manifest) at build time. `package.json` versions are a `0.0.0` placeholder.

## Build identity

A build is identified by its **git tree** (`git rev-parse <commit>^{tree}`), which is the same on every host. The
public GitHub repositories receive only one snapshot commit per beta or stable promotion, carrying exactly that
tree and parented on the previous public commit. Development history never goes public, and Forgejo and GitHub
never share commits.

## Release documents (same bytes on every host)

- **System:** release `youeye-v<version>` with `core-release.json` (`youeye.core-release.v1`, see
  [core-release-contract.md](core-release-contract.md)), every artifact, `SHA256SUMS` and `install.sh`.
- **Apps and Pointer:** release `v<version>`; **Market:** `catalog-v<version>`. Each has `product-release.json`
  (see [product-release-contract.md](product-release-contract.md)).
- Documents **name** assets (`{name, sha256, size_bytes, release?}`) and never locate them. A client downloads
  `<repository>/releases/download/<tag>/<name>`, using the repository and tag where it found the document (or the
  blob's `release` tag in the same repository). No source, branch, channel, commit or URL is inside, so the
  document — and its SHA-256 — is identical on Forgejo and GitHub.

## Channel index (no release listing)

Boxes never list releases and never call a release API (`api.github.com` allows 60 anonymous requests per hour
per public IP; a home with two boxes used that up within hours). They read one small file per channel:

```json
{"schema":"youeye.channel.v1","channel":"stable","published_at":"2026-11-12T10:00:00Z",
 "products":{
   "youeye":{"repository":"https://github.com/YouEye-Platform/YouEye","tag":"youeye-v0.6.1-rc.4","version":"0.6.1-rc.4","document":"core-release.json","sha256":"…"},
   "notes": {"repository":"https://github.com/YouEye-Platform/Notes","tag":"v0.6.1-rc.2","version":"0.6.1-rc.2","document":"product-release.json","sha256":"…"}
 }}
```

- Location: asset `index.json` of release `channel-<channel>` in the YouEye repository of the channel's host:
  `<youeye repository>/releases/download/channel-<channel>/index.json`. For the official repository's `beta` and
  `stable` channels a copy is served at `https://releases.youeye.me/v1/channels/<channel>.json` and tried first.
- The client downloads the entry's document and refuses it unless its SHA-256 equals the index entry.
- Products: `youeye`, `pointer`, `market`, `notes`, `wiki`, `search`, `translate`, `weather`, `cinema`.
- An HTTP 403 or 429 from a release host is reported as "release host refused or rate-limited the request" and
  retried with backoff — never as a network failure.

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
- **A box never downgrades.** If the channel's current release is older than the installed one, the update check
  says so (`behind: true`) and the box waits for the channel to catch up.

## Install

```sh
curl -fsSL https://releases.youeye.me/install.sh | sh                       # official stable
curl -fsSL https://releases.youeye.me/install.sh | sh -s -- --channel beta  # official beta
curl -fsSL <repository>/releases/download/<tag>/install.sh | sh -s -- --repository <repository> --channel dev
```

`install.sh` is an asset of every System release; `releases.youeye.me/install.sh` is the copy of the current stable
release.

## Publishing and promotion (tools in the YouEye Mega workspace)

- `Tools/release/publish` — next `rc.N`, build, `core-release.json`, Forgejo prerelease, dev index.
- `Tools/release/app-release <repo>` then `Tools/release/index set dev …` — the same for apps, Pointer, Market.
- `Tools/release/promote <product|all> <alpha|beta|stable>` — never rebuilds:
  - **alpha:** a promotion commit with the build's exact tree on the development forge's `main`; the alpha index
    names the same release.
  - **beta / stable:** after a public hygiene check of the tree (no private host names), one GitHub snapshot commit
    with that tree on `beta` / `main`; the GitHub release with the same tag gets the same bytes, each verified by
    SHA-256; the GitHub index and the `releases.youeye.me` copy are updated (`install.sh` too on stable).
