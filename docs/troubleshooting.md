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

Until first deployment finishes, the host drops ports 80 and 443 (nftables table `inet youeye_setup_gate`, from
`youeye boot setup-gate close`). This is expected. Watch the console, or
`cat /var/lib/youeye-state/first-deploy/progress.json`. Setup opens only after `first-deploy/complete` exists.

## First deployment stopped

The console shows "Needs attention" and `progress.json` has `"stage": "needs_attention"`.

- systemd retries `youeye boot first-deploy` every 30 s; after 8 failed attempts the script stops
  (`spine/internal/boot/scripts/first-deploy.sh`). `detail` names the stage that failed.
- Network stage: `/var/lib/youeye-state/bootstrap/network-status.json` has a code such as `link_down`,
  `address_unavailable`, `route_unavailable`, `dns_unavailable`, `clock_unusable`, `source_unavailable` or
  `no_adapter` (`spine/internal/boot/scripts/network.sh`). The network check fetches the channel index once.
- Other stages: read `journalctl -u youeye-first-deploy` and `youeye appliance health --profile=operational`.
- To retry after fixing the cause: the attempt counter lives in `progress.json`. Removing that file and running
  `systemctl restart youeye-first-deploy` starts again at attempt 1. Each attempt resumes an interrupted deployment
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
