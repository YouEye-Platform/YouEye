# Spine: seed, selection and updates

Spine is the host agent and the `youeye` CLI. An appliance has two kinds of Spine:

- **Seed** — the binary baked into the image at `/usr/local/bin/youeye`. Every boot starts with it.
- **Selected** — a Spine stored on State under `/var/lib/youeye-state/spine/<sha256>/youeye`, chosen per System slot
  in `/var/lib/youeye-state/spine/selection.json` (`youeye.spine-selection.v1`):

  ```json
  {"schema":"youeye.spine-selection.v1","slots":{
    "A":{"current":{"sha256":"…","version":"0.6.2-dev.3","helper_contract":1,"disk_layout":1},
         "previous":{…},"trial":{…, "trial_starts":1}}},
   "updated_at":"…"}
  ```

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
selected Spine.

## Commands

| Command | Does |
|---|---|
| `youeye spine status` | seed, the Spine the booted slot runs, and both slots' selection |
| `youeye spine install <file> --sha256 <d> --version <v>` | run a binary as a trial; keep it when healthy |
| `youeye spine adopt` | run the installed release's Spine (first deployment calls this) |
| `youeye spine rollback` | make the slot's previous Spine current |
| `youeye spine use-seed` | clear the slot's selection; the seed runs |
| `youeye boot first-deploy\|bless\|setup-gate\|network` | the boot steps (systemd units call these) |

`youeye version` shows the running Spine and the seed; the Spine API has `GET /api/spine/status`.

Other commands people use on a box: `youeye status`, `youeye doctor`, `youeye logs [control|ui|<app>]`,
`youeye channel get|set`, `youeye update core …` (see [core-release-contract.md](core-release-contract.md)),
`youeye appliance health|ssh-key`, `youeye app …` and `youeye backup …`. `youeye --help` lists all of them;
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
| `/api/releases/index`, `/api/releases/channel` | the box's channel index (for apps, Pointer and the Market) and its channel |
| `/api/appliance/core-update/{status,check,stage,activate,resume,recover,cancel}` | System updates |
| `/api/appliance/remote-access/keys`, `/api/console…` (console access), `/api/appliance/network` | host access and network |
| `/api/backup/*` | backups and restore |

Each start of `api serve` also refreshes Pi-hole's port-53 address and starts Pi-hole
(`spine/internal/cmd/hostipcheck.go`).

## Spine-only update (no reboot)

1. The update downloads the release's Spine into the update cache and checks its SHA-256 against
   `core-release.json`.
2. It stages the binary into the store and records it as the slot's trial.
3. It restarts `youeye.service`. The trial is healthy when the service's main process runs exactly that binary, the
   API socket reports its version, and Incus answers — within 60 seconds.
4. Healthy: the trial becomes current (the old current becomes previous). Not healthy, or three crashed starts:
   the trial is dropped and the service restarts on the previous choice. Recovery of a failed System update also
   returns the slot to its previous Spine.

The selection survives reboots. An image update selects the release's Spine for the slot it writes, so after the
reboot the new slot runs it.

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
