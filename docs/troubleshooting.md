# Troubleshooting

Commands here run as root on the box (console or SSH). Each fix below is backed by the code path named next to it.
Paths: State is `/var/lib/youeye-state`, Data is `/var/lib/youeye` ([architecture.md](architecture.md)).

## First look

```sh
youeye status                                          # versions, components, update state
youeye doctor                                          # read-only checks, one line each
youeye appliance health --profile=operational --json   # the health gate used by first deployment
youeye update core status                              # installed System release and any update in progress
youeye spine status                                    # seed and selected Spine per slot
```

`youeye doctor [section] [--json] [-v] [--fix]` (`spine/internal/cmd/doctor.go`) works when the Control Panel is
down. Sections:

| Section | Checks |
|---|---|
| `host` | root disk use, memory, swap, ZFS module, kernel headers, IPv4 preference in `gai.conf`, time sync |
| `incus` | Incus answers, `incus-startup.service`, pool `default` healthy, the `incusbr0` bridge, no instance in ERROR |
| `platform` | the five core containers run; `youeye-control`, `youeye-id` and `youeye-ui` services; the saved host IP matches the live one; Caddy admin API; PostgreSQL credentials; bridge token in CP and UI; CP API reachable |
| `apps` | each installed app's readiness (from the CP, or an Incus scan when the CP is down) |
| `network` | the site domain resolves to the host IP on the host and in Pi-hole; Pi-hole resolves upstream names |

`storage`, `backup` and `hardware` report "not implemented". `--fix` only prints a repair plan; it changes nothing.

## Logs

| What | Command |
|---|---|
| Spine | `youeye logs` (= `journalctl -u youeye -n 100 --no-pager`) |
| Control Panel | `youeye logs control`, or `incus exec youeye-control -- journalctl -u youeye-control --no-pager` |
| YouEye ID | `incus exec youeye-control -- journalctl -u youeye-id --no-pager` |
| Dashboard UI | `youeye logs ui` (= `incus exec youeye-ui -- journalctl -u youeye-ui …`) |
| An app | `youeye logs <app-id>` (tries container `<app-id>`, then `app-<app-id>`) |
| First deployment | `journalctl -u youeye-first-deploy --no-pager`; progress in `first-deploy/progress.json` on State |
| System update after reboot | `journalctl -u youeye-core-update --no-pager` |
| Earlier boots | add `-b -1`; the journal is on State, so it survives reboots and image updates |

## The setup page does not load

Until first deployment finishes, ports 80 and 443 show the Preparing page (nftables table
`inet youeye_setup_gate` redirects them to `youeye-setup-page.service` on 47080/47443). If nothing answers at all:
`systemctl status youeye-setup-page youeye-setup-gate`, then `cat /var/lib/youeye-state/first-deploy/progress.json`.
Setup opens only after `first-deploy/complete` exists.

- **`youeye.local` is not found:** use the IP from the console. mDNS doesn't cross guest Wi-Fi, VPNs or routed
  networks, and Windows doesn't answer `.local` on a network marked "Public". On the box: `youeye mdns name` and
  `systemctl status youeye-mdns`.
- **Firefox searches instead of opening it:** type `http://youeye.local` with the `http://`.
- **Certificate warning on HTTPS:** expected until the box CA is trusted. Download it from
  `http://<box IP>/api/setup/ca-cert` (the setup pages link it under "Use a secure connection") and add it to the
  device's trusted roots; Firefox has its own store (Settings → Certificates → Import).

## The installer screen stays black or garbled

Choose **Install YouEye (text mode)** in the GRUB menu (or add `youeye.text=1` to the kernel line). The graphical
installer also falls back to the text installer by itself when its browser fails within 20 s.

## An older installer ISO stops

The ISO installer installs its channel's current release and only when that release's image is the ISO's own
(`bindCoreInstallBundle`), so an ISO from an earlier release stops before it writes anything:

- an ISO up to 0.6.11 (reader 1) stops on a channel whose head is 0.6.13 or later with "release needs a newer
  reader: core release needs reader 2";
