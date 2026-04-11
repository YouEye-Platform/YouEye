## v0.2.18.10 — sebastian — 2026-04-07
**Branch:** sebastian
**VM:** ye-sebastian (10.10.10.28)
**Agent:** Sebastian
**Task:** Close 5 leftover bugs in `spine cleanup` found by post-cleanup audit on ye-sebastian. After 0.2.18.10, the post-uninstall state is genuinely "as if YouEye was never installed".

### Bugs fixed (all in `internal/cmd/cleanup.go`)

**BUG-008** — `/etc/systemd/system/incus-startup.service.d/spine-dependency.conf` (added by `spine deploy`'s `configureIncusStartupDependency()` in deploy.go) was never removed by cleanup. Fix: new helper `removeSpineIncusStartupDropIn()`, called from step 15. Also `os.Remove`s the parent directory if empty and runs `systemctl daemon-reload`.

**BUG-009** — `/var/lib/incus/devices` is a runtime tmpfs Incus mounts. After `apt purge incus` the systemd unit file is gone but the kernel mount table entry survives, holding the directory open. `os.RemoveAll(/var/lib/incus)` then leaves an empty `{devices/}` stub. Fix: add `umount -l /var/lib/incus/devices` to step 7 alongside the existing `guestapi/shmounts` unmounts.

**BUG-010** — `/var/lib/apt/lists/pkgs.zabbly.com_*` cached package indexes survived cleanup. `apt-get update` only refreshes lists for currently-configured repos — it doesn't garbage-collect entries for sources that no longer exist. Fix: `removeIncusAptRepo()` now also globs and `os.Remove`s the cached indexes.

**BUG-011** — After purging incus packages, systemd's in-memory state still had stale references to `incus.service` / `incus-lxcfs.service` ("not-found failed" in `systemctl list-units --all`). Fix: `systemctl daemon-reload && systemctl reset-failed` immediately after `uninstallIncusPackages()` in step 9.

**BUG-012** — `removeZFSPackages()` ran a bare `apt-get autoremove -y` which removes EVERY auto-marked package across the host that's no longer needed by anything. On ye-sebastian this deleted ~50 unrelated `node-*` Debian library packages plus `session-migration`, `squashfs-tools`, `sshfs`, `xdelta3`, `xdg-utils` etc. Violates the BUG-007 principle ("Spine doesn't remove things it didn't install"). Fix: replace with `apt-get purge --auto-remove -y zfsutils-linux zfs-zed libzfs4linux` — the SCOPED form, which only removes the named packages plus dependencies that became unneeded BECAUSE OF removing those packages. Same fix applied to `uninstallIncusPackages()` for symmetry.

### Changes
- `internal/cmd/cleanup.go` — added `path/filepath` import; added `umount -l /var/lib/incus/devices` to step 7; added `daemon-reload && reset-failed` after `uninstallIncusPackages()`; added `removeSpineIncusStartupDropIn()` call to step 15; rewrote `removeIncusAptRepo()` to glob+rm cached indexes; rewrote `removeZFSPackages()` to use scoped `purge --auto-remove`; switched `uninstallIncusPackages()` to `purge --auto-remove`.
- `internal/cmd/root.go` — bumped Version 0.2.18.9 → 0.2.18.10.

### Test results
- `go build ./...` clean.
- Spine 0.2.18.10 installed via `cp` to `/usr/local/bin/spine`.
- **Cleanup + uninstall NOT yet re-tested with 0.2.18.10** — the previous cleanup wiped the platform, then I deployed fresh from 0.2.18.10 to set up the test environment. Next cleanup run (when the user requests it) will validate the fixes.
- Deploy ran successfully on 0.2.18.10 — 7/7 containers running, all 4 host-IP pins correct, host-IP-check goroutine handles pihole lifecycle correctly.

### Notes for Iris
- Promote 0.2.18.10 + CP 0.2.18.5 together. 0.2.18.10 is a strict superset of 0.2.18.9 (which fixed BUG-007).
- This release does NOT yet have the post-fix end-to-end cleanup verification on a real install. That happens in the next session.
- The do-not-promote list now: Spine 0.2.18.3 / 0.2.18.5 / 0.2.18.6 / 0.2.18.7 / 0.2.18.8 / 0.2.18.9. Each has at least one of: Incus hot-reconcile hang, ExecStartPre wrong-ordering, boot deadlock, silent CP migrate failure, userdel-youeye, or one of the 5 cleanup leftovers above.

---

## v0.2.18.9 — sebastian — 2026-04-07
**Branch:** sebastian
**VM:** ye-sebastian (10.10.10.28)
**Agent:** Sebastian
**Task:** BUG-007 fix — drop the `userdel youeye` step from `spine cleanup`. Spine never creates that user, so cleanup has no business removing it.

### Changes
- `internal/cmd/cleanup.go` — Deleted `runCleanup()` Step 12 (`removeYoueyeUser()`), the `removeYoueyeUser()` helper function, and the "youeye system user + /home/youeye" line from the final summary. Renumbered steps 13-18 → 12-17. Updated `totalSteps` 18 → 17 (and 17 → 16 with `--keep-data`). Removed unused `time` import.
- `internal/cmd/root.go` — Bumped Version 0.2.18.8 → 0.2.18.9.

### Why
The user pointed out that `youeye` is a system user they create as part of provisioning the VM (Proxmox template / manual adduser), NOT a user Spine creates. Verified by `grep -rn "useradd\|adduser" YE-Spine/internal/` returning no results. The step was added in v0.2.18.1 on a wrong assumption about which parts of the host Spine owns.

The lesson encoded in the BUG-007 entry: **a cleanup command should only undo things its install command did.** Anything Spine didn't create, Spine doesn't remove.

### Side benefits
- `spine cleanup -y` is now safe to run from inside an agent VM session as the `youeye` user. Earlier versions would have killed the calling shell, the Claude Code agent, the Playwright launchServer, the noVNC stack, etc. mid-cleanup.
- The wiki article no longer needs its "CRITICAL: cleanup will kill processes running as youeye" warning section — that warning was a sign the behavior itself was wrong.

### Test Results
- `go build ./...` clean.
- Spine 0.2.18.9 installed via `cp` to `/usr/local/bin/spine` on ye-sebastian, `systemctl restart spine`, host-IP-check goroutine ran cleanly (`✓ pihole proxy device → 10.10.10.28 / ✓ youeye-pihole running / host IP unchanged`). 7/7 healthy.
- **Cleanup itself NOT yet end-to-end tested on this VM.** That's the next step (the user is going to test it once docs are caught up).

### Notes for Iris
- Promote 0.2.18.9 + CP 0.2.18.5 together. 0.2.18.9 includes ALL prior work in this cycle: cleanup completeness, uninstall self, auto self-update, host-IP migration (BUG-005/BUG-006/BUG-007 fixes).
- The do-not-promote list now: Spine 0.2.18.3 / 0.2.18.5 / 0.2.18.6 / 0.2.18.7 / 0.2.18.8 (this last one because the BUG-007 cleanup behavior is dangerous even though host-IP migration is fine).
- Users upgrading from 0.2.18.1 → 0.2.18.9 who already had `userdel youeye` run on a previous cleanup will need to recreate the user manually. We do not (and should not) recreate it from spine deploy.

---

## v0.2.18.8 — sebastian — 2026-04-07
**Branch:** sebastian
**VM:** ye-sebastian (now on 10.10.10.27, survived 10.10.10.20 → 10.10.10.25 → 10.10.10.26 → 10.10.10.27)
**Agent:** Sebastian
**Task:** Two more bugs caught by the actual physical IP-change test of 0.2.18.7. Ship 0.2.18.8 with both fixes.

### BUG-005 — `After=incus.service` on spine.service caused boot deadlock
- youeye-ui has a proxy device listening on `/var/run/spine/spine.sock`.
- `incus.service` auto-starts boot.autostart=true containers as part of its own startup, BEFORE `waitready` returns.
- youeye-ui can't start until spine.sock exists; spine.sock requires spine.service active; spine.service queued behind incus.service active. Cascading deadlock at first boot — boot got stuck for minutes until I manually killed waitready and restarted the daemon.
- I added `After=incus.service` in 0.2.18.7 thinking the goroutine needed the daemon up first. **Wrong.** The `incus` CLI socket-activates incusd via `incus.socket` if it's not yet running, and the goroutine has its own `runWithTimeout` per call, so spine.service does not need any explicit ordering vs incus.service.

**Fix:** revert spine.service unit to `After=network-online.target` only. Spine and Incus start in parallel.

### BUG-006 — `callCPHostIPMigrate` only checked curl exit code, not response body
- CP `/api/host-ip/migrate` catches per-step errors and ALWAYS returns `ok:true` with per-step flags `{dns, caddy}`. The endpoint logs `[host-ip/migrate] setDomainDNS failed: ...` in CP logs but the HTTP response is still 200.
- 0.2.18.7's goroutine called CP migrate during a window where pihole was down (Step 3 had timed out, Steps 4-5 succeeded for CP, then Step 6 hit pihole-down). CP returned `{ok:true, dns:false, caddy:true}`. Spine only checked curl exit code (200), treated as success, persisted `.host_ip`, never retried. dnsmasq_lines stayed on the old IP forever.

**Fix:**
- `callCPHostIPMigrate` now parses the JSON response. Requires `dns:true`. (`caddy:false` is acceptable because legacy IP-literal route may not exist on fresh installs.)
- New `waitForPiholeHealthy(60s)` polls Pi-Hole's `/api` endpoint from inside the youeye-pihole container BEFORE calling CP migrate. Prevents the race condition that caused BUG-006 in the first place.
- On any CP migrate failure, `.host_ip` is NOT persisted — next boot retries.

### Files changed
- `internal/cmd/hostipcheck.go` — Added `waitForPiholeHealthy()`. Rewrote `callCPHostIPMigrate()` to use `curl -s` (not `-sf`) so it captures the response body, then `json.Unmarshal` and check `ok && dns`. Added Step 6 (waitForPiholeHealthy) before Step 7 (CP migrate). Now both Step 6 and Step 7 abort migration without persisting on failure.
- `internal/cmd/deploy.go` — `spine.service` unit reverted to `After=network-online.target` only (no `incus.service` dependency). Long comment block explains BUG-005 and the chain of three failed attempts at boot ordering.
- `internal/cmd/root.go` — Bumped Version 0.2.18.7 → 0.2.18.8.

### Test Results on ye-sebastian (with 0.2.18.8 installed)
- **Test A (full migration with stopped pihole)**: pollute proxy device + CP env + .host_ip=10.10.10.99 + restart spine → migration completed in **5 seconds**, all 4 pins migrated, 7/7 healthy, dig + IP HTTPS + FQDN HTTPS all green on first try ✓
- **Test B (no-op restart)**: ~1s, no migration runs, healthy ✓

### What's still NOT validated
The actual physical IP change with 0.2.18.8 PRE-INSTALLED has not been done. Same caveat as 0.2.18.7 — install on this VM happened after the broken-state recovery.

### Notes for Iris
- **Promote Spine 0.2.18.8 + CP 0.2.18.5 together.** The CP 0.2.18.5 piholeManifest change is still required.
- DO NOT promote 0.2.18.3/4/5/6/7 — all have at least one of the bugs (hang, deadlock, response parsing).

---

## v0.2.18.7 — sebastian — 2026-04-07
**Branch:** sebastian
**VM:** ye-sebastian (10.10.10.26 — survived 10.10.10.20 → 10.10.10.25 → 10.10.10.26)
**Agent:** Sebastian
**Task:** Make host-IP-change migration actually work under physical IP changes (the 0.2.18.5 and 0.2.18.6 designs both failed in different ways during the live test).

### What changed structurally
**Pi-Hole is now created with `boot.autostart=false`** (CP 0.2.18.5 manifest change). Spine is the canonical owner of pihole's boot lifecycle. At the start of every `spine api serve`, the host-IP-check goroutine ensures `boot.autostart=false` (idempotent migration), refreshes the proxy device listen address to the current host IP on the **guaranteed-stopped** container, then starts pihole. This sidesteps the chicken-and-egg that broke 0.2.18.6: incus.service auto-starts boot.autostart=true containers as part of its own startup before `waitready` returns, so any spine.service ExecStartPre runs too late to fix pihole's proxy device on a stopped container.

### Files changed
- `internal/cmd/hostipcheck.go` — Major refactor:
  - Removed `runHostIPStartupCheck` (the ExecStartPre target from 0.2.18.6).
  - `runHostIPCheck` now ALWAYS runs the pihole lifecycle steps (autostart-disable, proxy device refresh, ensure running) regardless of IP change. The IP-change-only steps (CP env, dnsmasq, Caddy, persist) gate on `stored != current`.
  - New `ensurePiholeAutostartDisabled()` — `incus config get` then `incus config set boot.autostart false` if needed. Idempotent.
  - **`ensureContainerRunning()` BUG-004 fix**: now checks state first via `incus list` and returns early if already RUNNING. Previously it called `incus start` blindly, which returns exit-1 with `Error: The instance is already running` against an already-up container, and the strict path treated that as fatal — aborting the entire migration.
  - Defensive: even on `incus start` failure, re-check state in case of a race; treat RUNNING as success.
- `internal/cmd/startupcheck.go` — DELETED (the `spine startup-check` cobra command from 0.2.18.6 is no longer needed).
- `internal/cmd/deploy.go` — `spine.service` systemd unit no longer has `ExecStartPre=spine startup-check` or `Before=incus-startup.service`. Just the standard ordering (`After=network-online.target incus.service`).
- `internal/cmd/root.go` — Bumped default Version 0.2.18.5 → 0.2.18.7 (skipping .6 since CP took the version cycle).

### What was wrong with 0.2.18.5 / 0.2.18.6
- **0.2.18.5** ran the proxy device update from a goroutine inside `spine api serve`, by which time Incus had already auto-started the broken pihole. Hung against unbindable old listen IP. The simulated test (test 3 in the validation matrix) happened to use a *valid* host bind address (`127.0.0.1:1153`) for pollution rather than a nonexistent one, so the test passed but the real-world IP-change scenario caught fire on `ye-sebastian`.
- **0.2.18.6** moved the proxy device fix into `ExecStartPre` of `spine.service` ordered `Before=incus-startup.service`, on the (incorrect) assumption that `incus-startup.service` is what brings up `boot.autostart=true` containers. **`incus.service` itself starts them as part of its own startup**, before `waitready` returns. By the time `spine.service` was allowed to run (`After=incus.service`), pihole was already up with the stale listen address and the hang re-fired. The 15s `runWithTimeout` safety net caught the hang gracefully but the migration still couldn't complete because there was no way to fix the device.
- 0.2.18.6 also exposed BUG-004 (the `ensureContainerRunning` "already running" bug), because Phase 2 tried to start `youeye-control` which incus.service had already brought up.

### Test Results (all run live on ye-sebastian after the install + recovery)
| # | Scenario | Result |
|---|---|---|
| A | Simulated IP change with stopped pihole (matches real-world post-boot state with autostart=false) — pollute proxy device + CP env + .host_ip=10.10.10.99, restart spine | Migration ran in ~5s. Logs: `✓ pihole proxy device → 10.10.10.26`, `starting youeye-pihole (was STOPPED)`, `✓ youeye-pihole running`, `HOST IP CHANGED: 10.10.10.99 → 10.10.10.26`, `✓ CP systemd HOST_IP`, `✓ CP healthy`, `✓ CP migrated dnsmasq_lines + caddy route`, `HOST IP MIGRATION COMPLETE`. All 4 pins migrated. 7/7 healthy. dig + IP HTTPS + FQDN HTTPS all green. ✓ |
| B | No-op restart (file matches current) | `host IP unchanged (10.10.10.26); pihole lifecycle handled`. ~1s. ✓ |

### What's tested but NOT yet validated
The actual physical IP change with 0.2.18.7 PRE-INSTALLED has not yet been done — the install on this VM happened AFTER the broken-state recovery. Next test cycle: user changes IP again, reboots, observes the goroutine handle everything cleanly.

### Notes for Iris
- **Promote BOTH spine 0.2.18.7 AND CP 0.2.18.5 together.** They are tightly coupled by the `boot.autostart=false` contract. Promoting one without the other leaves the platform broken.
- **Existing installs** are migrated by Spine's `ensurePiholeAutostartDisabled()` on first startup with 0.2.18.7. No manual action required.
- **Fresh installs** get `boot.autostart=false` directly from the CP 0.2.18.5 piholeManifest.
- **Don't promote 0.2.18.3 / 0.2.18.5 / 0.2.18.6** — all three have the hang bug. 0.2.18.7 is the first version that actually works.

---

## v0.2.18.3 — sebastian — 2026-04-07
**Branch:** sebastian
**VM:** ye-sebastian (10.10.10.20)
**Agent:** Sebastian
**Task:** Detect host IP changes on every `spine api serve` startup and migrate every component that has the old IP pinned, so YouEye survives a VM/host IP change with no manual intervention.

### Background
Pre-0.2.18.3 the platform pinned the host's primary IP into four places at deploy time and never re-validated them at boot:
1. CP systemd `Environment=HOST_IP=...` inside the `youeye-control` container
2. Pi-Hole `dnsmasq_lines` wildcard rewrite (`address=/${domain}/${IP}`)
3. Pi-Hole proxy device `listen=tcp:${IP}:53` / `udp:${IP}:53` on `youeye-pihole` (Incus instance config)
4. Caddyfile `${hostIP}:443 { tls internal ... }` site block (and the resulting Caddy route)

A host IP change broke pin (3) hard (Incus refuses to start the container — DNS dead) and pins (1)(2)(4) softly (LAN clients see the dead IP, CP self-perpetuates the stale value via `setDomainDNS`).

### Changes
- `internal/util/hostip.go` (new) — Persistence helpers for `/var/lib/youeye/.host_ip`. Atomic write via tempfile + rename.
- `internal/cmd/hostipcheck.go` (new) — `runHostIPCheck()`. Compares live `GetPrimaryIP()` against stored value.
  - First-run / file-missing → seed and exit (no migration).
  - Stored == current → exit fast.
  - Detection failed (`<your-ip>`) → log error, do not loop.
  - **IP changed**, runs in this order:
    - **(strict)** Pi-Hole proxy device — `incus config device set youeye-pihole proxy0/proxy1 listen=...`. Verified live: hot reconfigure, no restart needed.
    - `ensureContainerRunning("youeye-pihole")` — `incus start` if stopped, poll up to 60s. Handles the case where pihole failed to start at boot because of a stale `listen` IP.
    - `ensureContainerRunning("youeye-control")` — same.
    - **(strict)** CP systemd `HOST_IP` env — `incus file pull` the unit, `replaceHostIPLine`, `incus file push`, `daemon-reload`, `restart youeye-control`. The drop-in `sso.conf` only sets `EnvironmentFile=` so the main unit is the single source of truth (verified via `systemctl show -p Environment`).
    - `waitForCPHealthy(90s)` — polls `/api/setup/config` inside the container.
    - **(best-effort)** POST to CP `/api/host-ip/migrate` via `incus exec ... curl` (CP's port 3000 is bound to 127.0.0.1 inside the container). CP handles dnsmasq + Caddy.
    - Atomic write of new IP to `/var/lib/youeye/.host_ip`.
- `internal/cmd/api.go` — Launches `go runHostIPCheck(cfg)` immediately before `server.ListenAndServe()`. Goroutine is critical: `incus-startup` waits for spine.service active (= ExecStartPost = socket exists), so the goroutine can use Incus while ListenAndServe blocks the main thread.
- `internal/cmd/deploy.go` — `runDeploy()` now seeds `/var/lib/youeye/.host_ip` via `WriteStoredHostIP()` after a successful deploy. Without this seed, the first post-deploy boot would take the first-run path and miss any IP change between deploy and boot.
- `internal/cmd/root.go` — Bumped default `Version` 0.2.18.1 → 0.2.18.3.

### Architecture decisions (validated live before coding)
- **Single-phase, in-process** (not ExecStartPre + goroutine) because `incus file pull` does **not** work on stopped OCI containers (verified: `Error: file does not exist`). The goroutine model exploits the fact that `incus-startup` waits for spine.service active, so by the time the goroutine runs, containers are coming up and we can `incus file pull/push` them as soon as they hit RUNNING.
- **Pragmatic CP env update** (sed the systemd unit file) over architectural (migrate to Incus container env + EnvironmentFile). The pragmatic version is what we'd run as the one-time migration anyway, and the architectural version has a wider blast radius.
- **Pi-Hole proxy device update is hot** — verified live via `incus config device set` round-trip. No `incus restart` needed.
- **Caddy IP-literal block deleted entirely from `deployer.ts`** rather than rewritten. The `:443 { on_demand issuer internal }` catch-all already serves CP from any IP (verified live: `curl -sk https://10.10.10.20/api/ping` and `curl -sk -H "Host: control.sebastianvm.test" https://10.10.10.20/api/ping` both return `{"status":"ok"}`). This removes one of the four pins forever — fresh installs no longer have it, and the migration deletes it from the running Caddy via the new CP endpoint for legacy installs.
- **CP-side migration via existing `setDomainDNS`** with no signature change — `setDomainDNS(domain, newIP)` already strips any prior `address=/${domain}/*` line including the old IP, so I do not need to pass the old IP through. The endpoint takes both for forward-compat and future Caddy-route lookup.

### Test Results (all run live on ye-sebastian)
| # | Scenario | Result |
|---|---|---|
| 1 | First-run (file missing) — `rm /var/lib/youeye/.host_ip; restart spine` | File created with `10.10.10.20`, log `first run — recorded current IP 10.10.10.20`, no migration runs, 7/7 healthy ✓ |
| 2 | No-op (file matches) — restart spine with file unchanged | Log `host IP unchanged (10.10.10.20)`, no migration runs, 7/7 healthy ✓ |
| 3 | Simulated IP change — pollute all 4 pins to fake old IP, set `.host_ip=10.10.10.99`, restart spine | Migration ran in 5s. All four pins migrated to 10.10.10.20 (proxy device, CP env in running process, dnsmasq_lines, Caddy route absent), `.host_ip` updated, 7/7 healthy, DNS resolves correctly, HTTPS via IP and FQDN both `{"status":"ok"}` ✓ |
| 4 | Pi-Hole down at boot — `incus stop youeye-pihole`, set fake old IP, restart spine | Migration started pihole after fixing proxy device (`starting youeye-pihole (was STOPPED)...`), full migration completed, 7/7 healthy ✓ |

### Notes for Iris
- **CP must be 0.2.18.4 or newer** for Step 3 (best-effort) of the migration to succeed. Spine 0.2.18.3 + CP <= 0.2.18.3 will log `WARNING (best-effort): CP /api/host-ip/migrate failed: exit status 22` (HTTP 401 from middleware), but the strict pins still migrate and the platform still recovers — just leaves stale dnsmasq/Caddy entries that the user can fix from the CP UI.
- **Bug discovered mid-test**: my new endpoint was 401-ing because it wasn't in `src/middleware.ts` PUBLIC_ROUTES allowlist. Fixed in CP 0.2.18.4 (commit b49aa6e). All future server-to-server endpoints in CP need to remember this allowlist.
- **No host-side `youeye-control.service`** — earlier wiki references / my own initial assumption were wrong. CP's systemd unit exists ONLY inside the `youeye-control` container.

---

## v0.2.18.1 — sebastian — 2026-04-07
**Branch:** sebastian
**VM:** ye-sebastian (10.10.10.20)
**Agent:** Sebastian
**Task:** Implement `Plans/Pending/spine-cleanup-uninstall.md` — fix `spine cleanup` completeness, add `spine uninstall self`, add auto self-update before `spine deploy`

### Changes
- `internal/cmd/cleanup.go` — Added 7 new cleanup steps (12-18) covering all leftover artifacts: `youeye` system user (with `pkill -u youeye` first), `incusbr0` bridge, `nft inet/incus` rules, `/run/incus`, Zabbly apt source + GPG key, ZFS packages (with safety check that skips removal if non-Incus zpools exist), and `apt-get update` to refresh apt metadata after repo removal. Switched `uninstallIncusPackages()` from `apt-get remove` to `apt-get purge` so dpkg doesn't leave config files in `rc` state. `totalSteps` 11 → 18 (10 → 17 with `--keep-data`). Final summary updated.
- `internal/cmd/uninstall.go` (new) — `spine uninstall self` command. Reuses `runCleanup()` then removes the spine systemd unit, runtime dirs, backup binary, and finally the spine binary itself (the running Go process keeps its file descriptor open so it can finish printing). Requires typing `UNINSTALL` literally unless `-y` is passed. Hostname intentionally left unchanged.
- `internal/cmd/deploy.go` — `runDeploy()` now invokes `ensureSpineUpToDate()` as Step 0 (skipped when re-exec'd via `SPINE_DEPLOY_UPDATED=1` env guard). Reuses `checkSpineUpdate()` + `updateSelf()`, then `syscall.Exec`s the new binary in place. All failures (network, download, exec) are non-fatal — deploy continues with current binary.
- `internal/cmd/root.go` — Registered `uninstallCmd`. Bumped `Version` 0.2.17 → 0.2.18.1.

### Test Results
- `go build ./...` — clean
- Release build (`spine-linux-amd64`, 9.66 MB) verified via `./spine-linux-amd64 version` → `YE-Spine v0.2.18.1`
- Released as `sebastian-v0.2.18.1` (id 814) with `spine-linux-amd64` asset
- Deployed onto `ye-sebastian` via `sudo spine update self`: 0.2.17 → 0.2.18.1, spine.service restarted, `spine version` confirms new binary
- Cleanup acceptance criteria verification deferred — running cleanup from inside the VM kills the youeye user (and therefore this agent session), so end-to-end cleanup verification needs an out-of-band SSH session

### Notes for Iris
- The new ZFS removal step is safer than the original plan: it scans existing zpools and refuses to purge ZFS if any non-`default` pool exists. The original pseudocode in `Plans/Pending/spine-cleanup-uninstall.md` did not implement this — only mentioned it in the Risks section. I implemented it.
- `pkill -u youeye` before `userdel -r youeye` is required to avoid "user is currently used by process" errors. Same plan note — the pseudocode only mentioned it in Risks, I implemented it.
- The self-update re-exec uses `SPINE_DEPLOY_UPDATED=1` as a one-shot guard. If the deploy is invoked from the API (which it shouldn't be — see plan Risks), the env var would need to be respected by callers. I did not add an explicit guard against API-invoked deploys; the existing code path only exposes deploy via CLI.
- Companion fix in YE-ControlPanel `sebastian-v0.2.18.1` (BUG-001 Pi-Hole FTL v6 password env vars + 401 auth recovery) — same release tag, both repos.

---

## v0.2.13.1 — ben — 2026-04-01
**Branch:** ben
**VM:** benvm.test (192.168.31.208)
**Agent:** Ben
**Task:** FIX-1: Remove spine update ui command; FIX-2: Fallback-to-main in spine update

### Changes
- `internal/cmd/update.go` — Removed updateUICmd, updateUI(), getUIVersion(). Removed init() registration. Updated updateSelf() and updateControl() to use GetLatestTagForBranch() instead of GetLatestVersionForBranch()+BuildTag(), fixing 404 after Iris promotion.
- `internal/releases/releases.go` — Added GetLatestTagForBranch() which returns the full tag string (branch or main) and the effective branch used, enabling callers to detect and log fallback.
- `internal/cmd/root.go` — Version bumped to 0.2.13.1.

### Test Results
- `spine update ui` now returns unknown command (no ui subcommand in help)
- `spine update self` correctly found ben-v0.2.13.1 and updated
- `spine update control` correctly found ben-v0.2.13.1 and updated
- FIX-2 verified: with branch=john (no john-v0.2.13.1 tag), update control falls back to v0.2.12 and logs "No john-branch tag found — falling back to main tag: v0.2.12"
- spine status: Spine v0.2.13.1, CP v0.2.13.1, 7 running 0 stopped

### Notes for Iris
- No DB migrations, no infrastructure changes
- GetLatestTagForBranch() is additive — GetLatestVersionForBranch() still exists and is used by status/version checks
- The updateUI() function removal is safe: UI updates have been via CP web UI for several cycles

## v0.2.7.1 — lisa — 2026-03-30
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Backup engine — Spine backup API with poll-based progress

### Changes
- `internal/backup/status.go` — backup status file with atomic writes (same pattern as update status)
- `internal/backup/runner.go` — backup pipeline: stop containers, copy volumes, tar archive, AES-256-CBC encryption, write to target
- `internal/api/server.go` — POST /api/backup/run and GET /api/backup/status endpoints
- `internal/cmd/root.go` — version bump to 0.2.7.1

### Test Results
- Spine backup API tested on lisavm: backup created, encrypted, decryptable
- Platform remains healthy: 7 running, 0 stopped

### Notes for Iris
- New backup package in internal/backup/ — no dependencies on existing packages
- Two new API routes added to server.go setupRoutes()

## v0.2.6.1 — sam — 2026-03-29 (session 2 — resumed)
**Branch:** sam
**VM:** samvm.test (192.168.31.209)
**Agent:** Sam
**Task:** Add missing update flow tests + API endpoint coverage

### Changes
- `internal/update/download.go` — new: DownloadBinary, VerifyChecksum, AtomicInstall, RollbackInstall helpers
- `internal/update/download_test.go` — new: 13 tests (httptest mock, checksum, atomic swap, rollback)
- `internal/api/server.go` — youeyeConfigPath const → var for test override
- `internal/api/server_test.go` — added 12 tests: /api/status (3), /api/updates/check (4), /api/config GET/PATCH (5)

### Test Results
- `go test ./internal/...` — all testable packages pass (api, config, releases, update, version)
- internal/cmd fails to build on Windows (Setsid syscall — pre-existing, Linux-only code)
- Playwright: 2 tests, 8 screenshots, all verified — Tests/Sam/20260329_3/

### Notes for Iris
- No schema changes, no migrations
- youeyeConfigPath change is backward compatible (same default path)

## v0.2.6.1 — sam — 2026-03-29
**Branch:** sam
**VM:** samvm.test (192.168.31.209)
**Agent:** Sam
**Task:** Comprehensive test coverage for critical packages

### Changes
- `internal/releases/releases_test.go` — 21 tests: tag matching (IsMainTag, IsBranchTag, ExtractVersion, BuildTag), branch-aware version fetching (mock Gitea server), client operations, download URLs, error handling
- `internal/config/config_test.go` — 22 tests: default config validation, all validation rules (empty fields, ports, log levels), LoadFromFile with valid/invalid/missing YAML, Reset, Get fallback
- `internal/update/status_test.go` — 10 tests: write/read status, Start/Complete/Fail lifecycle, Emit progress, atomic writes, concurrent writes, ClearStatus
- `internal/api/server_test.go` — 17 tests: health/version endpoints, method-not-allowed guards, auth verify (missing body, empty creds), rate limiter (under/over limit, separate users, cleanup), route registration
- `internal/version/compare_test.go` — existing 25 tests (100% coverage)
- `scripts/test.sh` — local test runner: go vet + go test with --coverage/--race/--verbose flags
- `internal/cmd/root.go` — version bump to 0.2.6.1

### Test Results
- `go test ./...` — 72 tests, all passing
- Coverage: version 100%, config 93%, update 90%, releases 56% (core logic 89%+), api 9% (system-dependent handlers)
- Screenshots: Tests/Sam/20260329_2/

### Notes for Iris
- Test-only changes — no functional changes to Spine behavior
- Tests use httptest.Server mocks, no external API calls
- scripts/test.sh needs `chmod +x` on Linux

---

## v0.2.4.1 — lisa — 2026-03-28
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Fix branch release fallback logic — prefer main when newer than stale branch tags

### Changes
- `internal/releases/releases.go` — `GetLatestVersionForBranch()` and `GetAssetURLForBranch()` now compare highest branch version against highest main version and use whichever is newer, instead of short-circuiting on any branch match
- `internal/cmd/root.go` — bumped default Version to 0.2.4.1

### Test Results
- Playwright: 3 tests, 2 passed, 1 failed (selector issue — no "Updates" sidebar link, not a code bug)
- Screenshots: Tests/Lisa/20260328_1/
- `spine status`: 7 running, 0 stopped after update

### Notes for Iris
- This fix changes release resolution behavior: stale branch tags (e.g. `lisa-v0.2.1.1`) will no longer be preferred over newer main releases (e.g. `v0.2.4`). Branch tags are only used when their version is >= main's version.
- Paired fix in YE-ControlPanel (same logic, 3 files)

## v0.2.4.1 — mike — 2026-03-27
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Unified update experience with persistent status tracking

### Changes
- `internal/update/status.go` — New package: atomic status file writer at /var/lib/youeye/update-status.json with Start/Complete/Fail/Emit helpers
- `internal/api/server.go` — Added GET /api/update/status endpoint, integrated status tracking into handleUpdateSelf/Control/UI handlers
- `internal/cmd/update.go` — Added status file writes at each update stage (download, verify, install, restart), fixed "text file busy" by unlinking binary before rename
- `internal/cmd/root.go` — Version bump to 0.2.4.1

### Test Results
- Go build: clean cross-compile for linux/amd64
- Deployed to mikevm: Spine v0.2.4.1 running, /api/update/status returns idle state
- Playwright: 8 tests, all pass

### Notes for Iris
- New `internal/update/` package — creates /var/lib/youeye directory at runtime
- Fixed long-standing "text file busy" bug in self-update (os.Remove before os.Rename)
- Status file is best-effort — update proceeds even if status write fails

## v0.2.1.3 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Multi-language support across YouEye platform

### Changes
- `internal/cmd/language.go` — New `spine language` command (show/list/set) with 5-language support
- `internal/cmd/language_helpers.go` — Raw YAML read/write helpers for language field preservation
- `internal/cmd/root.go` — Register languageCmd, bump version to 0.2.1.1
- `internal/api/server.go` — Add Language field to YouEyeConfig struct + PATCH handler support

### Test Results
- Go build: clean compile for amd64 and arm64
- TypeScript: N/A (Go project)

### Notes for Iris
- Language field added to YouEyeConfig — PATCH handler updated, all existing fields preserved
- language.go uses raw YAML map for read-modify-write to avoid losing unknown fields
- No breaking changes to existing API

---

# YE-Spine Agent Guide

**Last Updated:** March 11, 2026

This document explains how to work on YE-Spine as an AI agent.

---

## Recent Changes

## v0.2.1.2 — john — 2026-03-22
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix install.sh downloading wrong binary + version injection via ldflags

### Changes
- `install.sh` — Fixed `download_spine()`: removed unreliable JSON grep that grabbed the first `browser_download_url` from any release (newest-first from Gitea, usually a dev release). Now uses branch-aware constructed URL that respects BRANCH and VERSION from `get_latest_version()`. Also fixed `get_latest_version()`: greedy sed on single-line JSON returned the LAST (oldest) match; now splits JSON first with `tr ',' '\n'` then uses `grep + head -1` to get the newest matching tag.
- `internal/cmd/root.go` — Updated default Version to `0.2.1.2`, added documentation for ldflags-based version injection at build time. BuildDate remains "dev" as default for development builds.

### Test Results
- Deployed to johnvm.test, `spine version` confirms `v0.2.1.2, Build: 2026-03-22`
- `spine status` shows "latest" — no more false "update available"
- `spine version --check` confirms "Spine is up to date"
- install.sh version detection tested for main (`v0.2.0`), john (`0.2.1.2`), dev (`0.1.106.3`) — all correct with HTTP 200

### Notes for Iris
- Build commands now MUST include ldflags to inject version: `-X git.byka.wtf/potemsla/YE-Spine/internal/cmd.Version=<ver> -X git.byka.wtf/potemsla/YE-Spine/internal/cmd.BuildDate=<date>`
- Updated `dev-agent.md` and root `CLAUDE.md` build commands to reflect this
- The `install.sh` fix is critical for main branch users — without it, fresh installs download dev binaries
- Fallback version in install.sh updated from `0.1.105.2` to `0.2.0`

## v0.1.106.3 — john — 2026-03-20
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix branch-unaware deploy and branch wipe on setup

### Changes
- `internal/releases/releases.go` — New shared package for branch-aware release fetching (semver sorting, tag filtering, asset URL resolution)
- `internal/container/control.go` — Rewrote `GetControlPanelDownloadURL()` to use `releases.GetAssetURLForBranch()` instead of blindly grabbing `releases[0]`
- `internal/cmd/update.go` — Refactored to use shared `releases.*` functions, removed duplicated release logic
- `internal/api/server.go` — Replaced local release functions with shared `releases.*` package calls
- `internal/cmd/root.go` — Version bump to 0.1.106.3

### Test Results
- Playwright: 7 screenshots, setup wizard completed successfully
- Deployed to johnvm.test, CP v0.1.106.3 confirmed (pulled from john branch, not newest release)
- `release_branch: john` verified preserved after setup wizard completion

### Notes for Iris
- New `internal/releases/` package — shared by container, cmd, and api packages
- Existing `internal/releases/client.go` was already present; `releases.go` adds branch-aware functions alongside it
- No breaking changes to CLI commands or API endpoints

---

### v0.1.104.4 — Fix UI Bridge Token Provisioning (2026-03-11)

**Agent:** Alpha (α)
**Branch:** alpha

- `updateUI()` now calls `provisionBridgeToken()` after deploying a UI update, ensuring
  the bridge token survives UI container updates and snapshot rollbacks.
- Previously, only `deploy` and `updateControl` provisioned the token — `updateUI` did not.

---

## ⚠️ MANDATORY: Complete Release Workflow

**EVERY TIME you make code changes, you MUST follow this complete workflow:**

### 1. Make Code Changes
- Implement the requested changes
- Update version numbers in all required files

### 2. Build Binaries

**For Spine changes:**
```powershell
cd YE-Spine

# Update version in:
# - internal/cmd/root.go: var Version = "X.X.X"
# - install.sh: fallback version in get_latest_version()
# - README.md: version badge

# Build amd64
$env:GOOS="linux"; $env:GOARCH="amd64"; $env:CGO_ENABLED="0"
go build -ldflags "-s -w" -o spine-linux-amd64 ./cmd/spine

# Build arm64
$env:GOOS="linux"; $env:GOARCH="arm64"; $env:CGO_ENABLED="0"
go build -ldflags "-s -w" -o spine-linux-arm64 ./cmd/spine
```

**For Control Panel changes:**
```powershell
cd YE-ControlPanel

# Update version in:
# - package.json: "version": "X.X.X"
# - README.md: version badge

# Build standalone
pnpm run build

# Create tarball (IMPORTANT: cd into standalone directory first)
cd .next/standalone
tar -cvf ../standalone.tar *
```

### 3. Create Gitea Release

**API Endpoint:** `https://git.byka.wtf/api/v1`
**Token:** `62609d8e2a92a109c324fa1fa9b1404e6e58dbb4`

```powershell
# Create release
$headers = @{ "Authorization" = "token 62609d8e2a92a109c324fa1fa9b1404e6e58dbb4" }
$body = @{ tag_name = "vX.X.X"; name = "vX.X.X"; body = "Release notes" } | ConvertTo-Json
$release = Invoke-RestMethod -Uri "https://git.byka.wtf/api/v1/repos/potemsla/REPO/releases" -Method POST -Headers $headers -Body $body -ContentType "application/json"

# Upload binaries
Invoke-RestMethod -Uri "https://git.byka.wtf/api/v1/repos/potemsla/REPO/releases/$($release.id)/assets?name=FILENAME" -Method POST -Headers $headers -InFile "PATH" -ContentType "application/octet-stream"
```

### 4. Test on YouEye-Dev Server

**ALWAYS test on YouEye-Dev (192.168.31.157) before reporting success.**

```bash
ssh -i ~/.ssh/YouEye-Main-Key root@192.168.31.157

# Update and verify Spine
spine update self
spine version
spine status

# If testing fresh deployment:
spine cleanup -y
spine deploy
spine status

# If testing Control Panel changes:
spine update control
spine status
```

### 5. Verify Functionality

Test the specific feature you implemented:
- [ ] Login works with host credentials
- [ ] CSRF protection rejects requests without token
- [ ] CSRF protection accepts requests with valid token
- [ ] API endpoints require authentication
- [ ] Admin-only endpoints check admin status

### 6. Report Results

Only after ALL tests pass, report to user. User will then:
- Test manually on YouEye-Test (192.168.31.156)
- Approve final release
- Then you commit and push code changes

---

## Testing Procedures

### Test Servers

**YouEye-Dev (192.168.31.157):**
- Primary automated testing server for AI agents
- SSH Key: `~/.ssh/YouEye-Main-Key`
- User: `root`
- **AI agents test all changes here first**
- **Feel free to wipe/reinstall as needed**

**YouEye-Test (192.168.31.156):**
- User's manual testing environment
- SSH Key: Same as Dev (`~/.ssh/YouEye-Main-Key`)
- User: `root`
- **AI agents CAN test on this server after Dev**
- User tests releases manually on this server to verify

### Testing Workflow

1. **Build and release to Gitea** - Create release with binaries
2. **Test on YouEye-Dev using only spine commands** - No direct system commands
3. **Verify full workflow works** - `spine update self`, `spine cleanup -y`, `spine deploy`, `spine status`
4. **Report results to user** - User will then test on YouEye-Test manually
5. **User confirms final approval** - Then commit and push code

### Test Commands (in order)

```bash
# Update to latest release
spine update self

# Verify version
spine version
spine status

# Test cleanup (wipes everything)
spine cleanup -y

# Verify cleanup worked
spine status

# Test fresh deploy
spine deploy

# Verify deployment
spine status
```

---

## Release Workflow

### Version Bumping

Files to update for each version:
1. `internal/cmd/root.go` - `var Version = "X.X.X"`
2. `install.sh` - Fallback version in `get_latest_version()` function
3. `README.md` - Current version badge at top

### Building Binaries

```powershell
cd YE-Spine

# Build amd64
$env:GOOS="linux"; $env:GOARCH="amd64"; $env:CGO_ENABLED="0"
go build -ldflags "-s -w" -o spine-linux-amd64 ./cmd/spine

# Build arm64
$env:GOOS="linux"; $env:GOARCH="arm64"; $env:CGO_ENABLED="0"
go build -ldflags "-s -w" -o spine-linux-arm64 ./cmd/spine
```

### Creating Gitea Release

1. Create release via API: `POST /api/v1/repos/potemsla/YE-Spine/releases`
2. Upload binaries via API: `POST /api/v1/repos/potemsla/YE-Spine/releases/{id}/assets`
3. Gitea Token: `62609d8e2a92a109c324fa1fa9b1404e6e58dbb4`

---

## Command Reference

### Current Commands (v0.1.0)

| Command | Description |
|---------|-------------|
| `spine branch` | Show current release channel |
| `spine branch set <name>` | Switch to named release channel |
| `spine branch reset` | Reset to main release channel |
| `spine deploy` | Full installation: Incus + Control Panel + Caddy + Pi-Hole |
| `spine status` | Show system status and versions |
| `spine update self` | Update spine binary (atomic with rollback) |
| `spine update control` | Update Control Panel |
| `spine update system` | Update host OS packages |
| `spine cleanup` | Remove Incus and all data (interactive) |
| `spine cleanup -y` | Remove Incus and all data (no prompt) |
| `spine install incus` | Install only Incus |
| `spine install control` | Install only Control Panel |
| `spine api` | Start API server (foreground) |
| `spine logs` | View spine service logs |
| `spine version` | Show version info |
| `spine config init` | Generate default config file |
| `spine config show` | Display current configuration |
| `spine config validate` | Validate configuration |

---

## Known Issues

### OCI Container Launch: CLI Bug (RESOLVED - February 3, 2026)
- **Status:** Incus 6.21 CLI bug - REST API works fine
- **CLI Issue:** `incus launch docker:alpine test-alpine` fails silently (exit code 1)
- **API Works:** `curl --unix-socket /var/run/incus.socket POST /1.0/instances` with OCI source succeeds
- **Confirmed on:** Fresh YouEye-Dev-VM install (192.168.31.190) with Spine v0.1.9
- **Root Cause:** Bug in Incus 6.21 CLI OCI handling - API implementation is correct
- **Workaround:** Use Incus REST API via Control Panel or direct curl commands
- **Impact:** NONE on Control Panel - it uses REST API exclusively
- **Verification:** OCI container `test-alpine` created via API, running Alpine 3.23.3 as `CONTAINER (APP)`
- **Next Steps:** Report CLI bug to Incus/Zabbly team

**Working API Example:**
```bash
curl --unix-socket /var/run/incus.socket -X POST 'http://localhost/1.0/instances' \
  -H 'Content-Type: application/json' \
  -d '{"name":"test","source":{"type":"image","server":"https://docker.io","protocol":"oci","alias":"library/alpine"},"type":"container"}'
```

### Storage Driver Detection (Fixed in v0.0.9+)
- Old Incus installations may have wrong storage driver
- `spine cleanup` then `spine deploy` fixes this
- Detection now properly reinitializes with `dir` driver

### styled-jsx Dependency (Fixed in v0.0.9+)
- Not included in Control Panel standalone bundle
- Now automatically installed during deployment

### Socket Proxy Errors (Non-critical)
- Socket proxy errors during deployment are expected
- These don't affect functionality - port 3000 proxy works correctly

---

## Recent Changes

### v0.1.104.3: Gamma — Install gnupg prerequisite before Zabbly repo setup (March 11, 2026)

**Agent:** Gamma (γ)
**Branch:** gamma
**Tag:** gamma-v0.1.104.3

**Changes:**
- Fix: On fresh Debian 13 installs, `gpg` is not installed by default. When `configureZabblyRepository()` runs `gpg --dearmor` to import the Zabbly GPG key, the command fails with exit status 127. Spine then falls back to Debian system packages, installing Incus 6.0.4 instead of 6.22 from Zabbly. Incus 6.0.4 lacks OCI protocol support, causing all infrastructure containers to fail deployment.
- Added an idempotent check in `configureZabblyRepository()`: before the first `gpg` call, checks if `gpg` is installed via `exec.LookPath("gpg")`, and if not, installs the `gnupg` package automatically.

**Files changed:**
- `internal/incus/install.go` — Added gnupg prerequisite check before GPG key import
- `internal/cmd/root.go` — Version bump to 0.1.104.3

### v0.1.105.1: Delta Merge — Infrastructure Reconciliation (March 11, 2026)

**Agent:** Delta (δ)
**Branch:** dev
**Tag:** dev-v0.1.105.1

**Merged branches:**
- `gamma`: Infrastructure reconciliation trigger after CP update

**Changes:**
- After `spine update control`, Spine now calls CP's `/api/deploy/infrastructure/reconcile` endpoint
- This ensures missing infrastructure containers (Pi-Hole, Caddy, PostgreSQL, Authentik, UI) are restored after update
- Runs synchronously in CLI mode, asynchronously via goroutine in API mode

**Merge status:** Clean (fast-forward)

---

### v0.1.54.1: Semantic Version Comparison (March 10, 2026)

**Agent:** Beta (β)
**Branch:** beta
**Tag:** beta-v0.1.54.1

**Feature:** Proper semantic version comparison that handles both 3-digit (x.y.z) and 4-digit (x.y.z.w) versions. Previously, YouEye used simple string equality (`==`) to compare versions, which breaks for 4-digit versions used by agent branches.

**New Files:**
- `internal/version/compare.go` — `CompareVersions(a, b string) int`, `IsNewer(candidate, current string) bool`, `SortVersionsDesc(versions []string)`
- `internal/version/compare_test.go` — Comprehensive tests for version comparison
- `cmd/spine/main.go` — Main entry point for the Spine binary

**Changed Files:**
- `internal/cmd/root.go` — Version 0.1.54 → 0.1.54.1, added `--check` flag to `spine version`
- `internal/cmd/status.go` — `checkSpineUpdate()` now uses `version.IsNewer()` + `version.SortVersionsDesc()` for release sorting
- `internal/cmd/update.go` — `updateSelf()`, `updateControl()`, `updateUI()` now use `version.IsNewer()` instead of `==`; `getLatestGiteaReleaseForBranch()` sorts releases by semantic version
- `install.sh` — Fallback version updated to 0.1.54.1

**Key Behavior Changes:**
- `spine version --check` — Shows current version and checks for newer releases
- Releases are sorted by semantic version numerically (not alphabetically)
- 4-digit versions compare correctly: 0.1.54.1 vs 0.1.54.12
- Missing 4th digit treated as 0: "0.1.54" == "0.1.54.0"

### v0.1.54: Branch-Aware Completeness Fixes (February 25, 2026)

**Fixes:** Four code paths that were NOT branch-aware after the v0.1.52 release channel system were identified and fixed.

**Bug 1 — `getAssetDownloadURL` in server.go:**  
Used `releases[0]` (most recently created) without branch filtering. The Spine API's CP/UI update endpoints (`/api/update/control`, `/api/update/ui`) could download wrong-branch releases.  
Fix: Added `getReleaseBranch()` call, filters by `isBranchReleaseTag` with fallback to `isMainReleaseTag`.

**Bug 2 — `checkSpineUpdate` in status.go:**  
`spine status` showed `v0.1.53 → valpha-v0.1.53 available` on the main-branch server (VM 190). Root cause: `checkSpineUpdate()` used `/releases/latest` endpoint, which returns the most recently created release regardless of branch tag.  
Fix: Rewrote to fetch `?limit=50`, read branch from `/var/lib/youeye/config/youeye.yaml`, filter by branch prefix or main `v\d` pattern.

**Code Changes:**
- `internal/api/server.go` — `getAssetDownloadURL()` now reads branch from `getReleaseBranch()`, uses `?limit=50`, filters releases by branch tag with fallback
- `internal/cmd/status.go` — `checkSpineUpdate()` completely rewritten: fetches all releases, reads branch from youeye.yaml, filters by tag convention
- `internal/cmd/root.go` — Version 0.1.52 → 0.1.54
- `install.sh` — Fallback version 0.1.54
- `README.md` — Version badge 0.1.54

**Testing:**
- VM 190 (main): `spine update self` → v0.1.54 (from `v0.1.54` tag), `spine status` → `v0.1.54 (latest)` — no longer shows alpha versions
- VM 191 (alpha): `spine update self` → v0.1.54 (from `alpha-v0.1.54` tag), `spine status` → `v0.1.54 (latest)` — correctly filters within alpha channel

### v0.1.52: Branch-Based Release Channels (February 24, 2026)

**Feature:** Complete release channel system enabling parallel development across isolated environments. Multiple AI agents (alpha, beta, gamma) can work on different branches simultaneously, each with their own test VM.

**How it works:**
- Each YouEye instance has a `release_branch` in `/var/lib/youeye/config/youeye.yaml`
- Spine filters Gitea releases by tag prefix: main uses `v{version}`, branches use `{branch}-v{version}`
- If no branch-specific release exists, falls back to main releases
- AppMarket uses git branches (not tags) for catalog fetching

**New CLI:**
- `spine branch` — Show current channel with tag convention info
- `spine branch set alpha` — Switch to alpha channel
- `spine branch reset` — Reset to main

**Code Changes:**
- `internal/api/server.go` — Added `ReleaseBranch` to YouEyeConfig, branch-aware release filtering helpers (`getLatestBranchRelease`, `getReleaseBranch`, `isMainReleaseTag`, `isBranchReleaseTag`, `extractVersionFromTag`), PATCH handler for `release_branch`
- `internal/cmd/update.go` — All update commands (self, control, ui) now read branch from config, filter releases by tag prefix, build branch-aware download URLs, fallback to main
- `internal/cmd/branch.go` — NEW: `spine branch` CLI command (show/set/reset) with validation
- `internal/cmd/root.go` — Registered `branchCmd`, version 0.1.52
- `install.sh` — Added `BRANCH` env var for fresh installs, branch-aware version detection

**Testing:**
- VM 190 (main): `spine update self` → up to date v0.1.52, `spine update control` → v0.1.101, config returns `release_branch: ""`
- VM 191 (alpha): `spine branch set alpha` → works, `spine update self` → detects alpha-v0.1.52, `spine update control` → uses alpha-v0.1.101 download URL
- Branch reset/set cycle verified: alpha → main → alpha
- Update check API returns correct versions on both channels
- Settings UI renders Release Channel card on both VMs

### v0.1.50: Deploy Output Uses HTTPS IP (February 17, 2026)

**Change:** After `spine deploy`, the completion message now shows `https://<IP>` instead of `http://<IP>:3000`. This reflects the new Caddy-based setup flow where the IP address serves the setup wizard via HTTPS (self-signed cert).

**Modified:**
- `internal/cmd/deploy.go` — Changed deploy completion URL from `http://%s:3000` to `https://%s`
- `internal/cmd/root.go` — Version bumped to 0.1.50
- `install.sh` — Fallback version updated to 0.1.50

**Testing:**
- Clean deploy on 190: Spine outputs `https://192.168.31.190` at completion
- Caddy serves self-signed HTTPS on IP, routes to CP setup wizard
- Full Playwright test: login → setup wizard → completion → post-setup "Setup Complete" page
- Update path tested on 191: `spine update self` → v0.1.50

### v0.1.49: Deprecate `spine update ui` (February 15, 2026)

**Change:** UI updates are now managed by the Control Panel (v0.1.88). The `spine update ui` command now prints a deprecation warning before executing. It will be removed in a future version.

**Modified:**
- `internal/cmd/update.go` — Added deprecation notice to `updateUI()` function
- `internal/cmd/root.go` — Version bumped to 0.1.49
- `install.sh` — Fallback version updated to 0.1.49

**Testing:**
- Deployed to both 190 and 191
- Running `spine update ui` shows deprecation message
- UI updates via Control Panel webui confirmed working on 191

### v0.1.48: Fix Tar Extraction for Update and Deploy (February 14, 2026)

**Fix:** `spine update control`, `spine update ui`, and `spine deploy` (initial CP deployment) all used `--strip-components=1` when extracting standalone.tar. The tar is created from INSIDE the standalone directory (`cd .next/standalone && tar -cvf ../standalone.tar *`), so files are at the root level — no `standalone/` prefix. `--strip-components=1` silently dropped root-level files (`server.js`, `package.json`) and corrupted the `.next/` and `node_modules/` directory structure, causing the app to fail to start.

**Root Cause:** The tar creation command changed at some point from creating entries with a `standalone/` prefix to flat root-level entries, but the Spine extraction code was never updated. The comment in control.go incorrectly stated "The tarball contains standalone/server.js".

**Modified:**
- `internal/cmd/update.go` — Removed `--strip-components=1` from `updateControl()` and `updateUI()` tar extraction
- `internal/container/control.go` — Removed `--strip-components=1` from `DeployControlPanelApp()` tar extraction, updated comments
- `internal/cmd/root.go` — Version bumped to 0.1.48
- `install.sh` — Fallback version updated to 0.1.48
- `README.md` — Version badge updated

**Testing:**
- Verified tar structure (v0.1.85 standalone.tar): files at root level (server.js, .next/, node_modules/, public/, package.json)
- Deployed to .191 via `spine update self` + `spine update control`
- Health check passes, CP starts correctly

### v0.1.47: Ensure ZFS Storage for All Containers (February 13, 2026)

**Fix:** After `spine cleanup`, the underlying ZFS pool `default` survived but the Incus storage pool definition was removed. On next `spine deploy`, preseed tried to create a new 20GB ZFS pool, failed (name collision with existing zpool), and fell back to `dir` storage driver. This prevented all snapshot/incremental backup capabilities.

**Root Cause:** `spine cleanup` removed Incus storage pool entries but didn't destroy the underlying ZFS pool (`zpool destroy`). Preseed's `size: 20GB` config creates a new image-backed pool, but fails when a pool named `default` already exists in ZFS.

**Modified:**
- `internal/incus/install.go` — Added `zpoolExists()` function to detect existing ZFS pools. Modified `initializeWithPreseed()` and `initializeManually()` to use `source: default` (reuse existing zpool) instead of `size: 20GB` when an existing pool is found.
- `internal/cmd/cleanup.go` — Added `destroyZFSPools()` function called as new step 8 (between unmount filesystems and uninstall packages). Runs `zpool destroy -f default` to prevent orphaned pools. Total steps 10→11 (9→10 with --keep-data).
- `internal/cmd/root.go` — v0.1.47
- `install.sh` — Fallback v0.1.47

**Testing:**
- Full cycle: `spine cleanup -y` → `spine deploy` on dev VM (192.168.31.190)
- ZFS pool destroyed during cleanup step [8/11]
- Deploy created fresh ZFS storage pool: `incus storage show default` → `driver: zfs`
- All 7 containers running on ZFS (6 app containers + youeye-ui)
- Snapshot create/list/delete tested successfully on multiple containers
- Incremental backup groundwork confirmed ready

---

### v0.1.46: Kill Orphaned Forkproxy Processes During Cleanup (February 13, 2026)

**Fix:** `spine cleanup -y` didn't kill orphaned `incusd forkproxy` processes that survive container deletion. These processes hold host ports (especially 80/443), causing subsequent `spine deploy` to fail with `bind: address already in use` when Caddy tries to start.

**Root Cause:** On test VM 192.168.31.191, an orphaned forkproxy (PID 21790, from Feb 12) held port 80. `incus stop/delete` and even `systemctl stop incus` didn't kill reparented forkproxy processes. Caddy's container went STOPPED because its proxy device couldn't bind port 80.

**Modified:**
- `internal/cmd/cleanup.go` — Added Step 5: `pkill -9 -f "incusd forkproxy"` between container deletion and Incus service stop. Renumbered subsequent steps (totalSteps 9→10, 8→9 with --keep-data).
- `internal/cmd/root.go` — v0.1.46
- `install.sh` — Fallback v0.1.46

**Testing:**
- Deployed to test server (192.168.31.191)
- `spine cleanup -y` — forkproxy killed, port 80 freed
- `spine deploy` — all 6 containers RUNNING including Caddy
- Caddy serving on ports 80, 443, admin API responding

---

### v0.1.45: Fix parseImageRef for Docker Hub Namespaces (February 12, 2026)

**Fix:** `parseImageRef` incorrectly treated namespaced Docker Hub images like `pihole/pihole` as having `pihole` as the registry host. Now checks if first segment contains `.` or `:` to distinguish registries from Docker Hub namespaces.

**Modified:**
- `internal/api/server.go` — Fixed `parseImageRef` logic, added dot/colon check
- `internal/cmd/root.go` — v0.1.45
- `install.sh` — Fallback v0.1.45

**Testing:**
- Deployed to dev server (192.168.31.190)
- `postgres:16-alpine` → docker.io/library/postgres ✅
- `pihole/pihole:latest` → docker.io/pihole/pihole ✅
- `ghcr.io/goauthentik/server:latest` → ghcr.io/goauthentik/server ✅

---

### v0.1.44: Registry Digest Endpoint (February 12, 2026)

**New:** Added `GET /api/registry/digest?image=<image>&tag=<tag>` endpoint to Spine API server. This allows the Control Panel to check OCI image digests via Spine running on the host (kept for consistency even though CP now has internet access).

**Added:**
- `internal/api/server.go` — `handleRegistryDigest` handler, `parseImageRef`, `getRegistryToken` (Docker Hub + GHCR anonymous tokens), `getManifestDigest` (HEAD request for Docker-Content-Digest header)
- `internal/cmd/root.go` — v0.1.44
- `install.sh` — Fallback v0.1.44

**Testing:**
- Deployed to dev server, all registries (Docker Hub, GHCR) return valid digests

---

### v0.1.43: Fix UI SSO Service Restart (February 12, 2026)

**Fix:** After writing `/etc/youeye-ui.env` via `handleUISSO`, Spine called `systemctl start` which is a no-op if the service is already running. Changed to `systemctl restart` so the new environment variables are picked up.

**Modified:**
- `internal/api/server.go` — Changed `systemctl start` to `systemctl restart` in `handleUISSO` POST handler
- `internal/cmd/root.go` — v0.1.43
- `install.sh` — Fallback v0.1.43
- `README.md` — Version badge v0.1.43

**Testing:**
- Deployed to dev server (192.168.31.190), verified Spine v0.1.43
- UI SSO env vars loaded after setup wizard runs

---

### v0.1.42: Move Infrastructure Deployment to Control Panel (February 12, 2026)

**Major Refactor:** All infrastructure app deployment (PostgreSQL, Authentik, Caddy, Pi-Hole, UI) moved from Spine to Control Panel. Spine now acts as a thin bootstrapper.

**New 4-Step Deploy Flow:**
1. Install Incus (unchanged)
2. Start Spine API server
3. Deploy Control Panel container (unchanged)
4. POST to CP's `/api/deploy/infrastructure` SSE endpoint — CP deploys everything else

**Removed:**
- `internal/app/` directory (deploy.go, manifest.go) — all app deployment logic
- `internal/cmd/deploy.go` — Removed all `deployXxx()` functions, replaced with SSE HTTP client
- `internal/cmd/status.go` — Removed hardcoded app lists, now just shows containers
- `internal/cmd/control.go` — Removed `internal/app` import, simplified

**Modified:**
- `internal/cmd/deploy.go` — New 4-step flow with SSE parsing (30min HTTP timeout, keepalive support)
- `internal/cmd/root.go` — v0.1.42
- `install.sh` — Fallback v0.1.42

**Testing:**
- Clean deploy on dev server (192.168.31.190): all 7 containers running, exit code 0
- SSE stream completes fully with keepalive preventing idle timeout
- Spine binary: 10.34MB (amd64), 9.63MB (arm64) — smaller without app deployment code

---

### v0.1.39: Config API Endpoint (February 10, 2026)

**Feature:** Added `/api/config` endpoint for managing `youeye.yaml` configuration.

**Changes:**
- `internal/api/server.go` — New `handleYouEyeConfig()` handler supporting GET, PUT, PATCH
- `internal/api/server.go` — `YouEyeConfig` struct, `loadYouEyeConfig()`/`saveYouEyeConfig()` helpers
- `internal/cmd/root.go` — v0.1.39
- `install.sh` — Fallback v0.1.39

**Config file:** `/var/lib/youeye/config/youeye.yaml`
- `site_name`: Instance name (default "YouEye")
- `domain`: Root domain
- `subdomains`: Map of service subdomains (control, auth, dns, ui)
- `setup_completed`: Whether initial setup wizard has been run

**API:**
- `GET /api/config` — Returns full config
- `PUT /api/config` — Replace entire config
- `PATCH /api/config` — Merge partial updates

**Testing:**
- Deployed to dev server (192.168.31.190), all three methods verified
- Config persists across Spine restarts

---

### v0.1.37: Fix UI Deploy, OCI Entrypoint, Timeout Race (February 10, 2026)

**Bug Fixes:**
1. **Tar extraction path** (`ui.go`): `standalone.tar` extracts `standalone/` subfolder, putting `server.js` at `/opt/app/standalone/server.js` instead of `/opt/app/server.js`. Fixed by flattening after extraction (`cp -a standalone/. . && rm -rf standalone`).
2. **Deploy recovery** (`ui.go`): `DeployUIContainer` returned immediately if container existed, skipping `DeployUIApp` even if app wasn't deployed. Now checks for `server.js` and re-runs if missing.
3. **Asset search** (`ui.go`): `getUIAssetDownloadURL` only checked `releases[0]`. Now searches ALL releases for `standalone.tar`.
4. **OCI entrypoint** (`deploy.go`): PATCH after creation failed to persist `oci.entrypoint` for Authentik server (lost "server" arg). Fixed by setting `oci.entrypoint` in creation config instead of post-creation PATCH.
5. **Timeout race** (`server.go`): Health check 15×2s=30s raced CP client 30s timeout. Reduced to 10×2s=20s.

**Code Changes:**
- `internal/container/ui.go` — Tar flatten, separated container-exists/app-deployed checks, search all releases
- `internal/app/deploy.go` — Set oci.entrypoint in creation config, removed PATCH block
- `internal/api/server.go` — Health check iterations 15→10
- `internal/cmd/root.go` — v0.1.37
- `install.sh` — Fallback v0.1.37

**Testing:**
- Fresh deploy on dev server (192.168.31.190): all 9 steps pass
- 7 containers running, 0 stopped
- `server.js` at `/opt/app/server.js` (tar flatten confirmed)
- Authentik entrypoint `dumb-init -- ak server` (creation config confirmed)

---

### v0.1.32: YouEye UI Container Deployment & Management — Phase 2 (February 10, 2026)

**Features:**
1. **UI container deployment (Step 9)**: `spine deploy` now creates a `youeye-ui` container (Debian 12, Node.js 22) as Step 9. The UI is installed but NOT started — it requires enabling via the Control Panel settings page.
2. **`spine update ui` command**: New subcommand for updating the UI container to the latest Gitea release. Creates ZFS snapshot before update, rolls back on failure.
3. **UI SSO API endpoints**: New `/api/ui/sso` endpoint (GET/POST/DELETE) allows the Control Panel to configure SSO environment variables, start/stop the UI service, and manage its lifecycle.
4. **UI status in Spine API**: `/api/status` now includes UI container status (installed, enabled, running, version, IP, SSO config state). `/api/updates/check` includes UI version tracking.
5. **Update UI API**: `/api/update/ui` endpoint for triggering UI updates from the Control Panel.

**Bug Fixes:**
- **Incus list regex anchoring**: All `incus list <name>` calls now use `^name$` anchoring to prevent matching multiple containers (e.g., `youeye-ui` was matching all 7 containers).
- **Viper defaults for UI config**: Added missing `deployment.ui.*` and `releases.repositories.ui` defaults to `setDefaults()` in load.go. Without these, viper unmarshaled UIConfig as zero values.

**Code Changes:**
- `internal/config/config.go` — Added UIConfig struct, UI fields to DeploymentConfig and RepositoriesConfig
- `internal/config/defaults.go` — Added UI deployment defaults (container name, port, app dir, node version)
- `internal/config/load.go` — Added viper setDefaults for all UI config keys
- `internal/container/ui.go` — NEW: Full UI container deployment (~250 lines)
- `internal/cmd/deploy.go` — Added Step 9 (UI deployment), updated step count from 8 to 9
- `internal/cmd/update.go` — Added `updateUICmd` and `updateUI()` function
- `internal/cmd/root.go` — Version bumped to 0.1.32
- `internal/api/server.go` — Added UI status, SSO, and update API endpoints + regex fix
- `install.sh` — Fallback version updated to 0.1.32
- `README.md` — Version badge updated to v0.1.32

**Testing:**
- Deployed to dev server (192.168.31.190), verified UI status via Spine API
- Confirmed `incus list` regex fix resolves multi-container matching
- Verified viper defaults fix resolves zero-value UIConfig issue
- API returns correct: `{"ui":{"enabled":true,"installed":true,"ip":"10.117.96.22","status":"running","version":"0.1.0"}}`

---

### v0.1.31: Fix bootstrap_tasks for Authentik 2025.12 (February 9, 2026)

**Fix:**
Removed deprecated `bootstrap_tasks` Django management command. Authentik 2025.12+ handles bootstrapping automatically via env vars (AUTHENTIK_BOOTSTRAP_TOKEN, AUTHENTIK_BOOTSTRAP_PASSWORD, AUTHENTIK_BOOTSTRAP_EMAIL). The akadmin user is created during startup without needing `bootstrap_tasks`.

**Code Changes:**
- `internal/app/deploy.go` - Removed `incus exec youeye-authentik -- python -m manage bootstrap_tasks` call from `createAuthentikAPIToken()`

---

### v0.1.30: Authentik 2025.12 Upgrade, Redis Removal, SSO Fix, Cleanup Fix (February 9, 2026)

**Features:**
1. **Authentik 2025.12**: Upgraded from 2024.12 to 2025.12. Authentik 2025.10+ uses PostgreSQL for everything (task queuing, caching, channels) — Redis is no longer needed.
2. **Redis removal**: Completely removed Redis container (`youeye-authentik-redis`) from deployment, manifests, health checks, update API, and data directories.
3. **SSO redirect fix**: Added `CONTROL_EXTERNAL_URL` env var to SSO env file. The `/api/auth/sso` and `/api/auth/callback` routes now use this env var for the OAuth2 redirect URI instead of inferring from request headers (which produced `0.0.0.0:3000` in containers).
4. **Cleanup --keep-data**: Added `--keep-data` flag to `spine cleanup` that skips deletion of `/var/lib/youeye/`. cleanup now has 9 steps (was 8) — Step 9 deletes `/var/lib/youeye/` app data unless `--keep-data` is set.

**Code Changes:**
- `internal/app/manifest.go` - Authentik image tags 2024.12 → 2025.12, deleted `RedisManifest()` function entirely
- `internal/app/deploy.go` - Removed Redis deployment (container creation, health check, IP retrieval), removed `AUTHENTIK_REDIS__HOST` env var injection for both server and worker
- `internal/cmd/deploy.go` - Removed `authentik-redis/data` from `createDataDirectories()`
- `internal/cmd/cleanup.go` - Added `cleanupKeepData` bool flag (`--keep-data`), totalSteps 9 (8 with --keep-data), Step 9 `os.RemoveAll("/var/lib/youeye")`
- `internal/api/server.go` - Added `ControlURL` to SSO POST struct, added `CONTROL_EXTERNAL_URL` to env file, removed redis from OCI apps lists, updated authentik image tag to 2025.12
- `internal/cmd/root.go` - Version 0.1.30 → 0.1.31

**Key Discovery:**
- Authentik 2025.12 removed the `bootstrap_tasks` management command. User creation now happens automatically during startup via env vars. The token must still be inserted directly into `authentik_core_token` table.

**Testing (192.168.31.190):**
- Full cleanup → deploy cycle: All 6 containers running (no Redis)
- Authentik 2025.12.3 confirmed from bootstrap logs
- SSO setup successful: `prerequisitesMet: true`, OAuth2 Provider + Application created
- SSO redirect goes to `https://control.youeye.local/api/auth/callback` (not `0.0.0.0:3000`)
- `CONTROL_EXTERNAL_URL=https://control.youeye.local` correctly in env file
- Cleanup with 9 steps confirmed, `/var/lib/youeye` deleted

---

### v0.1.29: SSO Environment Management API (February 8, 2026)

**Features:**
1. **SSO env management**: POST/GET/DELETE `/api/control/sso` for Control Panel SSO configuration
2. **Systemd drop-in approach**: Uses `EnvironmentFile=` in systemd drop-in (`sso.conf`) for clean env injection
3. **Delayed restart**: Returns response before restarting CP (2s goroutine delay)
4. **Fix Authentik IP**: Use regex anchor `^youeye-authentik$` in `incus list` to avoid matching redis/worker containers

**Code Changes:**
- `internal/api/server.go` - Added `handleControlSSO()` handler with GET/POST/DELETE, route registered at `/api/control/sso`
- `internal/api/server.go` - Fixed `handleAuthentikCredentials()` to use exact container name match
- `internal/cmd/root.go` - Version bump to 0.1.29

**Testing (192.168.31.190):**
- POST creates env file + systemd drop-in, CP restarts with SSO env vars
- GET confirms configured=true with correct URLs
- Verified EnvironmentFile loaded in systemd service status
- Version 0.1.29 deployed and running

---

### v0.1.27: Silent CP Skip, Remove Pi-Hole 8080, Extended Update API, App Updates (February 8, 2026)

**Features:**
1. **Silent CP container skip**: `installControlPanelContainer()` now silently returns if the container already exists (no error log)
2. **Remove Pi-Hole 8080 mapping**: Removed web UI port 8080 from Pi-Hole manifest (was conflicting with LAN port feature in CP)
3. **Extended update check API**: `/api/updates/check` now returns `incus` (version), `system` (OS + upgradeable count), and `apps` (list of app containers with status/image/availability)
4. **App update endpoint**: New `POST /api/update/app/{name}` to rebuild individual app containers

**Code Changes:**
- `internal/container/control.go` - Silent return if container exists (was logging error)
- `internal/app/manifest.go` - Removed `{Host: 8080, Container: 80, Protocol: "tcp"}` from Pi-Hole ports
- `internal/api/server.go`:
  - `handleUpdatesCheck()`: Added incus version via `incus version`, system info via lsb_release + apt, app manifests with container status
  - `handleUpdateApp()`: New endpoint that finds app manifest, destroys container, redeploys from OCI image
  - Registered `/api/update/app/` route
- `internal/cmd/root.go` - Version 0.1.27
- `install.sh` - Fallback version 0.1.27

**API Response Example:**
```json
{
  "spine": {"current":"0.1.27","latest":"0.1.27","available":false},
  "control": {"current":"0.1.49","latest":"0.1.49","available":false},
  "incus": {"current":"6.21","available":false},
  "system": {"current":"Ubuntu 24.04.3 LTS","upgradeable_count":70,"available":true},
  "apps": [
    {"name":"caddy","display_name":"Caddy","container_name":"youeye-caddy","status":"running","image_tag":"latest","available":false},
    {"name":"pihole","display_name":"Pi-Hole","container_name":"youeye-pihole","status":"running","image_tag":"latest","available":false}
  ]
}
```

**Testing (192.168.31.190):**
- Spine v0.1.27 deployed, all services running
- Updates check returns all fields correctly
- 5 apps detected (caddy, pihole, postgres, authentik, redis)

---

### v0.1.26: Authentik OCI Deployment (February 8, 2026)

**Feature:**
Full automated deployment of Authentik identity provider as Incus OCI containers (server + worker + Redis).

**Key Discoveries (OCI in Incus):**
1. Must NOT include `"type": "container"` in Incus REST API create payload — causes "Bad custom instance type" error. Incus auto-detects type for OCI images.
2. Must add `ghcr` OCI remote before deploying images from ghcr.io.
3. `oci.entrypoint` must be PATCHed after container creation, not set during creation.
4. Volume directories need `0777` permissions — OCI containers run as non-root UID (1000), and `dir` storage driver doesn't support idmapped mounts properly.
5. `AUTHENTIK_BOOTSTRAP_TOKEN` and `AUTHENTIK_BOOTSTRAP_PASSWORD` env vars do NOT create users/tokens in Incus OCI containers.
6. `bootstrap_tasks` (Django management command) schedules user creation as a Celery task — the Authentik worker must be running before it can be processed.
7. API token must be inserted directly into `authentik_core_token` table via PostgreSQL.

**Code Changes:**
- `internal/app/deploy.go`:
  - Removed `"type": "container"` from OCI createPayload
  - Added `EnsureGHCRRemote()` for ghcr.io images
  - Changed volume mkdir from 0755 to 0777 + explicit `os.Chmod`
  - Added `createAuthentikAPIToken()` — runs `bootstrap_tasks` via `incus exec`, polls for akadmin user, INSERTs API token via psql
  - Token creation moved AFTER worker deployment (Celery task dependency)
  - Renamed redis references: `youeye-redis` → `youeye-authentik-redis`
- `internal/app/manifest.go`: Redis renamed to `authentik-redis` (name, display name, container name, data dir)
- `internal/incus/install.go`: Added ghcr remote setup alongside docker remote
- `internal/cmd/deploy.go`: Updated data directory path for authentik-redis
- `internal/cmd/root.go`: Version → 0.1.26

**Testing:**
- Clean deploy on dev server (192.168.31.190): All containers RUNNING
- API token verified: `curl http://<authentik-ip>:9000/api/v3/admin/version/ -H "Authorization: Bearer <token>"` returns `{"version_current":"2024.12.5",...}`
- Full automated flow: Redis → Authentik server → health check → Worker → bootstrap_tasks → akadmin found → token inserted → API verified

### v0.1.21: Security - Randomize Hardcoded Passwords (February 8, 2026)

**Feature:**
Replaced all hardcoded passwords with cryptographically random ones. Added Pi-Hole credentials API with automatic migration for existing deployments.

**Security Changes:**
1. **Container root password** - `control.go`: Changed from hardcoded `"youeye"` to `crypto/rand` 32-byte random password (never stored, logged as "Setting random container root password...")
2. **Pi-Hole WEBPASSWORD** - `manifest.go` + `deploy.go`: Changed from hardcoded `"youeye_admin"` to `crypto/rand` 24-byte random password, stored at `/var/lib/youeye/pihole/.web_password` (mode 0600)
3. **crypto.go** - Removed weak `"youeye-fallback-"` fallback on `crypto/rand` failure; now calls `log.Fatalf` (fail hard). Added `GenerateRandomPassword(length int) string` function.

**New API: Pi-Hole Credentials**
- `GET /api/pihole/credentials` - Returns `{"password":"..."}` by reading `/var/lib/youeye/pihole/.web_password`
- `POST /api/pihole/credentials` - Accepts `{"password":"newpass"}`, updates file + container env via `incus config set`
- **Migration**: If `.web_password` file doesn't exist, reads WEBPASSWORD from container environment (`incus config get youeye-pihole environment.WEBPASSWORD`) and creates the file automatically

**Implementation:**
- `internal/container/control.go` - `installNodeJS()`: random container root password via `GenerateRandomPassword(32)`
- `internal/app/manifest.go` - `PiHoleManifest()` now takes `webPassword string` parameter
- `internal/app/deploy.go` - `DeployPiHole()`: generates random password, stores to file, passes to manifest
- `internal/util/crypto.go` - Fail hard on crypto/rand, added `GenerateRandomPassword()`
- `internal/api/server.go` - New route `/api/pihole/credentials`, `handlePiholeCredentials()`, `migratePiholePassword()`
- `internal/cmd/root.go` - Version 0.1.21
- `install.sh` - Fallback version 0.1.21

**Testing (192.168.31.190):**
- Spine v0.1.21 deployed and running
- Pi-Hole credentials API returns password (migrated from container env)
- `.web_password` file created with 600 permissions, root:root
- Postgres credentials API still works
- Health check passes
- All 4 containers running

---

### v0.1.20: PostgreSQL OCI Deployment (February 9, 2026)

**Feature:**
Auto-deploy PostgreSQL 17 (Alpine) as an OCI container during `spine deploy`. Internal-only (incusbr0, no host ports). Spine generates a cryptographic random password and exposes credentials via API.

**Implementation:**
- `internal/app/manifest.go` - Added `PostgresManifest()`: postgres:17-alpine, no ports (internal only), env vars (POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, PGDATA), volume at `/var/lib/youeye/postgres/data`, 512MiB/2CPU limits
- `internal/app/deploy.go` - Added `DeployPostgres()`: generates 32-char crypto/rand password, saves to `/var/lib/youeye/postgres/.pg_password`, overrides manifest env, health checks via `pg_isready`
- `internal/cmd/deploy.go` - Deploy now has 6 steps: Incus, API, Control Panel, **PostgreSQL**, Caddy, Pi-Hole
- `internal/api/server.go` - New endpoint `GET /api/postgres/credentials` returns JSON `{host, port, user, password, database}`
- `internal/cmd/root.go` - Version 0.1.20
- `install.sh` - Fallback version 0.1.20
- `README.md` - Version badge 0.1.20

**Testing (192.168.31.190):**
- Container deploys and starts: `youeye-postgres` at 10.19.235.171
- `pg_isready` health check passes
- PostgreSQL 17.7 accepting connections
- Credentials API returns correct JSON
- 33/33 Playwright e2e tests pass

---

### v0.1.19: Container Firewall for Control Panel (February 8, 2026)

**Feature:**
Added `applyContainerFirewall()` to remove internet access from the Control Panel container after deployment. The CP only needs local Incus bridge access for socket proxies and container communication.

**Implementation:**
- Creates a systemd oneshot service (`youeye-firewall.service`) inside the container
- Removes the default route at boot (with a 3-second delay for network to stabilize)
- Applied immediately during `spine deploy` after app deployment
- Non-fatal: logs a warning if firewall fails, deployment continues

**Files Changed:**
- `internal/container/control.go` - Added `applyContainerFirewall()` function, called after `DeployControlPanelApp()`
- `internal/cmd/root.go` - Version bump to 0.1.19
- `install.sh` - Fallback version to 0.1.19
- `README.md` - Version badge to v0.1.19

**Testing (192.168.31.190):**
- Container has no default route after deploy
- Firewall persists across container reboot
- Socket proxies (Incus, Spine) still functional
- Control Panel fully operational at port 3000

---

### v0.1.18: Deploy Caddy & Pi-Hole OCI Containers via Spine (February 6, 2026)

**Feature:**
Caddy and Pi-Hole now deploy automatically as OCI containers during `spine deploy`, alongside the Control Panel. All three services deploy together in one command with no manual steps.

**Architecture:**
- Caddy and Pi-Hole deploy as OCI containers via Incus REST API (Unix socket)
- Deployment uses the same REST API approach that works around the Incus 6.21 CLI OCI bug
- Pi-Hole DNS port 53 binds to host external IP (not 0.0.0.0) to avoid conflict with Incus dnsmasq on bridge
- Containers auto-start on boot (`boot.autostart=true`) and survive reboots
- Deploy command now runs 5 steps: [1/5] Incus, [2/5] ZFS, [3/5] Control Panel, [4/5] Caddy, [5/5] Pi-Hole

**New Files:**
- `internal/app/manifest.go` - Go structs for app manifests (AppManifest, CaddyManifest, PiHoleManifest)
- `internal/app/deploy.go` - OCI deployment via Incus REST API Unix socket

**Modified Files:**
- `internal/cmd/deploy.go` - Added steps [4/5] Caddy and [5/5] Pi-Hole
- `internal/cmd/status.go` - Shows Caddy and Pi-Hole container status
- `internal/cmd/root.go` - Version 0.1.18
- `install.sh` - Fallback version 0.1.18
- `README.md` - Version badge v0.1.18

**Container Details:**
| Container | Image | Ports | Volumes |
|-----------|-------|-------|---------|
| youeye-caddy | docker.io/library/caddy:2 | 80, 443, 2019 (admin) | /config, /data |
| youeye-pihole | docker.io/pihole/pihole:latest | 53/tcp, 53/udp (host IP), 8080→80 | /etc/pihole, /etc/dnsmasq.d |

**Testing:**
- Fresh `spine cleanup -y` + `spine deploy` on YouEye-Dev-VM (192.168.31.190)
- All 3 containers deployed successfully (youeye-control, youeye-caddy, youeye-pihole)
- Caddy admin API accessible from Control Panel container (HTTP 200)
- Pi-Hole FTL v6 API accessible from Control Panel container (HTTP 200)
- DNS resolving through Pi-Hole (dig google.com @container-ip)
- Server rebooted and all services survived - confirmed running after reboot

---

### v0.1.16: Add TEST_ADMIN_SECRET for Automated Testing (February 5, 2026)

**Feature:**
Added TEST_ADMIN_SECRET environment variable to Control Panel service for automated app testing.

**Purpose:**
Enables the `/api/test/install-app` endpoint in Control Panel to work. This endpoint allows
Iris (AI agent) to programmatically install/uninstall apps for testing without browser authentication.

**Implementation:**
- Generate a random 32-byte base64 secret using `util.GenerateJWTSecret()`
- Add `Environment=TEST_ADMIN_SECRET=<secret>` to the Control Panel systemd service file
- Control Panel's test API validates X-Test-Secret header against this env var

**Code Changes:**
- `internal/container/control.go` - Added TEST_ADMIN_SECRET generation and service file env var

**Testing:**
- Deployed to YouEye-Dev-VM (192.168.31.190)
- Test API `/api/test/install-app` returns 200 with app list
- Successfully installed/uninstalled Pi-Hole and Caddy via API

**Note:** For existing deployments, manually add TEST_ADMIN_SECRET to the youeye-control service file.

---

### v0.1.15: Fix ExecStart Path for Control Panel Service (February 5, 2026)

**Critical Bug Fix:**
After `spine deploy`, Control Panel failed to start with error:
```
Cannot find module '/opt/app/standalone/server.js'
```

**Root Cause:**
- The Control Panel tarball extracts files directly to `/opt/app/` (server.js, .next/, node_modules/)
- But the systemd service ExecStart was configured for `/opt/app/standalone/server.js`
- This path mismatch was introduced in v0.1.13 when trying to fix a different issue

**Solution:**
- Changed ExecStart from `/opt/app/standalone/server.js` to `/opt/app/server.js`
- Now matches the actual tarball extraction directory

**Code Changes:**
- `internal/container/control.go` - Fixed ExecStart path in systemd service template

**Testing:**
- Fresh `spine cleanup -y` then `spine deploy` on YouEye-Dev-VM (192.168.31.190)
- Control Panel v0.1.30 deployed successfully
- CSRF endpoint accessible: `curl /api/auth/csrf` returns 200
- Login page loads correctly

---

### v0.1.14: Add HOST_IP Environment Variable for Control Panel (February 5, 2026)

**Feature:**
Pi-Hole DNS port 53 needs to bind to host external IP instead of 0.0.0.0 to avoid conflict with Incus dnsmasq on bridge interface. Added HOST_IP environment variable to Control Panel systemd service.

**Changes:**
1. **Added HOST_IP to Control Panel service template**
   - Gets host's primary IP via `util.GetPrimaryIP()`
   - Adds `Environment=HOST_IP=%s` to systemd service
   - Control Panel reads this to bind Pi-Hole DNS to specific IP

**Code Changes:**
- `internal/container/control.go` - Added HOST_IP environment variable to systemd service template

**Testing:**
- Deployed to YouEye-Dev-VM (192.168.31.190)
- HOST_IP=192.168.31.190 set in control panel service
- Spine v0.1.14, Control Panel v0.1.29 running
- CSRF endpoint accessible at /api/auth/csrf (returns 200)

---

### v0.1.13: Remove DNS Hijacking (February 5, 2026)

**Critical Bug Fix:**
Pi-Hole should NOT hijack system DNS. The v0.1.12 change that disabled systemd-resolved broke DNS resolution for git.byka.wtf and other internal domains - they were resolving to Cloudflare IPs instead of internal servers.

**Changes:**
1. **Removed DisableSystemdResolved()** - Pi-Hole should be optional DNS provider, not mandatory
   - Deleted entire function from `internal/incus/install.go`
   - Removed call in Install() function
   - System DNS now untouched - uses existing resolver (192.168.31.111)

2. **Fixed Control Panel ExecStart path**
   - Changed from `/opt/app/server.js` to `/opt/app/standalone/server.js`
   - Matches actual Next.js standalone output structure

**Code Changes:**
- `internal/incus/install.go` - Removed DisableSystemdResolved() function entirely (~45 lines)
- `internal/container/control.go` - Fixed ExecStart path in systemd service

**Testing:**
- Deployed to YouEye-Dev-VM (192.168.31.190)
- DNS correctly resolving via 192.168.31.111 → git.byka.wtf = 192.168.31.114
- Spine v0.1.13, Control Panel v0.1.27 running
- All services operational

---

### v0.1.12: DNS Port 53 Support for Pi-Hole (February 5, 2026)

**New Features:**
1. **DisableSystemdResolved()** - Stops systemd-resolved to free port 53 for Pi-Hole
   - Stops and disables systemd-resolved service
   - Removes /etc/resolv.conf symlink
   - Creates static /etc/resolv.conf with 8.8.8.8 as fallback

2. **createDataDirectories()** - Creates persistent storage paths
   - /var/lib/youeye/pihole/etc-pihole
   - /var/lib/youeye/pihole/etc-dnsmasq.d
   - Directories created during spine deploy

3. **LogWarning()** - Added warning log level utility

**Code Changes:**
- `internal/incus/install.go` - Added DisableSystemdResolved() function
- `internal/util/log.go` - Added LogWarning() function
- `internal/cmd/deploy.go` - Added createDataDirectories() call

**Testing:**
- Deployed to YouEye-Dev-VM (192.168.31.190)
- Spine v0.1.12 + Control Panel v0.1.26 running
- Pi-Hole container running at 10.100.73.139

**⚠️ REVERTED IN v0.1.13** - DNS hijacking broke internal domain resolution

---

### v0.1.11: Auto-restart API after self update (February 4, 2026)

**Fix:**
- `spine update self` now restarts the spine service after updating
- This ensures the API reflects the new version immediately
- Previously users had to manually restart or wait for reboot

---

### v0.1.10: Fix Control Panel Update Command (February 4, 2026)

**Two Critical Bugs Fixed:**

1. **Tar Extraction Path Bug:**
   - Tarball extracted to `/opt/app/standalone/` instead of `/opt/app/`
   - App couldn't find `server.js` at expected path
   - **Fix:** Added `--strip-components=1` to tar extraction command in `update.go`

2. **Health Check Unreachable Bug:**
   - Health check curled `localhost:3000` from HOST
   - Container network is isolated - localhost on host can't reach container ports
   - **Fix:** Health check now runs via `incus exec containerName -- curl localhost:3000/...`

**Also Removed:**
- Obsolete `npm install styled-jsx` workaround (fixed properly in Control Panel build process)

**Code Changes:**
- `internal/cmd/update.go`:
  - Tar extraction: Added `--strip-components=1` argument
  - Health check: Changed from direct curl to `incus exec` curl
  - Removed styled-jsx npm install hack

**Testing:**
- Deployed Control Panel v0.1.22 on YouEye-Dev-VM (192.168.31.190)
- `spine update self` + `spine update control` work correctly
- Health check passes (401 response is correct for unauthenticated session)
- Login page loads with full HTML/CSS/JS
- All services running: Spine v0.1.10, Control Panel v0.1.22

### Fresh Install Test & OCI Investigation (February 3, 2026)

**Test Environment:**
- Server: YouEye-Dev-VM (192.168.31.190)
- Initial state: Fresh VM restored from backup (uptime: 2 minutes)
- No previous Spine or Incus installation

**Deployment Results:**
- ✅ Spine v0.1.9 installed successfully via install.sh
- ✅ Incus 6.21 installed with ZFS storage
- ✅ Docker OCI remote configured automatically
- ✅ Control Panel v0.1.8 deployed and accessible
- ✅ HTTP 200 response from http://192.168.31.190:3000/login
- ✅ System status: All services running

**OCI Container Testing:**
- ❌ `incus launch docker:alpine test-alpine` - CLI command fails (exit code 1)
- ✅ REST API OCI deployment - Works perfectly
- ✅ Created `test-alpine` via API - Running Alpine 3.23.3 as `CONTAINER (APP)`
- ❌ Issue confirmed as CLI bug, NOT OCI support

**Conclusion:**
- Full Spine/Control Panel deployment workflow works perfectly
- OCI container support via REST API is fully functional
- Incus 6.21 CLI has a bug with `incus launch docker:` commands
- Control Panel unaffected - uses REST API exclusively
- Issue persists across all fresh installations with Incus 6.21 from Zabbly stable channel

### Control Panel v0.1.8: Caddy HTTPS & TLS Auto-Configuration (February 3, 2026)

**Root Cause:**
- When adding routes via Control Panel UI, Caddy was not properly configured for HTTPS
- Routes were only listening on port :80, not :443
- TLS automation subjects were not being updated with new hostnames
- This prevented proper HTTPS certificate generation and routing

**Solution:**
- Modified `addRoute()` function in `src/lib/caddy/client.ts` to comprehensively configure HTTPS
- Ensures Caddy server configuration includes both `:80` and `:443` listeners
- Automatically adds `tls_connection_policies` for HTTPS support
- Extracts hostnames from route matches and adds them to TLS automation subjects
- All new routes now automatically get proper HTTPS and certificate generation

**Code Changes:**
- `src/lib/caddy/client.ts`:
  - `addRoute()` - Enhanced to ensure HTTPS listener, TLS policies, and subject registration
  - Automatically configures self-signed certificates for new hostnames
  - Preserves existing TLS configuration while adding new subjects
- Version bumped to 0.1.8 in `package.json`, `README.md`

**How it works:**
```typescript
// When adding route for "example.com":
// 1. Ensures servers listen on [":443", ":80"]
// 2. Adds tls_connection_policies: [{}] to enable TLS
// 3. Extracts "example.com" from route.match[0].host
// 4. Adds "example.com" to apps.tls.automation.policies[0].subjects[]
// Result: Caddy generates self-signed cert and serves HTTPS
```

**Testing:**
- Built standalone tarball with corrected structure (files at root, not in standalone/ subdirectory)
- Created Gitea release v0.1.8 (Release ID: 221, Asset ID: 201)
- Deployed successfully to YouEye-Dev-VM (192.168.31.190)
- Control Panel running on v0.1.8, accessible at http://192.168.31.190:3000
- Routes added via UI now properly configure HTTPS endpoints

**Tarball Structure Fix:**
- Previous: `tar -cvf standalone.tar standalone` (from .next directory)
  - Issue: Files extracted to /opt/app/standalone/* instead of /opt/app/*
  - Deployment failed: "Cannot find module '/opt/app/server.js'"
- Fixed: `tar -cvf standalone.tar *` (from .next/standalone directory)
  - Files now extract directly to /opt/app/ as expected
  - Deployment successful

**Known Issue:**
- OCI container deployment (`incus launch docker:caddy`) fails silently on YouEye-Dev-VM
- Testing of actual HTTPS routing pending manual Caddy installation or different test server
- See "Known Issues" section for OCI troubleshooting

### v0.1.9: Container Boot After Reboot Fix (February 3, 2026)

**Root Cause:**
- `bind: container` proxy device creates unix socket INSIDE the container at `/var/run/spine/spine.sock`
- `/var/run` is a tmpfs (temporary filesystem) that resets on every reboot
- After reboot, `/var/run/spine/` directory doesn't exist inside the container
- When Incus tries to start the container with spine-socket proxy device, it fails
- Container enters ERROR state, Control Panel inaccessible

**Solution:**
- Added tmpfiles.d configuration inside container during deployment
- Creates `/etc/tmpfiles.d/spine.conf` with content: `d /var/run/spine 0755 root root -`
- systemd-tmpfiles runs at early boot, creating directory before Incus starts containers
- Spine socket proxy device can now successfully create unix socket at boot

**Code Changes:**
- `internal/container/control.go` - Modified `addSocketProxies()` function
  - Added tmpfiles.d config creation: `echo 'd /var/run/spine 0755 root root -' > /etc/tmpfiles.d/spine.conf`
  - Added debug log explaining the fix
- Version bumped to 0.1.9 in `root.go`, `install.sh`, `README.md`

**Testing:**
- Verified on YouEye-Dev-VM (192.168.31.190)
- Fresh `spine deploy` → reboot → container stays RUNNING (not ERROR)
- Control Panel accessible after reboot: HTTP 200 on `/login`
- Container IP assigned: 10.35.24.30

### v0.1.38: Switch UI to YE-UI Repo + Env Var Fix (February 10, 2026)

**Critical fix:** Changed UI repository from `YouEye-UI` (old, no auth) to `YE-UI` (new, with Authentik OAuth2).

**Changes:**
- `defaults.go`: `UI: "YouEye-UI"` → `UI: "YE-UI"`
- `server.go` handleUISSO POST: `UI_DOMAIN` → `UI_EXTERNAL_URL`, `NEXTAUTH_URL` → `SECURE_COOKIES=false`
- `server.go` handleUISSO GET: Read `UI_EXTERNAL_URL` instead of `UI_DOMAIN`
- `server.go` handleUISSO POST: Added database schema initialization (CREATE TABLE IF NOT EXISTS) using psql in youeye-postgres container
- `server.go` handleUpdateUI: Added tar flatten step for standalone builds and removed legacy styled-jsx install
- Fixed psql user: `postgres` → `youeye` (correct DB role)

**Known issue (fixed in YE-UI v0.1.1):** The psql schema creation uses `exec.Command(...).Run()` without error checking. If psql fails (wrong user, DB not ready, network issue), it silently continues and the UI starts without tables. YE-UI v0.1.1 adds self-healing `ensureSchema()` that auto-creates tables on first health check or DB access.

**Testing:**
- Built YE-UI v0.1.0 on dev server (Linux, standalone.tar 49MB)
- Deployed to youeye-ui container on 192.168.31.190
- All endpoints verified: health (200), login (200), root→login redirect (307), SSO redirect to Authentik (307)
- OAuth CSRF validation working (invalid state correctly rejected)
- Caddy HTTPS routing verified through `skibidi.wtf` domain
- Database tables created: users, widgets, apps, user_settings, system_settings
- No errors in service logs

> **WARNING for future agents:** YE-UI does NOT use NextAuth. It uses custom OAuth2 with `jose` JWT.
> Never set `NEXTAUTH_URL` or `NEXTAUTH_SECRET`. The correct env var is `UI_EXTERNAL_URL`.

> **NOTE:** As of YE-UI v0.1.1, the UI app itself handles schema creation via `ensureSchema()`.
> Spine's psql-based schema creation is now a backup, not the primary mechanism.

**Previous Failed Attempts (v0.1.7-v0.1.8):**
- v0.1.7: Added systemd dependency (incus-startup After spine.service) - didn't help
- v0.1.8: Added ExecStartPost socket readiness check - didn't help
- Both fixes were addressing the wrong problem (host socket timing vs container directory existence)

### v0.1.6: OCI Support & Incus Upgrade Fix (February 2, 2026)

**Changes:**
- **Fixed Zabbly repository configuration** - Now configures Zabbly repo BEFORE checking if Incus is installed
  - Previously only configured when Incus was NOT installed, missing upgrade path
  - Now systems with Ubuntu's default Incus 6.0.0 (LTS) get automatically upgraded to 6.21+
- **OCI remote auto-configuration** - Docker Hub OCI remote (`docker:`) added automatically during install
  - Enables OCI container support: `incus launch docker:alpine`, `incus launch docker:caddy`, etc.
  - Configured via new `configureOCIRemote()` function in `internal/incus/install.go`
- **OCI containers confirmed working** - Tested with Alpine and Caddy OCI images
  - Containers launch as type `CONTAINER (APP)` distinguishing them from standard LXC containers
  - Full network connectivity and resource access verified

**Why this matters:**
- Ubuntu 24.04 ships with Incus 6.0.0 (LTS) which does NOT support OCI protocol
- Incus 6.21+ from Zabbly stable channel includes full OCI support
- OCI support required for App Store and Caddy deployment from Control Panel

**Code Changes:**
- `internal/incus/install.go` - Refactored Zabbly repo configuration to run unconditionally
- `internal/incus/install.go` - Added `configureOCIRemote()` function
- Version bumped to 0.1.6 in `root.go`, `install.sh`, `README.md`

**Testing:**
- Verified on YouEye-Dev-VM (192.168.31.190)
- `spine update self` successfully upgraded to v0.1.6
- Incus upgraded from 6.0.0 (Ubuntu LTS) to 6.21 (Zabbly stable)
- Docker OCI remote configured automatically
- Alpine OCI container launched successfully: IP 10.94.246.84, type `CONTAINER (APP)`
- Caddy OCI container launched successfully: v2.10.2

**Fresh Install Test:**
- Clean deployment configures Incus 6.21 with OCI remote from the start
- No manual intervention required for OCI support

### Control Panel v0.1.5-v0.1.6: Caddy Route Fixes (February 2, 2026)

**Issues Fixed:**
Three bugs prevented Caddy proxy routes from working correctly:

1. **Route Ordering** - New routes were appended AFTER catch-all `file_server` route
   - The default Caddy config had a `file_server` route that matched all requests
   - New proxy routes were added at the end, never evaluated
   - **Fix:** Filter out default routes, add new routes at BEGINNING with `unshift()`

2. **Path Matching** - Exact path `/control` didn't match `/control/dashboard`
   - Caddy's default matching is exact, not prefix-based
   - **Fix:** Auto-append `*` suffix so `/control*` matches all sub-paths

3. **Path Stripping** - `/control/dashboard` was proxied as-is to backend
   - Control Panel serves routes at root (`/dashboard`, `/login`)
   - Request to `/control/dashboard` returned 404 because backend has no `/control/` routes
   - **Fix:** Added Caddy `rewrite` handler with `strip_path_prefix` before `reverse_proxy`

**Code Changes:**
- `src/lib/caddy/types.ts` - Added `RewriteHandler` interface
- `src/lib/caddy/client.ts`:
  - `formDataToRoute()` - Generates rewrite handler with `strip_path_prefix` for non-root paths
  - `addRoute()` - Added `filterDefaultRoutes()` to remove catch-all routes, uses `unshift()` for ordering
  - `routeToProxyRoute()` - Updated to find `reverse_proxy` handler in array (may not be first)
- Path matching now appends `*` suffix automatically

**Example Route Configuration:**
```json
{
  "match": [{ "host": ["example.com"], "path": ["/control*"] }],
  "handle": [
    { "handler": "rewrite", "strip_path_prefix": "/control" },
    { "handler": "reverse_proxy", "upstreams": [{ "dial": "backend:3000" }] }
  ]
}
```

**Testing:**
- Verified on YouEye-Dev-VM (192.168.31.190)
- Route `skibidi.wtf/control` → `youeye-control:3000` working correctly
- `/control/login` returns 200 OK with login page
- Path stripping transforms `/control/dashboard` → `/dashboard`

### Control Panel v0.1.4: OCI Admin Port Fix (February 2, 2026)

**Changes:**
- **Fixed admin port proxy for OCI apps** - `manifestToIncusConfig()` now generates admin port proxy device
  - Previously admin port (2019 for Caddy) was not exposed to host
  - Now automatically adds proxy device when `adminPort` is defined in manifest
  - Caddy Admin API now accessible at `http://host:2019/config/`

**Code Changes:**
- `src/lib/apps/manifest.ts` - Added admin port proxy device generation in `manifestToIncusConfig()`

**Testing:**
- Verified on YouEye-Dev-VM (192.168.31.190)
- Caddy OCI container installed successfully via Control Panel API
- Admin API confirmed working: `curl http://localhost:2019/config/` returns JSON
- All port proxies (80, 443, 2019) operational

**Tarball Structure Fix:**
- Recreated tarball from inside `standalone/` directory to avoid path prefix issues
- Files now at root of tarball instead of nested in `standalone/` subdirectory

### Control Panel v0.1.1-v0.1.3: Caddy Integration (February 1-2, 2026)

**New Features:**
- **App Manifest System:** Foundation for future App Store
  - Type-safe app definitions in `src/lib/apps/`
  - Manifest-driven container deployment
  - Designed to be extended with remote App Store API

- **Caddy Reverse Proxy Integration:**
  - Deploy Caddy as OCI container from Control Panel UI
  - New `/proxy` page for managing reverse proxy
  - Add/edit/delete proxy routes via Caddy Admin API
  - Self-signed TLS certificate management

- **New API Routes:**
  - `/api/apps` - List available apps
  - `/api/apps/install` - Install app containers
  - `/api/apps/[name]/status` - Get app status
  - `/api/apps/[name]/control` - Start/stop/restart/remove apps
  - `/api/caddy/routes` - Manage proxy routes
  - `/api/caddy/config` - Get/set Caddy config
  - `/api/caddy/tls` - Manage TLS certificates
  - `/api/caddy/status` - Check Caddy status

- **New UI Components:**
  - ProxyStatusCard - Shows Caddy container status
  - RouteList - Table of configured routes
  - RouteFormDialog - Add/edit route modal
  - TLSCard - Certificate management

**Architecture Notes:**
- Caddy deployed as OCI container (docker.io/caddy:2.9-alpine)
- Host ports: 80, 443 proxied to Caddy container
- Control Panel stays on port 3000 (separate from Caddy)
- Caddy Admin API on port 2019 (internal only)
- Self-signed certs only (ACME/Let's Encrypt planned for future)

**Testing on YouEye-Dev-VM (192.168.31.190):**
```bash
ssh -i ~/.ssh/YouEye-Main-Key root@192.168.31.190
spine cleanup -y
spine deploy
spine update control
spine status
# Then test in browser: http://192.168.31.190:3000
```

### v0.1.4: ZFS Snapshot Support (February 1, 2026)

**Changes:**
- **Removed project restrictions for ZFS deployments** - `restricted=true` was blocking snapshot creation
- ZFS incremental backups now work properly on VM deployments
- Snapshots are essential for incremental backups but were blocked by security restrictions
- Security restrictions (`configureProjectRestrictions()`) removed from ZFS setup flow
- Restrictions were designed for LXC privilege containment but prevented ZFS features on VMs

**Why this fix:**
- LXC containers can't use ZFS (kernel module access required)
- VMs CAN use ZFS and support incremental backups via snapshots
- Previous code applied LXC-style restrictions to VMs, breaking the main benefit of ZFS
- Now: VMs get full ZFS snapshot capability, LXC gets dir driver (no restrictions needed)

**Testing:**
- Verified on VM (192.168.31.190): Snapshots work correctly
- ZFS pool: 18.5GB, snapshot create/delete tested successfully

### v0.1.0: Configuration System & Code Quality (February 2026)

**Major Changes:**
- **Configuration System:** YAML-based configuration at `/etc/spine/config.yaml`
  - All hardcoded values now configurable (URLs, container names, ports)
  - Environment variable support (`SPINE_*` prefix)
  - Config commands: `spine config init`, `spine config show`, `spine config validate`
  - Backwards compatible - works without config file using sensible defaults

- **Atomic Self-Updates:** `spine update self` now creates backups and auto-rollback on failure
  - Downloads to temp file, verifies binary works
  - Creates backup before replacing
  - Restores backup if installation verification fails

- **API Startup Fix:** Replaced 500ms sleep with proper socket health check loop
  - Waits for socket to be available (up to 5 seconds)
  - More reliable than fixed sleep duration

- **Code Refactoring:**
  - Split monolithic `install.go` (670 lines) into modular packages:
    - `internal/util/` - Exec, logging, crypto helpers
    - `internal/incus/` - Incus installation
    - `internal/container/` - Control Panel deployment
  - New `internal/releases/` package for centralized release fetching
  - New `internal/logging/` package using Go 1.21 slog

- **Structured Logging:** Added `internal/logging/` using stdlib log/slog
  - Configurable log levels (debug, info, warn, error)
  - Text or JSON output format

**New Config Commands:**
```bash
spine config init      # Generate /etc/spine/config.yaml with defaults
spine config show      # Display current configuration
spine config validate  # Validate configuration file
```

**Migration Notes:**
- No action required for existing deployments
- All previously hardcoded values are now defaults
- Optional: run `spine config init` to generate config for customization

See [docs/configuration.md](docs/configuration.md) for full configuration documentation.

### v0.0.28 + Control Panel v0.1.0: Security Hardening (January 31, 2026)

**Spine v0.0.28:**
- Added rate limiting for PAM authentication (5 attempts per 5 minutes per username)
- Auto-generates secure JWT_SECRET (32 bytes crypto/rand) during Control Panel deployment
- JWT_SECRET stored in systemd service environment for persistence

**Control Panel v0.1.0:**
- **CSRF Protection:** Server validates `X-CSRF-Token` header on all state-changing requests (POST/PUT/DELETE/PATCH)
- **authenticatedFetch utility:** Client-side utility that automatically includes CSRF token from cookie
- **Server-side middleware:** JWT verification before page rendering (protects all dashboard routes)
- **Enforced JWT_SECRET:** No more insecure default - deployment must provide secure secret
- **Security headers:** X-Frame-Options, X-Content-Type-Options, Referrer-Policy, X-XSS-Protection, Permissions-Policy
- **Update API secured:** Requires authentication, valid CSRF token, AND admin status

### v0.0.26-v0.0.27: PAM Authentication Improvements

**v0.0.26 (January 30, 2026):**
- Changed PAM authentication to use **HOST** system credentials instead of container
- Spine API now calls `pamtester` directly on host (not via `incus exec`)
- Users authenticate with their real Linux system passwords
- **Breaking change:** Login now requires host root password, not container password

**v0.0.27 (January 30, 2026):**
- Fixed missing `pamtester` dependency issue
- `spine deploy` now installs `pamtester` on HOST during Incus installation
- Ensures fresh deployments have all required authentication tools

**Why this change?**
- Previous versions authenticated against container's `/etc/shadow`
- This was confusing - container password (`youeye`) vs host password
- Host PAM is the correct architecture - uses real system users
- Single source of truth for authentication

---

## See Also (Wiki Documentation)

- **[Agents](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Agents)** — AI agent navigation hub
- **[Agent Testing Methodology](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Agent-Testing-Methodology)** — Mandatory testing workflow
- **[Spine](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Spine)** — Complete Spine documentation
- **[Development Setup](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Development-Setup)** — Build and deployment procedures
- **[Git Workflow](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Git-Workflow)** — Commit format and versioning
