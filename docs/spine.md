# Spine: seed, selection and updates

Spine is the host agent and the `youeye` CLI. An appliance has two kinds of Spine:

- **Seed** — the binary baked into the image at `/usr/local/bin/youeye`. Every boot starts with it.
- **Selected** — a Spine stored on State under `/var/lib/youeye-state/spine/<sha256>/youeye`, chosen per System slot
  in `/var/lib/youeye-state/spine/selection.json` (`youeye.spine-selection.v1`):

  ```json
  {"schema":"youeye.spine-selection.v1","slots":{
    "A":{"current":{"sha256":"…","version":"0.6.12-dev.4","line":"0.6.12","source_tree":"…","described_sha256":"…",
                    "helper_contract":1,"disk_layout":1},
         "previous":{…},"trial":{…, "trial_starts":1}}},
   "updated_at":"…"}
  ```

  An entry is identified by `sha256`: the payload is stored and checked under it, and nothing compares the other
  fields with a running binary. `version` is the name the release gave this Spine (a build name up to 0.6.12),
  else the line; it is never empty, because a Spine up to 0.6.11 in the other slot drops an entry without it.
  `line` and `source_tree` (from 0.6.12) describe the binary for people; `described_sha256` says which binary they
  describe, because an older Spine that replaces an entry keeps keys it does not know, and they are dropped unless
  it equals the entry's `sha256`.

## Launching

`cmd/youeye/main.go` calls `spineselect.MaybeDelegate` before anything else. The seed runs these commands itself:
`appliance prepare`, `spine …`, `version`, `help` and `completion` (`SeedOnly` in
`spine/internal/spineselect/launch.go`). For every other command (the API service, `boot …`, `update …`) it execs
the booted slot's Spine: an unconfirmed **trial** while it
has start attempts left (three API starts), else **current**, else **previous**, else itself. A slot without a
record runs the seed — a fresh install, a factory reset, or the other slot after an A/B rollback finds its own
choice untouched.