- a later ISO whose image is not the head's stops with "selected System does not contain this appliance media; use
  its matching ISO or an exact selection that contains this media".

Download the ISO of the channel's current release ([install.md](install.md#install-from-the-iso)), or install on
Proxmox with `install.sh`, which always runs the installer of the release it installs.

## First deployment stopped

The console shows "Needs attention" and `progress.json` has `"stage": "needs_attention"`.

- systemd retries `youeye boot first-deploy` every 30 s; after 8 failed attempts the script stops
  (`spine/internal/boot/scripts/first-deploy.sh`). `detail` names the stage that failed.
- Network stage: `/var/lib/youeye-state/bootstrap/network-status.json` has a code such as `link_down`,
  `address_unavailable`, `route_unavailable`, `dns_unavailable`, `clock_unusable`, `source_unavailable` or
  `no_adapter` (`spine/internal/boot/scripts/network.sh`). The network check fetches the channel index once.
- Other stages: read `journalctl -u youeye-first-deploy` and `youeye appliance health --profile=operational`.
- To retry after fixing the cause: press **Try again** on the Preparing page, or remove `progress.json` and run
  `systemctl restart youeye-first-deploy`; both start again at attempt 1. Each attempt resumes an interrupted deployment
  rather than starting over.

## SSH: Permission denied (publickey)

SSH is key-only unless password SSH was turned on (Settings → Console access, or at install with a root password);
even then a password works only from the directly connected IPv4 subnet, for admins and (if set) root. On the
console (Ctrl+Alt+F2, sign in as an admin with your YouEye ID password, then `sudo -i`):

```sh
youeye console status                                                  # admins' accounts, root password, password SSH
systemctl status youeye-console-access.service --no-pager
youeye appliance ssh-key list
youeye appliance ssh-key add --key-file /path/to/key.pub              # or --key-file - to read stdin
```

Keys added this way are kept on State and survive reboots and image updates. Do not share
`bootstrap/console-access.json`; it holds password hashes.

## Locked out: the Control Panel is down, or the owner password is lost

- **Control Panel down:** every admin can sign in on the box's screen (Ctrl+Alt+F2) with their YouEye ID password
  and use `sudo`. An admin who signs in with a passkey only sets a separate console password in Settings → Console
  access. A demoted or deleted admin is locked at once.
- **Owner password lost:** boot Recovery, choose "Reset owner password", reboot. The status screen (tty1) shows a
  one-time code (valid 24 hours). Open `https://<box IP address>/settings/reset-owner` (it answers only on the address, not on the name), enter the code and a new password.

## Spine is broken

A selected Spine runs as a **trial** first (`youeye spine install`, or a Spine-only System update). It must become
healthy within 60 s (the API service runs that exact binary, its socket reports the version, Incus answers). If
not, or if the API service starts three times without the trial being confirmed, the slot goes back to its
previous Spine on its own ([spine.md](spine.md)).

If a committed Spine misbehaves:

```sh
youeye spine status     # what each slot runs
youeye spine rollback   # make the slot's previous Spine current
youeye spine use-seed   # clear the slot's selection; the image's own Spine runs
systemctl restart youeye
```

`spine …` commands always run in the seed, so they work even when the selected Spine does not.

## A System update is stuck or failed

The update journal is `core-update/journal.json` on State. `youeye update core status` prints it with the
installed release. Each update has a request ID (`--request`), shown in the journal as `request_id`.

| Situation | Command |
|---|---|
| Interrupted (lost connection, reboot) | `youeye update core resume --request <id>` |
| Failed after the checkpoint (`needs-recovery`) | `youeye update core recover --request <id>` restores the checkpoint and the previous release |
| Staged but not wanted, nothing changed yet | `youeye update core cancel --request <id>` |

- Cancel works only before any service was touched: while only `verify-members` and `stage-host` ran, or when the
  checkpoint preflight refused. After that, use `recover` (`spine/internal/systemupdate/core_journal.go`).
