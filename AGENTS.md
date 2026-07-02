## v0.5.2 — artem — 2026-07-02
**Branch:** main
**VM:** potempc
**Agent:** Artem
**Task:** Add Proxmox VM guest ZFS data disk provisioning to the installer

### Changes
- `installer/internal/installer/provider_proxmox.go` — creates a second VM disk, installs OpenZFS in the guest, and creates a `default` zpool for Spine/Incus to reuse.
- `installer/internal/installer/options.go` — bumps installer to 0.5.2 and adds `--incus-zfs-disk` with `0` as the explicit fallback-disable value.
- `installer/internal/installer/wizard.go` — exposes the Incus ZFS disk size in VM resources and confirmation.
- `installer/internal/installer/proxmox_storage_test.go` — covers the new default, override, disable path, and guest setup script invariants.
- `README.md`, `docs/getting-started.md` — document the Proxmox two-disk VM layout and current installer release.

### Test Results
- Go tests: installer package test suite

### Notes for Iris
- Main-branch owner-requested hotfix. Existing Proxmox `--disk` remains the OS disk; the new `--incus-zfs-disk` controls the dedicated Incus ZFS data disk.
