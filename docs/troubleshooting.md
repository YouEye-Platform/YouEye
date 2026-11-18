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
- `youeye update core check` says `"behind": true` when the channel's build is older than the installed one. A box
  never downgrades; it waits for the channel to catch up.
- "release host refused or rate-limited the request" means HTTP 403 or 429 from the release host. Clients retry
  with backoff. GitHub allows 60 anonymous API requests per hour per IP, which is why boxes read only the channel
  index and release assets.
- After a reboot, `youeye-core-update.service` continues a retained request by itself (`resume --boot`).
- **A step failed.** Settings → System shows "This step failed: …", the reason (the step's `evidence` from the
  status API) and, while only preparation ran, Cancel. "Resume checks" is not offered for a failed step: a failed
  step is never run again, so resuming only records the same failure. Cancel, then check for updates again; after
  the checkpoint, "Restore previous release" (`recover`). When the checkpoint preflight refused and Spine is already
  `cancelling`, Cancel is still offered and finishes the cancellation.
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
2. Disks and boot entries
3. / 4. Boot System A or B once (`bootctl set-oneshot`)
5. Repair the systemd-boot files from verified assets
6. Export support evidence to a USB drive labelled `YOUEYE-SUP` or `YOUEYE-SUPPORT`
7. Show a pending reset
8. Reset platform, keep data
9. Factory reset
10. / 11. Reboot or power off
12. Reset owner password (a one-time code on the console at the next boot)
13. and later: extra items an update lists in `recovery/menu.json` on State

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

## An app says its source is not accepted, or "setup steps changed"

Since 0.6.10 apps from a custom Market source are installed and updated only after the owner accepted the source
(see [market.md](market.md#other-sources-and-consent)). A source added before 0.6.10 is not accepted yet: its apps
are listed with "Not accepted", and an install or update answers `source-not-accepted`. If you trust the source:

```
youeye market source list              # the ACCEPTED column says "no"
youeye market source accept <id>
```

A source whose address or branch was changed must be accepted again. `source-unavailable` means the source is turned
off or gone: turn it on again (Market → Manage sources), or, for an install, name another source or none (the
official Market).

"Setup steps changed" (`setup-changed`) on an update of an app added by URL: its new version runs different setup
files inside its containers, and nothing was changed. Read them (the update panel lists them), then update with
`youeye app update <app> --allow-setup` or "Allow and update", only if you trust the publisher.

`source-changed` on an update: the app's source id now points at another repository (or branch) than the app was
installed from, for example after the source's address was edited or a removed source's id was taken again. The
message names both. Nothing was changed, and the update check offers this app nothing. If you want its updates from
the new repository, switch the app to that source on its page.

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


## One app's record is damaged

A corrupt or wrongly owned `install.json` (`/var/lib/youeye/app-<id>/install.json`, root, mode 0600) or app update
record (`/var/lib/youeye/state/app-updates/operations/<id>_<operation>.json`) raises a critical health issue naming
the app and the file. Since 0.6.9 the other apps keep working: health checks, update checks and app lists skip the
broken app. Anything that must know who owns a container, volume or route (orphan cleanup, route removal, backup,
restore, starting or stopping a container no readable record owns) refuses until the record is fixed, so the broken
app's resources are never mistaken for leftovers. If only the owner or mode changed, set them back; otherwise restore
the app from a backup. An update record written before 0.6.9 (`operations/<operation>.json`) names no app, so a damaged
one still blocks every app update.