- `youeye update core check` says `"behind": true` when the channel's release is older than the installed one. A box
  never downgrades; it waits for the channel to catch up ([below](#waiting-for-the-channel-to-catch-up)).
- **An update started right after a boot** (a box running 0.6.13 or later) waits for the box to finish starting:
  - Before `verify-members` is launched, the coordinator waits up to 5 minutes for `youeye-control` and `youeye-ui`
    to run. Meanwhile the status API shows the step with `action_state: running`, `stage: admission`,
    `effect_state: not-started`.
  - If they still do not run, the command ends and the request stays `applying` with "The Control Panel and
    dashboard containers (youeye-control, youeye-ui) were not running, so the update has changed nothing; resume
    this request once they run" (`action_state: retryable`). Nothing was launched. `resume` (the panel's "Retry
    update") waits again and continues; `cancel` ends the request. The same holds when the waiting command was
    killed or the box rebooted during the wait.
  - A promotion of the installed build and a no-op request repeat their one health check
    (`authenticated-health`) for up to 3 minutes, because Pi-hole and the Control Panel's server come up after the
    containers. If the box is still not healthy then, the step is left uncertain (`needs-recovery`) as before, and
    `resume` runs the check again.

  Older Spines failed at once with "core container is not running" in `verify-members` and left the request in
  `needs-recovery`: `resume` repeated the error and `recover` answered "no activation checkpoint exists; use staged
  cancellation". Nothing was changed. On such a box, cancel and run the update again once `incus list` shows
  `youeye-control` and `youeye-ui` as `RUNNING`:
  ```sh
  youeye update core cancel --request <id>
  youeye update core check    # then stage and activate with a new request ID, or Update in Settings → System
  ```
- "release host refused or rate-limited the request" means HTTP 403 or 429 from the release host. Clients retry
  with backoff. GitHub allows 60 anonymous API requests per hour per IP, which is why boxes read only the channel
  index and release assets.
- After a reboot, `youeye-core-update.service` continues a retained request by itself (`resume --boot`).
- **A step failed.** Settings → System shows "This step failed: …", the reason (the step's `evidence` from the
  status API) and, while only preparation ran, Cancel. "Resume checks" is not offered for a failed step: a failed
  step is never run again, so resuming only records the same failure. Cancel, then check for updates again; after
  the checkpoint, "Restore previous release" (`recover`). A refused checkpoint preflight is cancelled by Spine
  itself; if that cancellation did not finish (the request stays `cancelling`), Cancel is still offered and finishes
  it.
- **The update stopped at the checkpoint because the box was busy** (a box running 0.6.11 or later; "checkpoint preflight refused
  before any writer was stopped: other app or platform work kept the lifecycle lock busy …"). The checkpoint waits
  up to 60 s for running app, backup or Names work to let go of the lifecycle locks; when it does not, nothing has
  been stopped or captured, and Spine cancels the request by itself: Settings → System shows "The last update was
  cancelled. The installed release is unchanged." with the checkpoint step and this reason. Start the update again
  after a long app operation or Names maintenance has finished. Older Spines failed at once and left the request
  in `needs-recovery`, which only `recover` ended.
- **A step's outcome is uncertain** (`needs-recovery` with a step left `started`, for example after a crash). When
  the step's action recorded an error, the panel shows it next to the step as "Reason: …"; when the action left no
  result (a killed child), nothing is shown. Recover the request.
- **After the update ended.** A rolled-back update shows "The last update was rolled back. The installed release is
  unchanged."; a cancelled one with a failed step shows "The last update was cancelled. The installed release is
  unchanged." Below it come "This step failed: …" and "Reason: …" for the apply step that stopped it
  (`transaction.stopped_step` in the status API). Paths in a reason are shown as "…".
- **`installed cp differs: …` / `installed ui differs: …`** in the evidence of `verify-members` or
  `authenticated-health` (since 0.6.10) is information, not an error: the installed tree held files that were not
  shipped, or a shipped file was changed or missing, and the update went on. `youeye update core observe` lists up
  to 20 of the paths. A tree the update wrote itself is checked strictly; see
  [core-release-contract.md](core-release-contract.md#installed-file-checks).
- **`apply-cp` fails with "CP selection differs from retained transition", and `recover` stops in
  `recovery-health` with "restored CP selection is not the exact previous release"** (a Spine before 0.6.11; the
  phase stays `needs-recovery`, and only `youeye-control` and `youeye-postgres` run). The box once took a build on
  one channel and then the promotion of the same build on another channel as an update (a metadata-only request).
  The older Spine left the build's first document in the Control Panel and refuses it later
  ([core-release-contract.md](core-release-contract.md#the-recorded-selection)). `resume`, `stage` and `activate`
  only print "complete verified service stage required" then: the coordinator's observation of the unfinished
  `apply-cp`. Run `recover` once if it has not run yet (it restores the databases, the files and both services and
  stops in `recovery-health`), write the installed release's document into the Control Panel, and run `recover`
  again:
  ```sh
  youeye update core recover --request <id>
  d=$(youeye update core status | jq -r .installed.manifest_sha256)
  incus file push --uid 0 --gid 0 --mode 0600 /var/lib/youeye-state/core-update/targets/$d.json \
    youeye-control/var/lib/youeye-state/core-selection/core-release.json
  youeye update core recover --request <id>
  ```
  The second `recover` ends with phase `rolled-back`: every container runs again and the box is on the previous
  release, unchanged. Write the file only after the first `recover`: its restore brings the old file back.
  - **Is a box affected?** `incus exec youeye-control -- sha256sum
    /var/lib/youeye-state/core-selection/core-release.json` prints another digest than
    `youeye update core status | jq -r .installed.manifest_sha256`. A box that always followed one channel is not.
  - **Updating an affected box.** The update from 0.6.10 to 0.6.11 or later goes through as it is: `apply-cp` runs
    in the new Spine, which accepts an earlier document of the installed build and replaces it. A box that is on
    0.6.11 or later updates and recovers normally. Only a recovery that runs in a Spine before 0.6.11 from its
    first step (the update failed in `checkpoint` or `apply-spine`, or it was a host update) stops as above; the
    commands above finish it.
- **Failed `youeye-core-*` units** in `systemctl --failed` belong to an update request. Since 0.6.10 they are reset
  when the request is committed, cancelled or rolled back; a request in `needs-recovery` keeps them until then.
  Units left failed by 0.6.9 or older go away at the next reboot.
- **0.6.8 and 0.6.9 only: `verify-members: cp manifest-response-cache: unrecorded-path`** (UI: "Needs attention ·
  Verifying the complete release", "Recorded lifecycle action failed; retain paired checkpoint and prior
  release"). Once a browser has fetched the Control Panel's `/favicon.ico`, Next.js caches that response inside the
  installed payload (`/opt/app/.next/server/route-cache/APP_ROUTE/adb2ea08…/`, the SHA-256 of `/favicon.ico/route`),
  and the payload check of these versions allows only the `manifest.webmanifest` cache entry. The check runs in the
  installed (old) Spine, so no release can lift it; 0.6.10 and later neither write nor refuse such files. Nothing
  was changed; cancel, delete the entry, and start the update again:
  ```sh
  youeye update core cancel --request <id>
  incus exec youeye-control -- rm -rf /opt/app/.next/server/route-cache/APP_ROUTE/adb2ea089a587cf57dd95fa5b11714bc555600b8777692e029801fce568a54ac
  ```
  Start the update at once (`youeye update core check`, then `stage` and `activate`, or Update in a tab that is
  already open): loading a Control Panel page in a browser can write the entry again (a tab that already shows
  the favicon usually doesn't), and the old Spine then refuses once more at `verify-members` or the checkpoint
  preflight. From `apply-cp` on, the steps run in the new Spine, which no longer refuses it.

## Waiting for the channel to catch up

`youeye update core check` answers `"behind": true` with a message such as `channel stable offers 0.6.13; this box
has 0.6.13-dev.7; waiting for it to catch up`, and Settings → System shows that message instead of an update. A
native app or Pointer says "The channel offers <app> <version>; this box has <version>; waiting for the channel to
catch up".

It means the box already runs a newer release than its channel offers. Releases are ordered by line, then by the
build's sequence, never by name ([releases.md](releases.md#ordering-line-then-sequence)), and a box never installs
older files. This happens after a channel switch: a dev box on `0.6.13-dev.7` that switches to stable, where 0.6.13
is the earlier `dev.5` promoted, keeps `0.6.13-dev.7`.

Nothing is wrong and nothing needs doing. The box takes the next release of its channel that is newer than what it
runs (here the next stable line, 0.6.14). Switching back to the channel it came from (`youeye channel set dev`)
offers that channel's later builds again. To get onto the channel's exact release now, reinstall.

## The box does not boot the new image

An image update writes the inactive slot and arms it as a counted trial: three boot attempts
(`BootAttempts` in `spine/internal/systemupdate/manifest.go`). If the new slot does not come up healthy, systemd-boot
returns to the known-good slot. The journal is `system-update/journal.json` on State;
`youeye update system status` shows it.

## Recovery

Recovery is a separate system on its own partition. Pick its entry in the systemd-boot menu, which shows for 3
seconds at power-on (`applianceLoaderConfigScript` in `installer/internal/installer/appliance_commands.go`). Its menu
(`appliance/scripts/youeye-recovery`):

1. Offline diagnostics (`youeye appliance health --profile=recovery`)
2. Disks and boot entries (without the entries' `version` key: for the two System entries it is the image's
   internal identity, which only orders them)
3. / 4. Boot System A or B once (`bootctl set-oneshot`)
5. Repair the systemd-boot files from verified assets
6. Export support evidence to a USB drive labelled `YOUEYE-SUP` or `YOUEYE-SUPPORT`
7. Show a pending reset
8. Reset platform, keep data
9. Factory reset
10. / 11. Reboot or power off
12. Reset owner password (a one-time code on the console at the next boot)
13. and later: extra items an update lists in `recovery/menu.json` on State

The menu of a box installed with 0.6.13 or later has `Installed: YouEye <release version>` under its title: the
committed receipt's version, else the release selected at install with `(installing)`, else no line (Recovery must
work when State is damaged). It never shows an image's build name.

Recovery is never updated, so it reads only slots, file ownership and digests (no schema or format checks), repairs
systemd-boot with `bootctl update` when one is installed (never downgrading it), and queues any well-formed request
kind. Requests are applied on the next boot by `youeye-recovery-apply` (part of the System image, so updates can
add kinds) before normal services start; a kind it doesn't know is recorded as `unsupported` in
`recovery/last-result.json`.

- **Factory reset** removes all containers and platform data (`youeye cleanup --yes`), removes every console
  account, the root password and password SSH, and clears first deployment, so the box deploys again and opens setup
  as new.
- **Reset platform, keep data** (option 8) does not rebuild anything yet. It runs `youeye cleanup --yes --keep-data`
  early in boot, before Incus starts, so the cleanup finds no containers to remove; it then clears first
  deployment, which finds the platform already in place. The request completes and nothing is lost, but the
  containers are not recreated (`appliance/scripts/youeye-recovery-apply`, `spine/internal/cmd/appliance_cleanup.go`).
  A real rebuild that keeps app data is open work.

## Pi-hole or DNS after an IP change

Pi-hole's port-53 listener is bound to the host's LAN IP, and Pi-hole has autostart off. Each start of the Spine
API refreshes that address and then starts Pi-hole (`spine/internal/cmd/hostipcheck.go`). If the host's address
changed and DNS is down, `youeye doctor platform` shows a `.host_ip` mismatch; `systemctl restart youeye` runs the
check again.

## The Control Panel does not answer

`youeye doctor platform` shows which part is down. Restart the service inside its container:

```sh
incus exec youeye-control -- systemctl restart youeye-control   # Control Panel
incus exec youeye-control -- systemctl restart youeye-id        # YouEye ID
incus exec youeye-ui -- systemctl restart youeye-ui             # dashboard
```

`youeye services restart <name>` goes through the Control Panel API, so it does not help when the Control Panel
itself is down.

## The dashboard answers 500 after a reboot

Before 0.6.11, on a box that was installed fresh and has not yet taken an update that replaces the dashboard, the
dashboard's start-up asked the database once. After a reboot its container can start a few seconds before
Postgres answers; the question then failed, and the dashboard answered every request with HTTP 500 until it was
restarted, while `youeye appliance health` and `youeye app list` still showed it running (the Control Panel logs
"UI projection pending" every 20 s). Restart it:

```sh
incus exec youeye-ui -- systemctl restart youeye-ui
```

From 0.6.11 a start-up that already finished its database work asks nothing; a first start waits up to two
minutes for the database and, if it still does not answer, ends the process so that systemd starts it again
(`journalctl` in the container shows "[startup] the database did not answer in time").

## A Market app update is stuck and the System update waits for it

Before 0.6.9, every Market app update stuck after its commit ("Update committed; cleanup requires attention", the app
behind "503 Application maintenance"), and the System update to the fix refused to start while that record was
unfinished (`lifecycle admission rejected before native action launch`). Since 0.6.9 a committed app update no longer
blocks a System update, and the new Control Panel finishes it at its first start. A box still on 0.6.8 or older needs
the new Spine first, then the normal update:

```
youeye spine install /path/to/spine-linux-amd64     # from the target release's assets; trial, rolls back if unhealthy
youeye update core check
```

then `stage` and `activate` as usual. After the update, `youeye app recover <app>` reports the operation complete.

## The Market is empty or stale

The Market lists what the box last accepted from each market (`/var/lib/youeye/markets/<id>/`); it asks each market
at most every 5 minutes, and at once on "Check for updates" or Refresh ([market.md](market.md#the-store-on-the-box)).
To see when each market was last read and why the last attempt failed:

```
youeye market list          # LAST REFRESH per market; failed refreshes follow with their reason
youeye market refresh       # ask every market now; prints commit and date, or the error; exits 1 on a failure
```

Market → Sources shows the same ("Last refreshed …", the error, Refresh now). Common reasons:

- **The box cannot reach the market** (DNS, no internet, the host is down). The Market keeps showing the last
  accepted state; a box that never read a market has nothing to show for it and asks again when the Market is
  opened, at the earliest 30 s after the last failed attempt. Check from the box:
  `curl -sI https://market.youeye.me/market.json` (or the market's address).
- **"The market is still being read; this box keeps reading it in the background"** or **"The market did not
  finish answering within 180 seconds"**: the market answers slowly. A page waits 20 s at most, and one refresh
  may take 3 minutes before it is given up; open the page or Refresh again later.
- **"market.json is dated …, more than a day ahead of this YouEye's clock …"**: either the market published a
  `sequence` from the future, or this box's clock is behind. Check `date` on the box; once the clock is right, the
  next refresh accepts the market. The box keeps its copy meanwhile.
- **"… a market must not redirect"** or **"must point to a public server"**: the address answers with a redirect or
  resolves to a private address. Use the address the files are really served at.
- **"… has sequence N, lower than the M this box accepted from …"**: the market published an older state than the
  box already has; the box keeps its copy. The publisher fixes it with a new commit.
- **"… is not the file its hash names"**: the market's files do not match each other (an interrupted upload, a
  cache serving an old file). The box keeps its copy; the next refresh tries again.
- **The official Market shows the wrong lane:** it follows the box's channel (`youeye channel get`): dev and alpha
  read `/dev/`, beta and stable read `/`. Boxes up to 0.6.10 do not read `market.youeye.me` at all; they keep the
  0.6.4 catalog of their channel until they update YouEye.

## An app says it has no update source

"No update source: the market this app came from is no longer on this box" (`updateBlocked` `source-unavailable`):
the app was installed from a market that was removed or turned off, or from a git source, which 0.6.11 removes
(the sources page and `youeye market list` name the removed ones). The app keeps running; it just gets no updates.
To take updates again: turn the market back on, or add a market that has the app (`youeye market add <address>
--i-trust-this-market`) and choose **Change** on the app's page ("Updates from"), or run
`youeye app source <app> <market id>`. Either records the new market; the installed version stays until the next
update. A market that was removed and added again has a new id, so its apps must be pointed at it this way.
`youeye app check-updates` names every app in this state.

## An app says it needs a newer YouEye

"Needs YouEye X.Y.Z or newer" instead of Install, or "the new version of this app needs a newer YouEye" on an
update (`requires-newer-youeye`): the market's version of the app declares `requires.youeye` above this box, or is
of a kind this YouEye does not know. Nothing is wrong with the box; update YouEye (Settings → System), and the app
installs or the update is offered. An installed app keeps running at its current version meanwhile.

## An app says its market is not accepted, or "setup steps changed"

Apps from a custom market are installed and updated only after the owner accepted it (see
[market.md](market.md#markets-and-consent)). A market whose address was changed must be accepted again; until then
its apps are listed with "Not accepted", and an install or update answers `source-not-accepted`. If you trust it:

```
youeye market list              # the ACCEPTED column says "no"
youeye market accept <id>
```

`source-unavailable` on an install means the market is turned off or gone: turn it on again (Market → Sources), or
name another market or none (the official Market).

"Setup steps changed" (`setup-changed`) on an update of an app added by URL: its new version runs different setup
files inside its containers, and nothing was changed. Read them (the update panel lists them), then update with
`youeye app update <app> --allow-setup` or "Allow and update", only if you trust the publisher.

`source-changed` on an update: the app's source id now points at another market address than the app was installed
from, for example after the market's address was edited or a removed market's id was taken again. The message names
both. Nothing was changed, and the update check offers this app nothing. If you want its updates from the new
address, choose Change on the app's page.

## A box with stopped apps still works hard

Before 0.6.9 the Control Panel read every installed app's manifest from Postgres (`incus exec psql`) twice per
30-second pass, read every app network once per connection, inspected storage and took locks for stopped apps, wrote
the 46 KB `installed-apps.json` for every app on every pass, and never deleted `incus exec` output (about 1.2 GB and
430,000 files a day on a 36-app box). Since 0.6.9: manifests are cached by digest, stopped apps are skipped by the
prober and the watchdog, health is written only on change, exec output is deleted after reading and swept daily by
Spine (files older than a day), the ZFS ARC has a ceiling (when no one set one), a stopped app's network is audited
every 10 minutes instead of every pass, and connections with a stopped side are not refreshed (starting an app
refreshes its connections). To measure: `timeout 60 incus monitor --type=logging | grep -c "Matched trusted
cert"` (Control Panel API requests per minute), `ls /var/lib/incus/containers/youeye-postgres/exec-output | wc -l`.


## A restore failed

`/var/lib/youeye/backups/.restore-status/<operationId>.json` holds the result of a platform restore; the Control
Panel's log (`youeye logs control`) has the details.

- **"Restore refused, nothing on the server was changed: …"**: the restore stopped at a check. The usual reasons:
  the backup was made by a newer release (update the box first), or "Retained `<app>` requires a matching core
  identity or its app archive" (the app was installed or reinstalled after the backup: choose its archive too, or
  remove the app, then restore again).
- **"Restore failed and the previous server state was recovered: …"**: the rollback worked. The box is as it was
  before the restore; the apps that were being replaced were put back from the pre-restore backup.
- **"Restore failed (…); automatic rollback also failed (…)"**: the rollback was tried twice. The second pair of
  brackets holds the rollback's own error (each attempt's, when they differ); `youeye logs control | grep -e
  '\[restore\]' -e 'Server restore'` shows the step each attempt stopped at. No app that was not being restored
  was removed, but the apps that were kept can be stopped with their service integration pending, an app that
  was being replaced can be missing, and the core (settings, routes) can be partly the backup's. In this order:
  1. **Core services.** The watchdog starts them again within a minute of the restore's end. Check `incus list
     youeye-`; restart Caddy once (`incus restart youeye-caddy`) so that it runs on its current data.
  2. **The whole state from before the restore** is a recovery point on the backup drive, made just before the
     restore (the message names it; if the drive could not take it, it names
     `/var/lib/youeye/backups/sets/<id>` instead, encrypted with the same recovery key). Restoring it with the
     core is the complete repair: it puts back the settings, the routes and the apps that were being replaced.
  3. **Or app by app.** For each stopped app, `POST /api/market/credentials/<appId>` with
     `{"action":"reconcile"}` ([app-service-credentials.md](app-service-credentials.md#admin-actions)): it renews
     the app's service access, also when the dashboard holds an older revision than the Control Panel, and starts
     the app if it was running before the restore. An app that is missing: restore it alone from a recovery point.
  4. **Removing an app in this state** (`youeye app remove <id>`) can stop at "Caddy route … still exists" with
     its network left `cleanup_pending`: Caddy was not answering. After step 1 run the same command again; a
     removal continues from where it stopped (`--force` if the app is reported as half removed).
  Before 0.6.13 this state could also come from the watchdog starting Caddy or the dashboard in the middle of a
  restore (log: "[watchdog] youeye-caddy should be running but is Stopped — starting"), and the message was
  "Server restore failed; retained app maintenance requires reconciliation" instead of the real error.
- **Before 0.6.13** a platform restore with apps failed in two ways, and its rollback removed every app:
  "Container maintenance already active for an update target" (step `reconcile-apps`, when any installed app was
  not being restored), and "App `<id>` already owns `yeapp<N>` (…) in active state" when an app was reinstalled.
  The second also stays behind: `/var/lib/youeye/networks/ipam.json` then lists networks for apps that are not
  installed, and installing such an app is refused with the same message. On 0.6.13, restoring the app from a
  backup releases that lease first. A core-only restore was not affected.
- **Before 0.6.13, an app with a `setup/install.yaml` could not be restored** ("`[<app>]` setup/install.yaml
  failed", in the log for Memos "POST /api/users returned HTTP 403"): the restore ran the app's first-run setup
  against its restored data, and the rollback failed the same way. Affected: audiobookshelf,
  calibre-web-automated, gramps-web, immich, jellyfin, kavita, memos, paperless-ngx, qbittorrent, trek, wallabag.
  The failed restore also left `/var/lib/youeye/app-<id>/secrets` and the app's database and role, and an install
  then refuses "App `<id>` has retained data without an active install". On 0.6.13: restore the app from a backup
  (the restore replaces those leftovers; if it fails it removes them).
- **After a restore, YouEye ID sign-in to a restored app fails**, and the restore reported "setup/sso.yaml failed:
  turn YouEye ID sign-in for … off and on again": the app came back, but its sign-in setup could not run (it signs
  in with the generated admin password, shown under the app's credentials; the owner may have changed it in the
  app). Set that password again in the app, then turn "YouEye ID sign-in" off and on in the app's settings.
- **After a server restore before 0.6.13, nobody can sign in to an app that was kept** (YouEye ID answers 401 to
  the app's token request): the restore put back the backup's YouEye ID client, and the app holds a newer secret
  (its client was made again after the backup, for example by an app-only restore). 0.6.13 keeps the box's own
  client through a restore. To repair such an app: turn "YouEye ID sign-in" off and on in its settings (apps with a
  `setup/sso.yaml`), or restore the app alone from a backup (its reinstall makes a new client).
- **An app installed after a core restore stops at "App service integration is pending; reconcile credentials"**,
  `reconcile` answers 409 and removal fails with "App credential publication requires reconciliation" (a restore
  before 0.6.13: the dashboard kept the backup's credential for an app that had been removed since). On 0.6.13,
  `youeye app remove <id>` works for such an app; then install it again.

## One app's record is damaged

A corrupt or wrongly owned `install.json` (`/var/lib/youeye/app-<id>/install.json`, root, mode 0600) or app update
record (`/var/lib/youeye/state/app-updates/operations/<id>_<operation>.json`) raises a critical health issue naming
the app and the file. Since 0.6.9 the other apps keep working: health checks, update checks and app lists skip the
broken app. Anything that must know who owns a container, volume or route (orphan cleanup, route removal, backup,
restore, starting or stopping a container no readable record owns) refuses until the record is fixed, so the broken
app's resources are never mistaken for leftovers. If only the owner or mode changed, set them back; otherwise restore
the app from a backup. An update record written before 0.6.9 (`operations/<operation>.json`) names no app, so a damaged
one still blocks every app update.
