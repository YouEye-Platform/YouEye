# Releases, channels and promotion

Every product is built once and promoted unchanged through four channels:

| Channel | Host | Branch | Release type |
|---|---|---|---|
| `dev` | development forge (Forgejo) | `dev` | prerelease |
| `alpha` | development forge | `main` | prerelease |
| `beta` | GitHub `YouEye-Platform` | `beta` | prerelease |
| `stable` | GitHub `YouEye-Platform` | `main` | normal (latest) |

Products: YouEye (the System), the native apps (Notes, Wiki, Search, Translate, Weather, Cinema) and Pointer.
Nothing is signed; integrity comes from HTTPS and SHA-256. The Market is not a product: it has no releases and is
published as static files ([market-format.md](market-format.md)); its old index entry is
[removed with 0.6.13](#the-frozen-market-entry).

## Signing is off

Releases are unsigned until signing returns, through an update, before the public Release. Every release document
says `"authority": "digest"`, and readers refuse any other value (`releasecache/core_release.go`,
`control-panel/src/lib/releases/product-release.ts`). Trust works like this: the channel index names a document's
SHA-256; the document names every file's SHA-256 and size; the box records the accepted document's SHA-256. All
downloads use HTTPS with normal certificate checks. When signing returns, it attaches at `authority`.

## Versions: one build, a name per channel

| What | Name | Example |
|---|---|---|
| A build (every publish; the dev channel) | `X.Y.Z-dev.N` | `0.6.13-dev.5` (the fifth build of 0.6.13) |
| The same build on alpha | `X.Y.Z-alpha.N` | `0.6.13-alpha.1` |
| The same build on beta | `X.Y.Z-beta.N` | `0.6.13-beta.1` |
| The same build on stable | `X.Y.Z` | `0.6.13` |

- `VERSION` in each repository holds the line (`0.6.13`); the publish tool picks the next free `dev.N` and passes the
  full build name to the build as `YOUEYE_VERSION`, and the git tree as `YOUEYE_SOURCE_TREE`; `.youeye/build/lib.sh`
  derives `YOUEYE_LINE` (`X.Y.Z`, checked against `VERSION`). A failed build bumps `N`.
- **Promotion never rebuilds and never changes a file.** It writes one new small release document that names the
  build under the channel's name and binds the very same files by SHA-256. A fix found on alpha is new code: a new
  build (`dev.6`) promoted as `alpha.2`. Stable happens once per line; the next stable is a new line. A fix for
  a release that is already out is a [patch release](#patch-releases) on the next free line.
- **Build names exist only on dev.** On dev a release's `version` is its build name. A promoted release is named
  only by its channel name; nothing a box shows names the dev build it came from.
- What is baked into files: since 0.6.13 only the line and the git tree. Spine gets them through `-ldflags`
  (`cmd.Version` is the line, `cmd.SourceTree` the tree; the image's seed Spine is built the same way and must equal
  the Spine artifact byte for byte), the Control Panel and UI write `{"version": "<line>", "source_tree": "<tree>"}`
  into `version.json` (`scripts/write-version.mjs`), and `build-inputs.json` names the parts by tree and SHA-256
  only. The one exception is the image's internal identity: `image_version` in `appliance-manifest.json` and
  `target_image_version` in `system-update-manifest.json` stay the image build's dev name, because the A/B engine
  orders and keys images by it (Plan 12 decision 9). No release document repeats it and nothing shows it to the
  owner: no screen (installer, console, Recovery menu, Control Panel) and no command's normal output or error
  message. It stays in those two manifests, in State records and logs (`appliance-state.json`, the update journal,
  the image binding, the boot entries' `version` key that orders the two System entries) and in `--json` output. The manifests' `release_set`
  names Spine, Control Panel and UI by the line. Up to 0.6.12 the files baked the build name (Spine up to 0.6.11
  compared it with the release document). Code identifies files by git tree and SHA-256, never by a baked name.
  `package.json` versions are a `0.0.0` placeholder. Native apps and Pointer follow with their next releases
  (Plan 12 Part F).

## Ordering: line, then sequence

Releases are ordered by one rule everywhere (Go `releasecache.CompareReleases` in `releasecache/order.go`,
TypeScript `compareReleases` in `control-panel/src/lib/version.ts`; both read the shared vectors in
`releasecache/testdata/release-order.json`), for the System and for every product:

1. the **line** `X.Y.Z`, numerically (0.6.9 before 0.6.10);
2. then the build's **`sequence`**: its publish time in Unix seconds, written once when the build is published and
   kept by every promotion. The publish tools refuse a sequence that is not higher than every earlier release of
   the product.

**Release names are labels and are never compared.** The dev, alpha, beta and stable documents of one build have
the same key and are the same release. A stable `0.6.13` is older than a later `0.6.13-dev.6`, and `0.6.13-alpha.2`
is older than a `0.6.13-dev.1` published after it. An old-shape document's `build` field is not used for ordering.
The same key means the same build: a document with that key must then install the same files (the same payload
digest, [core-release-contract.md](core-release-contract.md#host-independence)), or it is refused.

`minimum_release` in a System document and `requires.youeye` in an app manifest are compared by line only
(`MinimumReleaseMet`, `meetsMinimumRelease`): any release of that line or a later one meets them. An old value
written as a build name (`0.6.5-dev.2`) is read as its line.

## What a box shows

A box shows the `version` of the release document it installed, on its channel, and nothing else: `0.6.13-dev.5`
on dev; the same files promoted show `0.6.13-alpha.1`, `0.6.13-beta.1` or `0.6.13`. A dev box shows its dev name
everywhere, because that is its version. The same version is used by the Control Panel (About, Settings → System,
Settings → Apps, backups), the CLI (`youeye version`, `youeye status`, `youeye spine status`), the
console, the dashboard (from `/etc/youeye/release.json`, [control-panel.md](control-panel.md#the-installed-release)),
the heartbeat to the YouEye Names broker and the platform context apps get (`requires.youeye` checks it too).

Native apps and Pointer keep the name of the release they installed: the same build under another channel's name
is not offered as an update and not applied, so after a channel switch Notes still shows `0.6.4` where alpha calls
that build `0.6.4-alpha.1`, until a newer build arrives (since 0.6.17, [native-apps.md](native-apps.md)).

For support, a details line gives the git tree: About shows `0.6.13 · b39fe307` (version · short tree) with a Copy
button, and `youeye version --verbose` lists the release tree and each part's tree and SHA-256
([spine.md](spine.md#commands)). Neither shows a build name.

## Build identity

A build is identified by its **git tree** (`git rev-parse <commit>^{tree}`), which is the same on every host. The
public GitHub repositories receive only one snapshot commit per beta or stable promotion, carrying exactly that
tree and parented on the previous public commit. Development history never goes public, and Forgejo and GitHub
never share commits.

## Release documents

- **System:** release `youeye-v<name>` with `core-release.json` (`youeye.core-release.v1`, see
  [core-release-contract.md](core-release-contract.md)). Its `version` is the release name. Documents up to 0.6.12
  also carry `build` (the dev name of the build) and a `build_version` per member; from 0.6.13 they carry neither
  and say `minimum_reader: 2`.
- **Apps and Pointer:** release `v<name>`. Each has `product-release.json` (see
  [product-release-contract.md](product-release-contract.md)) embedding the immutable build manifest. Old-shape
  manifests name the build in `build_version`; new-shape ones (reader 2) do not.
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
   "youeye":{"repository":"https://github.com/YouEye-Platform/YouEye","tag":"youeye-v0.6.13","version":"0.6.13","build":"0.6.13","document":"core-release.json","sha256":"…",
             "stepping_stones":[{"tag":"youeye-v0.6.12","version":"0.6.12","build":"0.6.12-dev.4","sequence":1795100000,"document":"core-release.json","sha256":"…","minimum_release":"0.6.5-dev.2","minimum_reader":1}]},
   "notes": {"repository":"https://github.com/YouEye-Platform/Notes","tag":"v0.6.4","version":"0.6.4","build":"0.6.4","document":"product-release.json","sha256":"…"}
 }}
```

- Location: asset `index.json` of release `channel-<channel>` in the YouEye repository of the channel's host:
  `<youeye repository>/releases/download/channel-<channel>/index.json`. For the official repository's `beta` and
  `stable` channels a copy is served at `https://releases.youeye.me/v1/channels/<channel>.json` and tried first.
- The client downloads the entry's document and refuses it unless its SHA-256 equals the index entry. **A document
  matches its entry by tag, version and digest** (`fetchCoreEntry` in `releasecache/channel.go`,
  `verifyChannelEntryDocument` in `control-panel/src/lib/releases/channel-index.ts`). The entry says nothing about
  order: the document's line and `sequence` do.
- **`build` is temporary**, kept only for readers up to 0.6.11, which refuse an entry without it and require it to
  equal an old-shape document's `build`. The tools write the document's `build` when it has one (0.6.12 and
  earlier) and the entry's `version` otherwise (0.6.13 and later), so a promoted entry never names a dev build.
  Readers from 0.6.12 on neither check nor use it. It is deleted before the Release, with the 0.6.12 stones.
- Products: `youeye`, `pointer`, `notes`, `wiki`, `search`, `translate`, `weather`, `cinema`. Readers from 0.6.13
  skip a `market` entry like any product they do not know ([below](#the-frozen-market-entry)).
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
    (`{tag, version, build, sequence, document, sha256, minimum_release, minimum_reader[, download_base]}`; see
    [core-release-contract.md](core-release-contract.md#older-readers-and-stepping-stones) and
    [below](#stepping-stones-from-0611-to-0613)). `build` is the temporary field above; `sequence` (from 0.6.12, absent
    in older indexes) repeats the document's, so a box can order stones before fetching them. An unreadable stone is
    skipped. `Tools/release/index stone add|remove <channel> <version>` manages them (at most one per line, each
    older than the head); they stay when the head moves.
- Downloads may be redirected to any HTTPS host (every file is checked by SHA-256 and size); leaving HTTPS,
  credentials, fragments and release-listing APIs are refused.
- An HTTP 403 or 429 from a release host is reported as "release host refused or rate-limited the request" and
  retried with backoff — never as a network failure. `install.sh` also retries 5xx and network failures the same
  way (30, 60, 120 s) and does not retry a 404.

Every channel index fetch (`releasecache.FetchChannelIndex`, so also the update check through `ChooseCoreRelease`)
asks each index address with `If-None-Match` and the ETag of the last good copy that address served in this
process; a `304` answers that copy (`releasecache/channel_fetch.go`). Spine answers `GET /api/releases/index` from a
copy it keeps for 5 minutes plus 0–10 % jitter (`releasecache.NextChannelIndexCheck`), and while the release host
fails (back-off from 30 s, doubling up to 10 minutes) it answers the last good index; only with no good copy yet
does it answer the error (`spine/internal/api/releases.go`).

Who reads it:

| Client | Reads |
|---|---|
| `install.sh` | the channel's `youeye` entry, then `core-release.json` and the Installer by digest |
| Installer | the index, or an exact `--release-tag` + `--core-manifest-sha256` handed over by `install.sh` |
| First-boot network check | one GET of the index (a 403/429 answer still proves the network works) |
| Spine (`youeye update core check`) | the `youeye` entry of the box's channel |
| Control Panel | native apps and Pointer through Spine `GET /api/releases/index` (never the Market) |

### The frozen Market entry

Up to 0.6.10 the Market was a product of the channel index (release `catalog-v<name>` with `catalog.tar`). Until
0.6.13 every channel index carried that `market` entry, frozen at the 0.6.4 catalog (build `0.6.4-dev.3`, named for
each channel), because boxes up to 0.6.10 read their Market only from it. It goes with 0.6.13 (owner decision, Plan
12): Spine from 0.6.13 no longer lists `market` among the index products (`releasecache.Products`; the Control
Panel never did since 0.6.11), and the entry is taken out of every channel index with the release tools when 0.6.13
is published and promoted. Boxes up to 0.6.10 then have no Market until they update YouEye, after which they read
the Market by address.

## The box's channel

The installer writes `/var/lib/youeye-state/bootstrap/release-policy.json`:

```json
{"schema":"youeye.release-policy.v1","repository":"https://github.com/YouEye-Platform/YouEye","channel":"stable",
 "core_manifest_sha256":"…"}
```

- `repository` is set at install. The only built-in default is the official public repository; any other one (for
  example a development forge) is used only because `--repository` was given at install, or because an admin
  switched to it (below). The product never suggests another host.
- `youeye channel get|set <channel>` (or Settings → System in the Control Panel, through Spine
  `PUT /api/releases/channel`) switches between channels of the same repository.
- **Switching repository** (since 0.6.16, YE-130; owner, 2026-11-23): `youeye channel set <channel> --repository
  <url>` as root on the box, or Settings → System → Change… (admins; Spine `PUT /api/releases/channel` with
  `{"channel":…,"repository":…}`). Both run `systemupdate.SetReleaseSource`, which:
  - refuses before `/var/lib/youeye-state/first-deploy/complete` exists (first boot binds the install-time
    repository);
  - canonicalises the URL (`releasecache.CanonicalRepository`: `https://host/owner/repository`, no credentials,
    query or fragment; a trailing `/` or `.git` is dropped);
  - reads that repository's channel index once, with the same client and discovery as the box's other index reads,
    and refuses unless it parses, has a `youeye` entry and that entry names the same repository;
  - refuses when the policy changed while the index was read (another admin or the CLI);
  - records the old repository's download address (`<repository>/releases/download`) in `download-bases.json` for
    the installed release's tag and the last update journal's target tag, unless the index named one for them: the
    new repository may not hold those tags, and a Control Panel redeploy, a Spine adopt or a stage under way still
    needs their files;
  - then writes `repository` and `channel` (the same atomic write as a channel switch). `release-policy.json` keeps
    `youeye.release-policy.v1` and its fields; older Spines read it unchanged.

  The answer names the head the new channel offers (`head_version` in the API). The update check, the downloads of
  every newer release, and native apps and Pointer (the Control Panel reads them through Spine's
  `/api/releases/index`) read the repository live, so updates now depend on that host. Booting never needs the
  new host: the network check ([above](#channel-index-no-release-listing)) runs at the first deploy, before a switch
  is allowed, and again only when network settings are changed from the console (`youeye-installer network`),
  which then needs the new host too. The same ordering applies: a switch never downgrades.
- **A box never downgrades.** After a channel switch the box takes any release with a higher key
  ([line, then sequence](#ordering-line-then-sequence)) and never older files:
  - a stable box on 0.6.13 that switches to dev takes the dev channel's current build when it was published after
    the build 0.6.13 came from (a later `0.6.13-dev.N` or a later line);
  - a box on `0.6.13-dev.7` that switches to stable, where 0.6.13 is `dev.5` promoted, waits for a later stable
    (0.6.14). `youeye update core check` then says `"behind": true` with a message that names versions only:
    `channel stable offers 0.6.13; this box has 0.6.13-dev.7; waiting for it to catch up`. Settings → System shows
    that message and offers no update. Native apps and Pointer say the same per product
    ([troubleshooting.md](troubleshooting.md#waiting-for-the-channel-to-catch-up));
  - the same build under another channel's name (`0.6.13-dev.5` → `0.6.13-alpha.1`) is not older; taking it only
    records the new document (a metadata-only update, no file changes).

## Stepping stones: from 0.6.11 to 0.6.13

Plan 12 removed build names from what a box shows and, from 0.6.13, from the release documents. A 0.6.11 box cannot
read a document without `build`, so it reaches 0.6.13 through 0.6.12, on every channel:

| Release | Documents | Readers it ships |
|---|---|---|
| 0.6.11 | old shape (`build`, member `build_version`), `minimum_reader: 1` | reader 1: requires `build` in documents and index entries, orders by build name |
| 0.6.12 (the stone) | old shape, exactly as 0.6.11 expects; `minimum_release` `0.6.5-dev.2` | reader 2: reads both shapes, orders by line and sequence, writes State records in both shapes |
| 0.6.13 | no `build`, no `build_version`, `minimum_reader: 2`, `minimum_release` `0.6.12` | reader 2 |

- 0.6.12 keeps the old shape because a 0.6.11 box runs **its own Spine** for the first steps of the update to 0.6.12,
  and that Spine compares each member's `build_version` with the name baked into the new files. 0.6.12 also rebuilds
  the image, so after the update one slot holds a reader-2 seed Spine; 0.6.13 rebuilds it into the other slot.
- A 0.6.11 box reads `minimum_reader` first, gets "needs a newer reader" for the 0.6.13 head and looks for a
  stone; a 0.6.12 box installs the head directly. Every channel index keeps 0.6.12 as a stone of the 0.6.13 head,
  with its `sequence` and its old-shape `build` (0.6.11 readers require it). The 0.6.11 box takes the stone
  (`youeye update core check` says `"stepping_stone": true` and names `channel_head` and `head_refused`), then
  updates again to 0.6.13.
- The tools make the outgoing head the stone in the same index write as the new head: `Tools/release/publish
  --stone-previous` on dev and `Tools/release/promote youeye <channel> --stone-previous` on alpha, beta and stable.
  Both refuse when the outgoing head's line is below the new release's `minimum_release` line (0.6.11 as the stone
  of 0.6.13 would strand its boxes).
- Old installer ISOs cannot install a channel whose head is 0.6.13; `install.sh` can
  ([install.md](install.md#old-isos)).
- Until the Release cleanup: readers accept both shapes, index entries keep the temporary `build`, the 0.6.12
  stones stay in the indexes, and State and Data records are written in both shapes
  ([development.md](development.md#compatibility-rules-for-later-changes)). All of it is deleted before the Release
  (Backlog), and only once it is shown that no supported release (stable 0.6.15 or later) needs it.

**0.6.17 needs 0.6.16** (`.youeye/minimum-release`, YE-134): 0.6.17's Control Panel has Caddy's proxy devices send
PROXY headers, which only a Caddy config with 0.6.16's listener wrappers can read
([architecture.md](architecture.md#networks), "Client addresses"). A box below 0.6.16 takes 0.6.16 as a stepping
stone first (`--stone-previous` when 0.6.17 is published and promoted, with 0.6.16 as the outgoing head), so no
channel may get 0.6.17 before it holds 0.6.16. A rollback from 0.6.17 lands on 0.6.16 or later, which keeps the
wrappers and keeps a device flag only where they are. Nothing may put a Control Panel older than 0.6.16 on a box that
ran 0.6.17 (a recovery image included): 0.6.15 rewrites the :80 setup server without the wrappers while the devices
still send headers.

## Patch releases

A patch is a fix for a version that is already released, put on the channel it is for without waiting for
everything else on `dev`. **A box needs nothing for it:** a patch is an ordinary release document with a higher key
([line, then sequence](#ordering-line-then-sequence)) than the release it fixes, so every box on the channel takes it
through the normal update, and no box ever goes back.

| Step | Who | What |
|---|---|---|
| 1 | the fixer | `Tools/release/patch start <product> <alpha\|beta\|stable> <slug>`: branch `nick/<slug>` on the development forge, starting at the commit of the release the channel holds, with `VERSION` set to the patch line |
| 2 | the fixer | fix on that branch; build it like any build, off the dev channel: `Tools/release/publish nick/<slug> --no-index` (an app or Pointer: `Tools/release/app-release <repo> --commit nick/<slug>`); test the build |
| 3 | the reviewer | bring the fix into `dev`: cherry-pick the fix commits, or merge or squash the branch (its first commit sets `VERSION` and conflicts by design: `dev` keeps its own line) |
| 4 | the publisher | `Tools/release/promote <product> <channel> --release <tag of the build>`: the same files on the channel, never a rebuild |

**The patch line.** The patch takes the first line after the fixed release's line that no release of the product
uses, on any host, under any name; `dev` then moves to the first unused line after the patch unless it is already
on a later one. Stable `0.6.15` is patched as `0.6.16`, and `dev` goes on as `0.6.17`.

- Above the fixed release's line, because boxes take only a higher key and stable names a line once.
- A line of its own, because inside one line only the publish time orders builds: a patch sharing a line with dev
  builds would sort among them by the clock, and that line's stable name could later mean two builds.
- `dev` moves above it (one commit that changes `VERSION` only), so every later dev build sorts above the patch by
  line and the next normal release is an update for patched boxes too.
- When lines in between are in use (alpha already holds `0.6.16`, so the patch of stable `0.6.15` is `0.6.17`), the
  tool warns: the patch sorts above those builds without having their code. They can no longer be promoted over
  it, and a `minimum_release` (compared by line only) must not name one of those lines while boxes may come from
  the patch.
- `minimum_release`, the reader and the stepping stones need nothing: the patch keeps the fixed release's
  `.youeye/minimum-release`, so every box that could install the fixed release installs the patch directly, the
  channel's stones stay, and a box on the patch meets every `minimum_release` the fixed release met.

**The build.** `publish` treats a ref that is not in `dev` like any other with two differences: it requires
`--no-index` (a patch never goes on the dev channel), and it reuses unchanged parts only from builds in the branch's
own history, never from a dev build that happens to have the same inputs for one part. The build is
`0.6.16-dev.1`, with its own `sequence`.

**Putting it on the channel.** `promote --release <tag>` does the ordinary promotion step (a new release document
with the channel's name, the same files and `sequence`, the snapshot commit, the index write with its stone checks)
for exactly that build, and prints its plan first:

- The target channel must take it. It is refused when the build's key is not above the channel's head, and when
  the build is not built on that head (the head's source tree is not in the build's history): it would take the
  head's changes away from every box there.
- Every channel from alpha up to the target whose head is older and part of the build takes it too, alpha first: a
  patch of stable also goes to beta and alpha while they hold the fixed release, as `0.6.16-alpha.1`,
  `0.6.16-beta.1` and `0.6.16`. A channel whose head is newer is left alone. So is a channel whose head is older by
  key but holds work the patch does not have; that head can then no longer reach the target, and the next build
  from `dev` replaces it. The dev channel is never written: it gets the fix through the merge and the next publish.
- **Merge-back.** It is refused until the build's commit is in `dev`: an ancestor of `dev`, or every commit of the
  branch has an equal in `dev` by `git patch-id` (a cherry-pick or rebase), or the whole change equals one commit
  there (a squash). `VERSION` is left out of the comparison. Otherwise the next release from `dev` would lose the fix.
- A re-run goes on where an earlier run stopped.

Two checks guard every promotion, patch or not, and pass for a build that follows the channel's head on `dev`:

- **Built on the head.** The build must have what the target's head has (its source tree in the build's history,
  or its commits in the build by patch id). After a patch reached a channel, a dev build from before the merge is
  refused there even though its line is higher.
- **Image order.** The A/B engine orders system images by their own build name and refuses an older one
  (`target_image_version`, [above](#versions-one-build-a-name-per-channel); `spine/internal/systemupdate/manifest.go`).
  A patch that changes the image builds a new one under the
  patch line; a later dev build that still reuses an image built before it is refused at promotion. Publish that
  build again with `--rebuild-image`.

## Install

```sh
curl -fsSL https://releases.youeye.me/install.sh | sh                       # official stable
curl -fsSL https://releases.youeye.me/install.sh | sh -s -- --channel beta  # official beta
curl -fsSL <repository>/releases/download/<tag>/install.sh | sh -s -- --repository <repository> --channel dev
```

`install.sh` is an asset of every System release; `releases.youeye.me/install.sh` is the copy of the current stable
release.

## Build guard (Control Panel and UI)

A System update checks the installed CP and UI trees against what was shipped
([core-release-contract.md](core-release-contract.md#installed-file-checks)), so the servers must not write into
their own trees. Both apps set `experimental.isrFlushToDisk: false` in `next.config.ts` (rendered routes stay in
memory; build seeds are still read), the Control Panel's favicon is a static file in `control-panel/public/`, and
both are on Next.js 16.4.6.

`.youeye/build/control-panel` and `.youeye/build/ui` end with `youeye_guard_standalone_payload` (`payload-guard.sh`; not in `lib.sh`, which is an input of the system image), which
runs `.youeye/build/payload-guard.mjs` on the packaged `standalone.tar`:

1. `.next/required-server-files.json` must carry `isrFlushToDisk: false`.
2. A copy of the tree is started with its bundled Node (as `nobody` when the build runs as root, state in a
   temporary directory, `NEXT_PHASE=phase-production-build` so no background jobs start). Every route in
   `.next/prerender-manifest.json`, `/favicon.ico`, `/manifest.webmanifest`, the icon routes (`/icon`,
   `/apple-icon`) and the sign-in pages (`…/login`, `…/sign-in`, `…/signin`) the build has are requested twice, the
   server is stopped, and the copy must be exactly what was packaged. No directory is exempt.
3. `/favicon.ico` and `/manifest.webmanifest` must answer HTTP 200 without a session when the tree ships them (a
   file in `public/` or a prerendered route). Other routes may answer any status.

The copy listens on loopback. When the packaged request proxy (`.next/server/middleware.js` or `proxy.js`) calls a
fixed loopback port, the copy listens on that port, so those calls reach the copy: the Control Panel's proxy calls
`http://localhost:3000`. **The guard then fails when that port is in use on the build machine** ("port 3000 is in
use on this machine …"), so the run never talks to a real local service: stop whatever listens on port 3000 there
and build again. Otherwise the copy takes any free port. When the server does not come up (it exits, or does not
answer within 90 s), the guard tries once more, on another free port unless the port is fixed.

A failure prints `payload-guard: FAILED: …` with the added, changed and removed paths, deletes `standalone.tar` and
fails the build, so nothing is published. It means the app or a framework upgrade started writing into its tree:
fix the app or its configuration. Never loosen the guard.

## Publishing and promotion (tools in the YouEye Mega workspace)

- `Tools/release/publish` — next `dev.N`, build, `core-release.json`, Forgejo prerelease, dev index. The
  document's `sequence` must be higher than every earlier YouEye release; `minimum_release` comes from
  `.youeye/minimum-release`: the line `0.6.12` since 0.6.13 (0.6.12 itself, a reader-1 document, needed a build name
  there and had `0.6.5-dev.2`). The repository's `scripts/assemble-core-release.py` writes the document: since
  0.6.13 without `build` or member `build_version`, with `minimum_reader: 2`.
  `--stone-previous` makes the outgoing dev head a stone in the same index write.
- `Tools/release/app-release <repo>` then `Tools/release/index set dev …` — the same for native apps and Pointer.
- The Market has none of these steps: a push to the catalog's `dev` or `main` branch is published to
  `market.youeye.me` ([market-format.md](market-format.md#the-official-market)).
- `Tools/release/promote <product|all> <alpha|beta|stable>` — never rebuilds; writes the channel's document
  (`alpha.N`, `beta.N`, `X.Y.Z`) for the same build, found by key and files, never by name. Release texts and
  commit messages name the version and tree only. `--stone-previous` as for publish. **Promote `youeye` alone**
  until the native apps and Pointer are rebuilt in the new shape: `all` would carry their old-shape dev heads to
  every channel, and refuses to move any product besides YouEye without `--yes`.
  - **alpha:** a promotion commit with the build's exact tree on the development forge's `main`; the alpha release
    and index on the development forge. An alpha System document names the Forgejo dev release that holds its files
    (`release` of each blob); that is an address, not a name shown anywhere.
  - **beta / stable:** after a public hygiene check of the tree (no private host names), one GitHub snapshot commit
    with that tree on `beta` / `main`; the GitHub release with a copy of every file, each verified by SHA-256; the
    GitHub index and the `releases.youeye.me` copy (`install.sh` too on stable).
- `Tools/release/patch start` and `Tools/release/promote <product> <channel> --release <tag>` — a fix for a
  released version from its own branch straight to its channel ([Patch releases](#patch-releases)).
- `Tools/release/index show <channel>` prints each product's version, tree, sequence and shape (and, for a promoted
  release, the dev build it came from); `index clean-check` reports build names (`-dev.`) in published files
  outside the listed exceptions. Details in the workspace's `Tools/README.md`.