A selected Spine is used only if its payload matches its digest, is not group- or world-writable, and declares the
same `disk_layout` and `helper_contract` as the running source supports; otherwise the launcher logs why and falls
back. Nothing else ties Spine to the image: a check that needs a trusted Spine accepts the seed or this slot's
selected Spine. The image itself is tied to the installed release through an image binding on State
(`core-update/image-bindings/<appliance sha256>.json`: the image's `image_version`, `build_id` and `source_tree`), not
through any name ([core-release-contract.md](core-release-contract.md#the-update-transaction)).

## Commands

| Command | Does |
|---|---|
| `youeye spine status` | seed, the Spine the booted slot runs, and both slots' selection |
| `youeye spine install <file> --sha256 <d> --version <v>` | run a binary as a trial; keep it when healthy (`--version` is the name in the selection record, shown and never compared) |
| `youeye spine adopt` | run the installed release's Spine (first deployment calls this) |
| `youeye spine rollback` | make the slot's previous Spine current |
| `youeye spine use-seed` | clear the slot's selection; the seed runs |
| `youeye boot first-deploy\|bless\|setup-gate\|network\|setup-page` | the boot steps (systemd units call these; `setup-page` is Go, the others embedded scripts) |
| `youeye mdns run` / `youeye mdns name` | run Avahi for the LAN adapter (`youeye-mdns.service`) / print the published name |

`youeye version` shows the installed release's version (the release document's `version`; on dev that is the dev
name) and, per part (System image, Spine, Control Panel, UI), the same version or `from <release>` when the part was
reused from an earlier release (the full name on dev, only another line elsewhere). It never shows a build name.
`youeye version --verbose` adds the release's tree and each member's tree and sha256; it shows no image identity
(that is the image build's name). The Spine line says what runs: `0.6.13 (current on State, slot A)`, `(seed in the
image, …)`, or "not the installed release's" with its sha256. The Control Panel line names the installed release
when the container's `version.json` has the member's tree, else "not the installed release's: tree …". The
installed release is the committed receipt's, or before the first commit the installer's selection, shown as
`<version> (installing)`. `youeye status` and the console show the same release version. `youeye spine status`
prints the same `release` line and, for the seed and each selected Spine, its line (`0.6.12`) and sha256; the record
in `selection.json` keeps the stored names (build names up to 0.6.12), which a Spine up to 0.6.11 in the other slot
reads. Messages about a selected Spine (a missing payload, a digest mismatch, an abandoned trial) name it by line and
the start of its sha256. `youeye channel get` prints only the repository and channel. The Spine API has
`GET /api/spine/status` (the same view); `GET /api/version` answers the binary's own `version` (unchanged, a 0.6.11
Spine compares it during a Spine trial), the installed `release` (what callers show and compare) and the binary's
`source_tree`. `GET /api/releases/channel` no longer has `installed_build`.

Other commands people use on a box: `youeye status`, `youeye doctor`, `youeye logs [control|ui|<app>]`,
`youeye channel get|set`, `youeye update core …` (see [core-release-contract.md](core-release-contract.md)),
`youeye appliance health|ssh-key`, `youeye app …` (for example `app install <id> [--source <id>]`,
`app update <id> [--allow-setup]`; see [market.md](market.md)), `youeye market list|add|remove|accept|refresh|search|info`
(markets by address, [market.md](market.md#markets-and-consent); `youeye market source …` and `repo …` no longer
exist) and `youeye backup …`. `youeye --help` lists all of them;
[troubleshooting.md](troubleshooting.md) shows them in use.

## The API

`youeye.service` runs `youeye api serve`. It listens on the Unix socket `/var/run/youeye/youeye.sock`
(`spine/internal/config/defaults.go`), mode 0666 on the host; access is controlled by who gets the socket. Spine
passes it into `youeye-control` with an Incus proxy device, so the Control Panel is its main client
(`control-panel/src/lib/spine/client.ts`). The routes are registered in `spine/internal/api/server.go`; the main
groups are:

| Routes | For |
|---|---|
| `/api/health`, `/api/version`, `/api/status`, `/api/metrics`, `/api/spine/status` | status |
| `/api/config` | the platform config (`/var/lib/youeye/config/youeye.yaml`) |
| `/api/postgres/credentials`, `/api/pihole/credentials`, `/api/control/sso`, `/api/ui/sso` | credentials the Control Panel needs |
| `/api/releases/index`, `/api/releases/channel` | the box's channel index (for native apps and Pointer) and its channel (the Control Panel picks the official Market's lane from it) |
| `/api/appliance/core-update/{status,check,stage,activate,resume,recover,cancel}` | System updates |
| `/api/appliance/remote-access/keys`, `/api/console…` (console access), `/api/appliance/network` | host access and network |
| `/api/backup/*` | backups and restore |

Each start of `api serve` also refreshes Pi-hole's port-53 address and starts Pi-hole
(`spine/internal/cmd/hostipcheck.go`).

**The channel index answer** (`spine/internal/api/releases.go`). `GET /api/releases/index` is answered from a copy
kept for 5 minutes plus 0–10 % jitter. A refresh tries the index addresses in order and sends `If-None-Match` with
the ETag of that address's last good copy; a `304` keeps the copy and counts as a refresh. After a failure the host
is not asked again for 30 s, doubling up to 10 minutes, and meanwhile the last good index is answered; only with no
good copy yet is the answer the error (502 with `code`). Changing the channel starts over. `youeye update core
check` fetches the index separately and unconditionally.

## Host maintenance (API service)

`youeye api serve` runs `internal/cmd/host_maintenance.go` at start and then daily, so it ships with Spine updates:

- **ZFS ARC ceiling:** `zfs_arc_max` = 10 % of RAM, at least 512 MiB, at most 16 GiB (Proxmox VE's rule plus a floor).
  Without it the ARC grows toward all RAM (about 6.9 GiB of 8 GB) and starves containers. Set only while the value
  is ZFS's default 0, so an administrator's own `zfs_arc_max` is kept.
- **Exec output sweep:** deletes `incus exec` output files older than a day (longer than any exec) under
  `/var/lib/incus/containers/*/exec-output/` (running containers; a stopped one's dataset is unmounted). Incus keeps
  them for ever; the Control Panel deletes what it reads since 0.6.9, the sweep removes what older versions left.
- **Incus cached-image refresh off:** `images.auto_update_interval` is `0`. Every app and core image is pinned by
  digest, so Incus's periodic refresh of cached images (by default every 6 hours) only costs registry requests. New
  boxes get it from the Incus preseed (`spine/internal/incus/install.go`); host maintenance sets it on existing
  boxes, retrying up to 10 times 30 s apart because Incus may still be starting. The Debian base of the system
  containers is the local image `youeye-debian-12`, which does not refresh by itself either: it is downloaded and
  checked only when that alias is missing (`EnsureSystemBaseImage` in `spine/internal/incus/images.go`).
- **Old service trees:** removes the `/opt/.youeye-core-<hash>` trees that finished System updates left in
  `youeye-control` and `youeye-ui`, only while no System request is unfinished. Besides the start and daily runs it
  runs once more 15 minutes after start (at boot the containers are not up yet, and a Spine update restarts the
  service in the middle of its own request). Rules in
  [core-release-contract.md](core-release-contract.md#checkpoint-and-recovery).

## Spine-only update (no reboot)

1. The update downloads the release's Spine into the update cache and checks its SHA-256 against
   `core-release.json`.
2. It stages the binary into the store and records it as the slot's trial.
3. It restarts `youeye.service`. The trial is healthy when the service's main process runs exactly that binary (by
   SHA-256), the API socket answers `GET /api/version`, and Incus answers — within 60 seconds. What the binary calls
   itself is not compared.
4. Healthy: the trial becomes current (the old current becomes previous). Not healthy, or three crashed starts:
   the trial is dropped and the service restarts on the previous choice. Recovery of a failed System update also
   returns the slot to its previous Spine.

In a System update this is the `apply-spine` step. Once it succeeded, the process coordinating the update asks the
new Spine whether it can continue the request (`update core status --can-resume --request <id>`, 20 s at most)
and, only when it answers yes for the same journal state, hands it the rest (`update core resume`, same process);
otherwise the installed Spine finishes the request itself
([core-release-contract.md](core-release-contract.md#the-hand-over-after-the-spine-step)). The API service checks
when it starts and then once a minute for a service update whose coordinator was lost between two steps, or that
finished without releasing its holds, and starts its continuation again (same page, "A lost continuation"). The
hand-over decision is written to the system journal of the coordinator's unit.

The selection survives reboots. An image update selects the release's Spine for the slot it writes, so after the
reboot the new slot runs it. That is then the slot's whole record: what it held for the image that was there before
is dropped, the previous Spine included, because an older Spine may not read what the new release writes. If the
release's Spine cannot run, the slot runs the seed of its new image, and `youeye spine rollback` says the slot has
no previous Spine until a Spine update on that slot leaves one.

## Compatibility

`spineselect.DiskLayout` (1) and `spineselect.HelperContract` (1) are compiled into each Spine. Raise
`HelperContract` when the interface between the seed (prepare, launcher, recovery, units) and Spine changes in a
way an older Spine can't follow; such a Spine then needs an image that implements the new contract.

When an image update writes the other slot, Spine selects the target release's Spine for that slot checking only
the disk layout; the helper contract is checked against the target image by that slot's launcher at boot (a
mismatch runs the slot's seed).

## Files on State and Data: readers ignore, writers keep

The seed Spine of every image reads State on every boot, and after a rollback the other slot's (older) Spine reads
what a newer one wrote. So every record on State and Data follows one rule (`internal/jsonkeep`):

- **Readers ignore unknown keys** (`appliance-state.json`, the Data marker `.youeye-data-schema.json`, the host
  journal, `bootstrap/release-policy.json`, `spine/selection.json`, `bootstrap/console-access.json`, the image
  marker and the system-update manifest).
- **Writers keep them:** a rewrite re-reads the file and carries over every key the writer's type doesn't declare,
  at every level the type describes (`jsonkeep.Marshal`). Declared fields always come from the writer, so clearing a
  field still clears it.
- An unknown `lifecycle` value is kept as it is but counts as "not configured" (no check matches it).
- One unreadable `selection.json` slot or entry is skipped (that slot runs its seed); the rest stays usable.
- `schema_version` (State 1, Data 1) is the only compatibility switch: a bump means the format changed
  incompatibly, and images declare the range they accept. Add fields instead of bumping when old readers can
  ignore them.

## Console access

Admins get host accounts so a dead Control Panel never locks the owner out (`internal/consoleaccess`):

- **Record:** `bootstrap/console-access.json` (`youeye.console-access.v1`): one account per YouEye ID admin
  (`user_id`, host `username`, `uid`, own yescrypt `password_hash`, `admin`, `locked`), an optional
  `root_password_hash` (advanced) and `password_ssh`. Spine stores only hashes.
- **Host files:** `youeye console apply` (boot unit `youeye-console-access.service`, and after every change) builds
  `passwd`, `shadow`, `group` and `gshadow` from the image's pristine copies in `/usr/lib/youeye/etc-base` plus the
  admins, writes them to `/run/youeye/console/` and binds them over `/etc`. A newer image's system users therefore
  always arrive; nothing persists `/etc/shadow`. Admins are in `youeye-admins` (gid 2000, sudo), homes are
  `/var/lib/youeye-state/home/<user>`, root stays locked unless a root password is set. Password SSH (opt-in) is
  allowed from the local subnet only, for admins and (if set) root; SSH by key is unchanged.
- **Names:** an admin keeps the host name chosen when the account was created (a YouEye ID rename doesn't move
  it). A name that isn't a valid Linux name or clashes with the image's users becomes `ye-<name>` (`-2`, `-3`…).
- **The Control Panel keeps it current** over the socket: `POST /api/console/accounts/sync` with the full admin set
  after every identity change and at start (a new admin gets a locked account; an admin missing from the set is
  locked at once and its sessions end), `PUT /api/console/accounts/password` when an admin sets a password (sent
  once), `PUT /api/console/settings` (root password, password SSH), `GET /api/console`.
- **Owner reset:** Recovery's "Reset owner password" queues a request; at the next boot `youeye console owner-reset`
  shows a one-time code on the console (valid 24 hours, once; after every 10 wrong tries it pauses 15 minutes; State keeps only its
  digest). The Control Panel's `/settings/reset-owner` page consumes it with `POST /api/console/owner-reset` and sets a new
  owner password.
- **tty2** always runs a login prompt (Ctrl+Alt+F2); tty1 is the status screen.
