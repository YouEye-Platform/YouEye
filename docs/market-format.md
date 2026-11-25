# Market format (`youeye.market.v1`)

A **market** is a folder of static files at an HTTPS address. The official YouEye Market and every custom market
use the same format; a box reads all of them the same way. There are no Market releases or versions: a market
changes when its publisher puts new files in the folder. How a box uses what it reads (sources, consent, installs,
updates) is in [market.md](market.md); the app files themselves are in [app-manifest.md](app-manifest.md).

| Piece | Where |
|---|---|
| Format (schemas, limits, path rules) | `control-panel/src/lib/market/market-format.ts`, used by both the generator and the box |
| Generator and website | `control-panel/scripts/market-build.ts`, `scripts/market-site.ts` |
| "Field, since version" table | `control-panel/src/lib/market/app-format/since.ts` |
| Box: fetcher and store | `market-fetch.ts`, `market-store.ts` |
| "Add to YouEye" redirect site | `sites/my/` (served at `https://my.youeye.me`) |

## The address

A market's address is the folder's URL **with the trailing slash**, for example `https://market.youeye.me/dev/`.
The box fetches `<address>market.json` and every other file relative to the same folder.

- **HTTPS only**, no user name or password, no query and no fragment, no `.` or `..` segments. The box adds a missing
  trailing slash, takes the folder of a URL that ends in `market.json`, and lowercases the host
  (`normalizeMarketAddress`).
- **Public addresses only.** An internal host name (`localhost`, `.local` and similar) or a private literal address
  is refused before anything is fetched. The name is then resolved once per refresh; every address
  it resolves to must be public, the connection is made to that checked address only, and the peer address is
  checked again (the same rules as apps added by URL, `url-app.ts`).
- **No redirects.** Every file must answer `200` at its own URL. A `3xx` is refused ("a market must not redirect").
  Any other status, or an empty body, is a failure.

## Files

```
market.json                    the pointer: the only file that changes
h/index/<sha256>.json          the index of one state of the market
h/apps/<id>/<sha256>.json      one app: its manifest and setup files
h/files/<sha256>.<ext>         icons and screenshots (svg, png, jpg, jpeg, webp, gif)
notices/…                      licence and notice files (published, not read by boxes)
index.html, apps/<id>/, …      the website (not read by boxes)
```

**Rules for paths**

- Every path in every file is relative to the market's folder. A box asks only for `market.json` and for paths of
  the three hashed forms above; it never follows any other path or URL from a market.
- A hashed path carries the SHA-256 of its content: an index path must contain the hash its reference names, a
  bundle path must name the app it belongs to and its hash, and a picture path is its own hash. A path can therefore
  never point at other content, and hashed files never change.

### `market.json` (the pointer)

