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
  else the line the binary reports, else the release's line; it is never empty, because a Spine up to 0.6.11 in
  the other slot drops an entry without it.
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
On beta and stable from 0.6.13 on, a part reused from an older line shows the release's version too, without
`from <line>`: their documents hold every file themselves and name no build, so nothing in them says which release
first carried the part (dev and alpha documents name the release that stores the file, `artifact.release`; accepted
in Plan 12). `--verbose` tells a reused part by its tree.
`youeye version --verbose` adds the release's tree and each member's tree and sha256; it shows no image identity
(that is the image build's name, which no screen and no command's normal output shows: `youeye update system
status` and `youeye appliance commit-healthy-slot` name slots only). The Spine line says what runs: `0.6.13 (current on State, slot A)`, `(seed in the
image, …)`, or "not the installed release's" with its sha256. The Control Panel line names the installed release
when the container's `version.json` has the member's tree, else "not the installed release's: tree …". The
installed release is the committed receipt's, or before the first commit the installer's selection, shown as
`<version> (installing)`. `youeye status` and the console show the same release version. `youeye spine status`
prints the same `release` line and, for the seed and each selected Spine, its line (`0.6.12`) and sha256; the record
in `selection.json` keeps the stored names (build names up to 0.6.12), which a Spine up to 0.6.11 in the other slot
reads. Messages about a selected Spine (a missing payload, a digest mismatch, an abandoned trial) name it by line and
the start of its sha256. `youeye channel get` prints only the repository and channel. The Spine API has
`GET /api/spine/status` (the same view); `GET /api/version` answers the binary's own `version` (its line since
0.6.13, its build name before; a 0.6.11 Spine compares it during a Spine trial of 0.6.12), the installed `release`
(what callers show and compare) and the binary's `source_tree`. `GET /api/releases/channel` no longer has `installed_build`.

