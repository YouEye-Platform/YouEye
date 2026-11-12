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

The seed runs these commands itself: `appliance prepare`, `recovery`, `spine …`, `version` and help. For every other
command (the API service, `boot …`, `update …`) it execs the booted slot's Spine: an unconfirmed **trial** while it
has start attempts left (three API starts), else **current**, else **previous**, else itself. A slot without a
record runs the seed — a fresh install, a factory reset, or the other slot after an A/B rollback finds its own
choice untouched.

A selected Spine is used only if its payload matches its digest, is not group- or world-writable, and declares the
same `disk_layout` and `helper_contract` as the running source supports; otherwise the launcher logs why and falls
back. No other identity binds Spine to the image: everything that used to require "the running Spine equals the
image's release set" now requires "the running Spine is the seed or this slot's selected Spine".

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