At most 64 KiB. Example (the official Market's `/` lane):

```json
{"schema":"youeye.market.v1","name":"YouEye Market","publisher":"YouEye","homepage":"https://market.youeye.me",
 "sequence":1795029165,"commit":"95bc8ecd1d8001fa6bd8d82c37bf4aafa02cd40b",
 "index":{"path":"h/index/b9de4bed98ba6c940231364b1c85e2c2dfc79e59cdcd24652d2bd69d8417cdfa.json",
          "sha256":"b9de4bed98ba6c940231364b1c85e2c2dfc79e59cdcd24652d2bd69d8417cdfa","size":23249}}
```

| Field | Rule |
|---|---|
| `schema` | exactly `youeye.market.v1` |
| `name`, `publisher` | 1–120 characters. What the market says about itself: the box shows them as the market's own words and never as its name for the source |
| `homepage` | optional, at most 300 characters; the box links it only when it is a plain `https://` address |
| `sequence` | whole number from 1 to 4,102,444,800 (`MARKET_SEQUENCE_MAX`, the start of the year 2100): the commit time in Unix seconds. See [Rules that keep every box working](#rules-that-keep-every-box-working) |
| `commit` | optional, at most 64 characters: the commit the market was built from (shown on the box) |
| `index` | `{path, sha256, size}`: `path` is `h/index/<sha256>.json` with the same hash; `size` at most 4 MiB |

### The index

At most 4 MiB, schema `youeye.market-index.v1`. It holds everything a box needs to list the market:

| Field | What |
|---|---|
| `categories` | `[{id, label, icon?, order?, tile?: {bg, fg}}]`, from `catalog.yaml` |
| `curation` | `{spotlight?: {title?, apps}, collections?: [{id, label, apps}]}`, from `catalog.yaml` |
| `bundles` | `[{id, definition}]`: the text of each `bundles/<id>/bundle.yaml` (at most 64 KiB each); the box parses it with the bundle parser |
| `apps` | one entry per app, container or native (below) |

Indexes before 0.6.20 also carried `native`, the ids of native apps whose manifests came from the box's channel
index. A native app is an `apps` entry of kind `native` now; a reader ignores the `native` key, and the generator no
longer writes it.

An app entry (`MarketIndexEntrySchema`). Only `id`, `kind` and `name` are required, so an entry of a kind an older
box does not know still parses:

```json
{"id":"bazarr","kind":"container","name":"Bazarr","version":"1.6.2",
 "tagline":"Subtitles for your movies and series, found automatically","description":"Subtitle manager for Sonarr and Radarr",
 "category":"media","tags":["media","subtitles"],"developer":"morpheus65535 and Bazarr contributors",
 "icon":"h/files/b42777ee622ddf85ace15dbe9a70d471a2ca364e745c73ea467da3a0a7586162.svg",
 "requires":{"youeye":">=0.6.9"},"runs_setup":true,
 "bundle":{"path":"h/apps/bazarr/fd84f5513bc737f18ced07a11053bd99421eacf8572509369ee11bfe8078feb4.json",
           "sha256":"fd84f5513bc737f18ced07a11053bd99421eacf8572509369ee11bfe8078feb4","size":6523}}
```

| Field | Rule |
|---|---|
| `id` | `[a-z][a-z0-9-]{0,31}`; an id listed twice keeps its first entry |
| `kind` | `container` (OCI images pinned by digest) or `native` (a Node.js app whose `standalone.tar` the manifest pins by `source.package`; 0.6.20 on). Any other kind, and `native` on a box before 0.6.20, is "Needs a newer YouEye". The kind must be what the manifest is |
| `name` | 1–120 characters |
| `version`, `tagline`, `description`, `category`, `tags`, `developer` | listing text (at most 80, 300, 2,000, 40 characters; 40 tags of 40; 200) |
| `icon` | a picture path `h/files/<sha256>.<ext>` |
| `requires` | `{youeye: ">=X.Y.Z"}`, copied from the manifest. Read here so that a box that is too old never has to parse the manifest |
| `runs_setup` | `true` when the app has setup files (they run inside its containers); shown before a market is added |
| `bundle` | `{path, sha256, size}`: `h/apps/<id>/<sha256>.json` for the same `id`, at most 1 MiB |

### An app bundle

At most 1 MiB. Example (shortened from `wikiless`):

```json
{"manifest":"schema: youeye.app.v1\nid: wikiless\nversion: 2026.11.17\nname: Wikiless\n…",
 "setups":{},
 "files":{"icon.svg":"h/files/8b283107205b0a6f542c7b427299d4e53bcca0737a8c1849ac08c283729831c9.svg",
          "screenshots/wikiless-home.png":"h/files/6c5f0fdab14bc68f4dba4bcbeef193b79ed9395b94b863de0abff4c3c7b0b7cf.png"}}
```

| Field | What |
|---|---|
| `manifest` | the text of `youeye-app.yaml`, unchanged |
| `setups` | the text of each file under `setup/`, by bare file name (`{"install.yaml": "…", "sso.yaml": "…"}`) |
| `files` | the pictures the manifest names (`listing.icon_file`, `listing.screenshots[].path`), mapped to their hashed paths |

The box parses the manifest and setup files strictly with the one app-format parser
([app-manifest.md](app-manifest.md)), exactly as if they came from a folder.

## Limits

| What | Limit |
|---|---|
| `market.json` | 64 KiB |
| index | 4 MiB |
| one app bundle | 1 MiB |
| one picture | 5 MiB |
| one box, per market | 2,000 apps; 500 bundles; 64 MiB of app bundles together; 512 MiB of pictures kept |
| a native app's package (`source.package.size`) | 1 GiB packed, 2 GiB unpacked, 100,000 entries |
| fetch time (headers to last byte) | `market.json` 20 s, index 60 s, bundle 30 s, picture 90 s; 10 s without data ends any of them |
| one refresh (`market.json`, the index and every missing bundle together) | 3 minutes; what it fetched until then is dropped |

A larger `Content-Length` is refused before the body is read, a body without one is cut at the limit, and a market
over a box limit is refused as a whole ("This market is too large").

## Rules that keep every box working

- **Sequence.** A box never accepts a `sequence` lower than the one it last accepted **from the same address**. The
  floor belongs to the address: when a source's address changes (the official Market after a channel change, a
  custom market whose address was edited), the next accept starts a new floor. A market is therefore never rolled
  back by publishing an older state; a rollback reaches boxes only as a new commit (a revert). The same
  `market.json` bytes under a new ETag change nothing.
- **Sequence is a time.** A box refuses a new `market.json` whose `sequence` is more than a day (86,400 s,
  `MARKET_SEQUENCE_AHEAD_SECONDS`) ahead of its own clock, for every market, the official one included: accepted,
  it would be a floor that no honest later state could reach. Only a pointer that would be accepted is judged; a
  stored state is never judged again. A box whose clock is more than a day behind therefore keeps its copy and
  accepts nothing newer until its clock is right. A stored state whose `sequence` is above `MARKET_SEQUENCE_MAX`
  (accepted before the bound existed) no longer reads: the store counts as empty, its floor is gone, and the next
  refresh accepts the market's real state.
- **Readers ignore unknown fields** in `market.json`, the index and its entries. An index entry that does not parse
  at all is skipped with a warning (shown on the sources page and in the log) and never sinks the rest of the index.
- **`market.json` and the index may only grow.** Add fields; never remove, rename or change the meaning of one.
  Manifests change freely behind `requires.youeye` (below).
- **Needs a newer YouEye.** An entry whose `kind` this box does not know, or whose `requires.youeye` is above the
  box's version, is listed with "Needs YouEye X.Y.Z or newer" (or "Needs a newer YouEye" for an unknown kind) and
  cannot be installed; its bundle is never parsed. Install and source switch answer 409
  `{error, code: "requires-newer-youeye", needsYouEye}`. `requires.youeye` compares `X.Y.Z` only, so `0.6.11-dev.1`
  already satisfies `>=0.6.11`.
- **Source ids are the box's.** A market does not name its own id. The official Market is always `official`; a
  custom market gets the id the owner chose or the first free `custom-N`.

## Integrity

HTTPS with normal certificate checks, plus hashes: `market.json` names the index by SHA-256 and size, the index
names every bundle the same way, and every picture path carries its hash. The box checks each file against the
reference that led to it before it keeps it, and checks its stored copy again when it reads it. Nothing is signed;
when signing returns (before the public Release), it signs `market.json`.

## Building a market

The generator turns a catalog repository (a git checkout or a plain export) into a market folder:

```sh
cd control-panel        # tsx and the @/ paths resolve here; node_modules must be installed
node --import tsx scripts/market-build.ts <market-repo> --out <dir> [--commit <sha>] [--sequence <unix seconds>] \
  [--official | --address <https address of this market>] [--require-provenance]
```

- `<dir>` must be missing or empty. In a git checkout `--commit` and `--sequence` default to `HEAD` and its commit
  time (with a warning when the working tree has uncommitted changes: `market.json` then names `HEAD` while the
  files are the working tree). Without `.git` both are required.
- The sequence, given or taken from the commit, must be a whole number from 1 to `MARKET_SEQUENCE_MAX` and at most
  300 s ahead of the building machine's clock: a sequence from the future would hold back every later build.
- `--require-provenance` refuses a repository without `asset-provenance.json` (see Provenance below). The
  official Market is always built with it.
- Exit 0 when the market was built and read back, 1 when the repository has problems (every one is printed and
  nothing is written), 2 for wrong arguments. The summary names the apps, bundles, native apps, pictures, notices,
  pages and the bytes of each part.
- The catalog repository can build itself: `YOUEYE_ROOT=<YouEye checkout> npm run build` (writes `out/`).

**What it reads.** `store.yaml` (`name` and `publisher`, 1–120 characters; optional `homepage`, an `https` URL),
`catalog.yaml` (`youeye.catalog.v1`: `categories`, `curation`; a `native:` list is refused since 0.6.20), `apps/<id>/youeye-app.yaml` with
`setup/*.yaml` and the pictures the listing names, `bundles/<id>/bundle.yaml`, an optional `asset-provenance.json`,
and licence or notice files (names starting with `LICENSE`, `LICENCE`, `COPYING`, `NOTICE`, `NOTICES` or
`ASSET-NOTICES`, see Notices below) at the root and in app folders. Dot files, `.git` and `node_modules` are
skipped; other folders (`drafts/`, `tests/`) are not published. A symbolic link at the root or under `apps/` or
`bundles/` is refused.

**What it checks.**

- Every app with the Control Panel's strict parser, and compiled; every file under `setup/` must be one the app
  names. The `id` equals the folder name. An app is a container app (`image:`, kind `container`) or a native app
  (`source:` with `source.package`: an exact `https` URL without credentials, query or fragment, a 64-hex SHA-256 and
  a size of at most 1 GiB; kind `native`). A native app needs `requires.youeye` of at least 0.6.20 (a since-row of
  `source.package`). The generator does not fetch the package; the publish tool checks every package URL with a HEAD
  request (200 and exactly that size).
- `listing.category` is one of `catalog.yaml`'s categories; every picture the listing names exists, is one of the
  six types, is not empty and is at most 5 MiB.
- Bundles: `id` equals the folder, every member is in the market, every connection joins two members. Curation
  rows name only apps in the market.
- **"Field, since version".** `since.ts` lists every manifest or setup field added after the first released format
  (YouEye 0.6.3), with the YouEye version that first reads it. The generator enforces only rows newer than 0.6.11
  (`OLDEST_MARKET_READER`, the oldest YouEye that reads this format): an app that uses such a field must say
  `requires: { youeye: ">=<that version>" }` or higher, and the error says what to write. Rows at or below 0.6.11
  (all of today's fields) are kept as a record. Variables newer than the format have the same table
  (`VARIABLES_SINCE`; `${app.network_cidr}` needs `>=0.6.15`, enforced). The tables and their rules are in
  [app-manifest.md](app-manifest.md#fields-newer-than-the-format).
- **Provenance**, when the repository has `asset-provenance.json` (the official Market does), and with
  `--require-provenance` also when it has none (then the build is refused): exactly one record per picture under
  `apps/`, with the picture's current `sha256`, an `evidence` of `exact-source`, `project-reference` or
  `local-capture`, an `https` `source` and `notes`.
- Every limit above. Finally the written folder is read back with the format's own readers, the way a box reads it.

**Notices.** Licence and notice files are published as text, so that any host serves them as text and none is
active content on the market's address. Root files go to `notices/<name>`, files of an app folder to
`notices/<id>/<name>`; their bytes are unchanged, at most 1 MiB each. A file name is the stem (`LICENSE`,
`LICENCE`, `COPYING`, `NOTICE`, `NOTICES` or `ASSET-NOTICES`, in any case), any `-word` or `_word` parts, at most
one `.word` part, and an optional `.txt` or `.md`:

- a name that ends in `.txt` or `.md` is published as it is (`LICENSE.txt`, `NOTICE.md`, `LICENSE-MIT.txt`);
- any other name gets `.txt` appended (`LICENSE` → `LICENSE.txt`, `LICENSE-MIT` → `LICENSE-MIT.txt`); a `.word`
  part without `.txt` or `.md` must name a licence (`COPYING.GPLv2` → `COPYING.GPLv2.txt`; GPL, AGPL, LGPL, MPL,
  EPL, EUPL, CDDL, Apache, BSD, MIT, ISC, OFL, CC-…);
- anything else that starts like a notice name (`LICENSE.html`, `NOTICE.svg`, `LICENSE.foo`) is refused, and so are
  two files that would be published under one name.

Each app page of the website links its own.

**Determinism.** The output depends only on the repository's files, `--commit`, `--sequence` and the website
arguments: JSON is written compactly with a trailing newline and keys in a fixed order, lists are sorted, identical
pictures are stored once, and no build time or host path appears anywhere. The same commit builds the same bytes.
A changed app changes only its bundle, the index and `market.json` (plus its pictures and website pages).

**The website.** The same build writes a plain HTML site into the folder: `index.html` (apps by category, with a
search box in the page), `apps/<id>/` (description, screenshots, version, links, notices), `make-your-own-market/`,
`notices/index.html`, `site.css`, `site.js` and self-hosted fonts. Pages load nothing from other hosts. The "Add to
YouEye" button on an app page:

| Argument | Button |
|---|---|
| `--official` | `https://my.youeye.me/app?id=<id>` (the official Market only) |
| `--address <address>` | `https://my.youeye.me/add?market=<address>` (any other market; at most 1,500 characters) |
| neither | no button |

Native apps are listed like any other app, in their category, with their own text, version, requirement and button.

## Hosting a market

Any static HTTPS host works (a web server, object storage, Pages-style hosting). Requirements:

- The address and every file under it answer `200` directly, without a redirect, on a host name with public
  addresses. Check with `curl -sI <address>market.json` (no `Location`, status 200).
- Upload the hashed files before `market.json`, and keep the previous state's hashed files for a while: a box that
  read the old `market.json` a moment earlier still fetches them.
- Publish only forward: a commit whose time is older than the published `sequence` is refused by every box that read
  the newer one.
- Recommended headers: `h/` files `Cache-Control: public, max-age=31536000, immutable`; `market.json` revalidated
  (`max-age=0, must-revalidate`) with an `ETag`. A box sends `If-None-Match` for `market.json`, so a market that
  did not change costs one `304`.

## Adding a market to a box

A custom market is added by the box's owner, never by the market:

- **Market → Sources** (`/market/sources`): enter the address, see what the market says about itself (name,
  publisher, number of apps and how many run setup steps), tick that you trust it, Add.
- **CLI:** `youeye market add <address> --i-trust-this-market [--name <name>]`.
- **An "Add to YouEye" link** (below).

The box reads the market before it adds anything; an address that is not a market adds nothing. Consent, the store
and what follows are in [market.md](market.md#markets-and-consent).

## "Add to YouEye" links

`https://my.youeye.me` is a static page that sends a visitor to their own YouEye. Link forms:

| Link | Opens on the visitor's box |
|---|---|
| `https://my.youeye.me/add?market=<market address>` | `/market/add?market=<address>` |
| `https://my.youeye.me/add?app=<manifest URL>` | `/market/add?app=<URL>` (an app added by URL) |
| `https://my.youeye.me/app?id=<official app id>` | `/market/<id>` |

The page asks once for the address of the visitor's YouEye (its `https` name, for example `my-box.ui.bingo`; not
`youeye.local` and not plain `http`, which do not serve the Market after setup) and keeps it only in that browser.
It never takes the box address from a link and makes no requests. It shows what the link does and the full address,
and goes on only when the visitor clicks "Open my YouEye". A link names exactly one market, app or id; addresses are
`https`, without credentials, control characters, spaces or backslashes, at most 1,500 characters, and are
percent-encoded when forwarded. The home page builds links for market authors and gives the badge HTML
(`https://my.youeye.me/badge.svg`).

**What the box does with `/market/add`.** A link alone never changes anything:

1. A signed-out visitor is sent to sign in once and comes back to the same page with its query: through
   `/settings/api/auth/sso?redirect=<path and query>` on the box's name (where sign-in is YouEye ID), else to
   `/settings/login`. A page that is back from that sign-in within 2 minutes and still signed out shows a "Sign in
   to continue" link instead of sending the visitor again, so a failing sign-in never loops. The sign-in return
   path is at most 2,048 characters; for a longer page address the page says the link is too long to open after
   signing in and offers sign-in without it.
2. The page renders nothing from the link itself. It calls `POST /api/market/add/preview?market=…` (or `?app=…`,
   no body), which needs an admin session with the CSRF token, or the CLI token (a standard user is refused; `GET`
   answers 405, so a page an admin merely visits cannot make the box fetch an address). It checks the parameter:
   exactly one of `market` and `app`, `/market/add?<market|app>=<percent-encoded value>` at most 2,048 characters
   (a longer link could not survive sign-in and is refused with that reason), no control characters, spaces or
   backslashes, `https`, no credentials, and the market address or app URL rules. At most two previews run at once;
   another one is answered 429.
3. The preview reads the market (`market.json` and its index, both checked, 20 s at most) or the app (its manifest
   and setup files) with the same fetchers as everything else, **writes nothing**, and answers the market's own
   name, publisher, `https` homepage, number of apps (`apps`), how many run setup steps and how many are native
   apps (`native`); or the app's id, name, version,
   host, images and setup files; plus `already_added` when the box has it. An official lane (below) is not a
   custom market: the lane the box follows is previewed as its `official` source, the other lane is refused with
   "This is the official YouEye Market; your YouEye already follows it". A bad link is 400; a market or app that
   cannot be read is 502.
4. The owner ticks that they trust it and chooses Add. A market goes through `POST /api/market/source` with
   `acceptRisk: true` (then the sources page opens); an app through `POST /api/market/validate-url` with
   `addToMarket: true` (then its Market page opens, where Install is a separate step). Both are admin calls with the
   CSRF check.

## The official Market

The official Market is built from the catalog repository, **YE-AppMarket** (public copy:
`github.com/YouEye-Platform/Market`), and published at `https://market.youeye.me` with `--official`.

| Branch | Lane (address) | Read by |
|---|---|---|
| `main` | `https://market.youeye.me/` | every box (the default, whatever its release channel) |
| `dev` | `https://market.youeye.me/dev/` | boxes whose owner chose it (`youeye market official-lane dev`): test boxes |
| a test branch | `https://market.youeye.me/test/<name>/` | none: added as a custom market on a test box |

Before 0.6.20 the lane followed the release channel (dev and alpha read `/dev/`). Since then it is the box's own
setting, `lane` on the official entry of `market-sources.json` ([market.md](market.md#where-the-apps-come-from)).

- The two lanes `/` and `/dev/` are never custom markets: adding either, or re-pointing a custom market at either
  (also with a trailing dot after the host name), is refused with "This is the official YouEye Market; your YouEye
  already follows it" before anything is fetched. Test lanes under `/test/` are ordinary markets.
- Any market may offer native apps (YE-142): a test lane's native folders are installed from it like its other
  apps.

- **A push is what goes live.** Publishing builds every lane from its branch head with the generator, assembles one
  site, keeps the hashed files of the state that was live in each lane, deploys the whole site, then reads every lane
  back over HTTPS (pointer, index, every bundle and picture by hash). A lane whose commit time is older than its
  live `sequence` is refused. When `main` was published, its tree is pushed to `YouEye-Platform/Market` as one
  snapshot commit. An internal tool does this after a push (later on a timer).
- `/dev/` and `/test/` answer with `X-Robots-Tag: noindex`; `h/` files are immutable for a year; `market.json`
  and the pages revalidate.
- Changes go to `dev` first, are checked on a dev-channel box, and are merged into `main` when they are right.
  `main` is never moved back to an older commit; a mistake is undone with a new commit.
- Boxes up to 0.6.10 do not read this site: they keep the frozen catalog of their channel index
  ([releases.md](releases.md#the-frozen-market-entry)).