Other commands people use on a box: `youeye status`, `youeye doctor`, `youeye logs [control|ui|<app>]`,
`youeye channel get|set`, `youeye update core …` (see [core-release-contract.md](core-release-contract.md)),
`youeye appliance health|ssh-key`, `youeye app …` (for example `app install <id> [--source <id>]`,
`app update <id> [--allow-setup]`; see [market.md](market.md)), `youeye market list|add|remove|accept|refresh|search|info`
(markets by address, [market.md](market.md#markets-and-consent); `youeye market source …` and `repo …` no longer
exist) and `youeye backup …`. `youeye --help` lists all of them;
[troubleshooting.md](troubleshooting.md) shows them in use.

The commands that talk to the Control Panel (`spine/internal/controlapi`) give an ordinary request 2 minutes. A
request the Control Panel answers only when its work is done gets 30 minutes: `youeye orphans clean`,
`app remove`, `app start|stop|restart` and `app recover`. Streamed operations (install, update, backup, restore)
bound only the wait for the first answer. When the bound passes, the command says the operation may still be
running, not that the Control Panel is unreachable.

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

**Control Panel restarts** (`spine/internal/api/control_restart.go`). The Control Panel asks for one after setup, a
server restore, a URL change and new YouEye ID clients (`POST /api/control/restart?delay=<s>`; `POST
/api/control/sso` only writes the environment the next start reads). Spine answers `scheduled` at once and, after
the delay, restarts only when the platform is idle. Every Control Panel install, update, uninstall, restore and
setup, and every Spine backup and restore, holds the lifecycle lock in `/var/lib/youeye/state/app-updates` (shared)
while it runs. A request that starts such work takes it first, before it reads a market, a manifest or a release
(`holdPlatformLifecycle` in `control-panel/src/lib/market/update-admission.ts`: catalog, URL and bundle installs, the
source switch, system container rebuilds and a restore, which imports the backup set from the drive before it takes
the backup operation lock; since 0.6.15): an install still loading the catalog on a box whose DNS
was slow used to be restarted under, and the stopping Control Panel then held the CLI unanswered. The other user
operations need no such hold, because nothing slow runs before their lifecycle lock: an app update (Market app or
Pointer), an uninstall, start/stop/restart, an update recovery and a server URL change read only the request and
local state (journal, install record, settings) and then take the lock, and their network reads (market, release,
certificate, Names) happen under it. A platform backup takes that lock once per archive and lets go of it between archives (so a System
update can run between two archives instead of waiting for the whole set); for the whole set, and a restore for its
whole run, the Control Panel holds its backup operation lock `/var/lib/youeye/backups/.operation.flock`.

A restart asked for while app work runs is made when that work ends: the restart setup asks for lands about 1 s after
an app install that was started right after setup ("restarting the Control Panel after 1m12s of app or platform
work"), and an ordinary install asks for none. The restart closes the Control Panel's port for about 0.3 s; since
0.6.18 Caddy rides that out instead of answering 502 (YE-138, `docs/architecture.md`, "Control Panel restarts behind
Caddy").

A Spine archive step (`/api/backup/run`, `/api/backup/restore`) arrives in the middle of such an operation. A System
update asked for meanwhile holds the admission gate exclusively for up to 60 s while it waits for the lifecycle lock
(which the restore holds), then gives up without a reservation; a restart attempt holds the gate for a moment too.
A step that found the gate busy used to be refused, which failed the restore or backup midway. Since 0.6.15 the step
waits instead: it tries again every second for up to 90 s (`AdmitOrdinaryWait`, `OrdinaryAdmissionWait` in
`spine/internal/systemupdate/core_lifecycle.go`), holding no lock between attempts, and stops when the Control
Panel's request ends. Only a busy lock is waited for: a System update, recovery or independent copy that owns the
platform (its reservation) still refuses the step as soon as the reservation is read (it is read once both locks
were got, so while its owner still holds one of them exclusively the step sees a busy lock and keeps trying). A backup set whose next archive is refused that way
(a System update got its reservation between two archives) ends cleanly: the set is marked failed and deleted, so
nothing is left `creating`, no half set lists as a recovery point and nothing goes to the drive; the backup operation
lock is released; a scheduled backup records the reason (`lastError`), no `last_run`, and is tried again 30 minutes
later, or 30 s after the Control Panel restarts (`lib/backup/scheduler.ts`;
`control-panel/tests/backup-set-refused-archive.spec.ts`). The Control Panel waits 150 s for the start of a backup
archive (`ARCHIVE_STEP_TIMEOUT_MS`; the archive is then made in the background and polled). Six steps are
different: Spine does the whole work before it answers. They are the archive restore (`/api/backup/restore`:
verify, decrypt, extract), the volume restore (`/api/backup/apply-volumes`), the Incus prepare and instance import
(`/api/backup/incus/prepare`, `/api/backup/incus/import-instance`) and the drive store and import
(`/api/backup/repository/store`, `/api/backup/repository/import`). Their time grows with the data, and the Control
Panel holds the lifecycle lock and the backup operation lock while it waits.

**Every such step ends** (since 0.6.15; `spine/internal/backup/step.go`). Its commands (`openssl`, `tar`, `cp -a`,
`incus …`, `restic …`) used to run without any limit, so a hung incusd or a drive that stalled under restic kept the
handler, and both locks, until Spine was restarted: no System update was admitted and no backup or restore could
start. Now they run under a context that ends when the Control Panel hangs up (the handler reads the request body
to its end, `stepRequestContext`, or Go's server would not notice) or after 6 hours (`StepCeiling`, one step, the
same length as the longest wait of a Control Panel restart below). The command then gets SIGTERM (restic removes
its repository lock), SIGKILL 30 s later, and if it still has not gone 30 s after that (stuck in the kernel on a
dead drive) the step answers without it. The step fails with "the step was stopped: it ran longer than its time
limit" or "… the request ended". The Control Panel waits 6 h 15 min for these calls (`BACKUP_STEP_TIMEOUT_MS`),
so it gets Spine's answer and always ends too. There is no progress watchdog: the commands print nothing while
they work. A drive command ends after 15 minutes (`lsblk`, `mount`, `sync`, `wipefs` …), and `mkfs` and `umount`,
whose time grows with the drive, after 60 (`mediaLimit`). The 6 hours of a drive store or import start before the
drive is mounted, so the mount counts inside them. What a step undoes after it was stopped has its own limits:
2 minutes per command and 5 minutes for all of one step together (`stepCleanup`), so a step answers at the latest
about 7 minutes after its 6 hours, inside the Control Panel's 15. A failed `mkfs` on a new backup drive
(`/api/backup/media/prepare`) used to leave a partition without a filesystem, which lists as "an existing
non-YouEye filesystem" and could not be prepared again; Spine now wipes the partition and the drive
(`wipefs --all`), so the drive reads as blank, and says so in the error when the wipe failed too. The archive steps
of a backup (`/api/backup/run`, made in the background) have no such limit yet.

What a stopped step leaves is never read as whole by a later run:

- archive restore: the half-decrypted tar is removed; a partly extracted staging directory is cleared by the next
  restore into it, and the caller got an error;
- volume restore: the copies are made beside the live paths and removed on any failure (also the one that was
  being copied, which a failed `cp` used to leave); the context is checked before the renames, and the renames
  (the commit) are then finished regardless;
- Incus prepare: stopping the `incus` client does not stop incusd, so an import may still end there. An image is
  known by the hash of its files and found by the next run; a volume is imported under a one-use name
  (`ye-restore-<16 hex>`) that no run reads and is deleted when incusd answers in time, and the volumes the step
  had already created are deleted the same way. An import that ended in incusd only after that delete leaves its
  one-use volume: the next prepare deletes every custom volume of that name form in the pools it restores into
  before it imports (one restore runs at a time, and nothing else uses the name). A stopped rename may have
  ended in incusd too: when incus had said the final name was free and it is there after the stop, that volume is
  deleted with the others;
- instance import: when incus had said the name was free and the instance is there right after the stop, it is
  deleted (`incus delete -f`). An import that ends in incusd later still leaves the instance; the restore got an
  error, and a later import of that name is refused while it exists ("target instance already exists"), so it is
  never taken for a restored one. "Was free" means incus answered "not found": an incus that merely failed to
  answer is never a reason to delete;
- drive store: a snapshot exists only when `restic backup` ended well, and the drive's catalog
  (`YOUEYE-RECOVERY.json`) lists the set only after `restic check` (and, for a scheduled set, the retention)
  passed; a stopped `forget --prune` is finished by the next one. A restic that was killed outright (power cut,
  no answer to SIGTERM) leaves its repository lock, with which `check` and `prune` refuse to run: before a store
  or an import Spine runs `restic unlock`, which removes only the locks of processes that are gone;
- drive import: restic restores into `.importing-*`, removed on every way out; the set gets its name by one rename.

If Spine stops, its socket closes and the wait ends with an error.

For a Control Panel restart, Spine takes
the lifecycle lock, the admission gate and the backup operation lock exclusively, and checks that no System update
or recovery reservation is present; an independent copy's does not count, as the copy waits for this restart. Until
it can, it tries again every second: an install started just before setup's end finishes first, a backup set is not
cut between two archives (which left it `creating`), and the Control Panel keeps answering meanwhile. While it
restarts it holds the three locks, so new work waits (a backup or restore asked for then finds its lock busy) and runs
in the new process. If the
stop still waits for open requests after 45 s, Spine ends them and starts the service. Requests made while a restart
waits share it. A waiting restart is recorded in `/var/lib/youeye/control/.restart-pending`, so after a Spine restart
the next `api serve` makes it. The record is removed only when the service has been started again (since 0.6.15;
it used to go before the restart, and a restart that failed was lost): a restart that fails (Incus busy, systemd
in the container not up yet, a start that fails after the kill) is tried again, six times with a growing pause (10 s
to 5 minutes), and after that the record stays for the next `api serve`. A restart is only tried while the
`youeye-control` container runs (`incus list`, every 5 s until it does, and again after a failed try): after a boot
the API service starts before the container, and the resumed restart used to spend its six tries, about 5 minutes,
on a container that was not there yet. Waiting for the container counts no failure and takes no lock.

The wait has an end: 6 hours (since 0.6.15). Locks say that something holds them, not that it moves, so a hung
install, a lifecycle directory that cannot be read or a lock file in an unexpected state kept the restart,
and the new address or YouEye ID clients it was asked for, waiting for ever. After 6 hours Spine restarts without
the locks and logs "restarting the Control Panel WITHOUT waiting any longer: …; work that still runs in it is cut
off" (`journalctl -u youeye | grep control-restart`). Six hours is longer than any install and any System update;
It never restarts under two things:

- a System update or recovery that owns the platform (a readable reservation): that restarts the Control Panel
  itself, the Control Panel is closed meanwhile, and it ends by itself;
- a platform backup or restore (the backup operation lock is held). A restore of a large box or a backup to a slow
  drive can run longer than 6 hours, and the first cut of the bound ended them half-way. The lock is a kernel lease
  of the Control Panel's process, so it is held exactly while that process is in a backup or restore. When the
  6 hours end under one, the log says "a platform backup or restore is still running; the Control Panel restart
  … does not cut it off" and the 6 hours start again, so whatever still holds a lock after the backup gets its
  full time and a lifecycle lock that is truly hung is still restarted over. A backup or restore that itself hangs
  (one Spine step cannot any more: it ends after 6 hours, above) keeps the restart waiting: restart the Control Panel's service (`incus exec youeye-control -- systemctl restart
  youeye-control`) or the box, and the waiting restart is made. So that this does not go unseen, from then on
  Spine looks at the lock once an hour and logs "a platform backup or restore is still running; the Control Panel
  restart asked for … ago has waited for it past its longest wait since …" (the 6 hours start again at each such
  look), and `GET /api/control/restart` answers `{"waiting": true, "waiting_since": …, "backup_held_since": …}`.
  The Control Panel's health monitor reads that every 5 minutes and shows the owner the issue "A backup or restore
  has not finished" (a warning, `control-panel.restart.held-by-backup`, `lib/health/control-restart-held.ts`)
  until the restart is made or the lock is free.

A restart of Spine starts the 6 hours again.

Each start of `api serve` also refreshes Pi-hole's port-53 address and starts Pi-hole
(`spine/internal/cmd/hostipcheck.go`). The same check keeps the Control Panel's raw proxy device (`port3000` on
`youeye-control`, `127.0.0.1:3000` on the host, which the CLI uses) localhost-only: it reads the device and changes
it only when it differs (`RepairControlPanelPortProxy`, `spine/internal/container/control.go`). Until 0.6.14 it
removed and added the device at every start and in every steady-state repair, which cut every connection through
it (the CLI's event streams ended with "unexpected EOF"). While a System update or recovery holds the platform the
check waits and logs "[host-ip-check] waiting: System update or recovery owns the platform lifecycle; checking
again in …" (it was logged as `ERROR`). The UI's egress block (network ACL `ye-ui-egress-block` on `youeye-ui`,
which keeps the UI from calling the Control Panel) is handled the same way: `EnforceUIEgressBlock`
(`spine/internal/container/ui.go`) verifies it and recreates it only when it differs. Until 0.6.14 every start
detached, deleted and recreated it, and the UI had no block in between.

**The channel index answer** (`spine/internal/api/releases.go`). `GET /api/releases/index` is answered from a copy
kept for 5 minutes plus 0–10 % jitter (`releasecache.NextChannelIndexCheck`). A refresh goes through
`releasecache.FetchChannelIndex`, which tries the index addresses in order and sends `If-None-Match` with the ETag
of that address's last good copy in this process; a `304` answers the copy and counts as a refresh. After a failure
the host is not asked again for 30 s, doubling up to 10 minutes, and meanwhile the last good index is answered;
only with no good copy yet is the answer the error (502 with `code`). Changing the channel starts over. The update
check (`youeye update core check`, `ChooseCoreRelease`) reads the index through the same conditional fetch, without
the 5-minute copy.

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

A Spine up to 0.6.11 kept the previous entry when it selected a Spine for an image update, so the slot holding the
0.6.12 image can still name a 0.6.11 Spine as previous. That Spine reads release documents up to reader 1. So before
an image update to a release that needs reader 2 is committed (`commit-host`), the slot the update was staged from
loses its previous and trial entries that no Spine from 0.6.12 on wrote: those without their own
`described_sha256` (`spineselect.DropUndescribedFallbacks`). Its current entry stays, and behind it the slot runs
the seed of its own image, which reads the release (the update was staged there by a release at or after the
target's `minimum_release`, on that release's image). A slot still holding an older image is never the one this
names: it is the slot the update wrote over.

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
