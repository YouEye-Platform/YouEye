package cmd

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

var cleanupYes bool
var cleanupKeepData bool

var cleanupCmd = &cobra.Command{
	Use:   "cleanup",
	Short: "Completely remove Incus and all containers",
	Long: `Completely wipe Incus installation including:
- All running and stopped containers
- All storage pools
- All networks
- All Incus packages
- All data in /var/lib/incus
- All YouEye app data in /var/lib/youeye (unless --keep-data is used)

This action CANNOT be undone!

Use -y or --yes to skip confirmation prompt.
Use --keep-data to preserve app data (PostgreSQL, Authentik, etc.)`,
	RunE: func(cmd *cobra.Command, args []string) error {
		return runCleanup()
	},
}

func init() {
	cleanupCmd.Flags().BoolVarP(&cleanupYes, "yes", "y", false, "Skip confirmation prompt")
	cleanupCmd.Flags().BoolVar(&cleanupKeepData, "keep-data", false, "Preserve /var/lib/youeye app data")
}

func runCleanup() error {
	fmt.Println("=== Spine Cleanup ===")
	fmt.Println()

	// Check if Incus is installed
	if _, err := exec.LookPath("incus"); err != nil {
		fmt.Println("Incus is not installed. Nothing to clean up.")
		return nil
	}

	// Gather info about what will be deleted
	containers := getContainerList()
	runningCount := 0
	stoppedCount := 0
	for _, c := range containers {
		if c.running {
			runningCount++
		} else {
			stoppedCount++
		}
	}

	storagePools := getStoragePools()
	networks := getNetworks()

	// If nothing to clean
	if len(containers) == 0 && len(storagePools) == 0 && len(networks) == 0 {
		fmt.Println("No Incus resources found.")
		fmt.Println()
		fmt.Println("Uninstalling Incus packages...")
		if err := uninstallIncusPackages(); err != nil {
			fmt.Printf("Warning: %v\n", err)
		}
		fmt.Println()
		fmt.Println("✓ Cleanup complete!")
		return nil
	}

	// Show what will be deleted
	fmt.Println("⚠️  WARNING: This will DELETE EVERYTHING")
	fmt.Println()
	fmt.Println("The following will be permanently removed:")
	if runningCount > 0 {
		fmt.Printf("  - %d running container(s)\n", runningCount)
	}
	if stoppedCount > 0 {
		fmt.Printf("  - %d stopped container(s)\n", stoppedCount)
	}
	if len(containers) > 0 {
		names := make([]string, len(containers))
		for i, c := range containers {
			names[i] = c.name
		}
		fmt.Printf("    Containers: %s\n", strings.Join(names, ", "))
	}
	if len(storagePools) > 0 {
		fmt.Printf("  - %d storage pool(s): %s\n", len(storagePools), strings.Join(storagePools, ", "))
	}
	if len(networks) > 0 {
		fmt.Printf("  - %d network(s): %s\n", len(networks), strings.Join(networks, ", "))
	}
	fmt.Println("  - All Incus packages")
	fmt.Println("  - All data in /var/lib/incus")
	if !cleanupKeepData {
		fmt.Println("  - All YouEye app data in /var/lib/youeye")
	} else {
		fmt.Println("  - App data in /var/lib/youeye will be PRESERVED (--keep-data)")
	}
	fmt.Println()
	fmt.Println("This action CANNOT be undone!")
	fmt.Println()

	// Ask for confirmation unless -y flag
	if !cleanupYes {
		fmt.Print("Do you want to continue? [y/N]: ")
		reader := bufio.NewReader(os.Stdin)
		response, _ := reader.ReadString('\n')
		response = strings.TrimSpace(strings.ToLower(response))
		if response != "y" && response != "yes" {
			fmt.Println("Cleanup cancelled.")
			return nil
		}
		fmt.Println()
	}

	// Execute cleanup
	// Base steps: 11 + 6 new (bridge, nft, /run/incus, apt, zfs, runtime).
	// Step 11 (remove /var/lib/youeye) is skipped with --keep-data.
	//
	// BUG-007 (sebastian-v0.2.18.9): the v0.2.18.1 cleanup also removed the
	// `youeye` system user via pkill -u + userdel -r. This was wrong — the
	// `youeye` user is created by VM provisioning (Proxmox template, manual
	// adduser, etc.), NOT by Spine. There is no `useradd youeye` anywhere
	// in the Spine codebase. Spine has no business removing a user it
	// didn't create. The step has been deleted; total step count went
	// 18 → 17 (and 17 → 16 with --keep-data).
	totalSteps := 17
	if cleanupKeepData {
		totalSteps = 16
	}
	step := 0

	// Kill any running Spine API processes first
	exec.Command("pkill", "-9", "-f", "spine api serve").Run()

	// Step 1: Stop all containers
	step++
	fmt.Printf("[%d/%d] Stopping all containers...\n", step, totalSteps)
	for _, c := range containers {
		if c.running {
			exec.Command("incus", "stop", c.name, "--force").Run()
		}
	}

	// Step 2: Delete all containers
	step++
	fmt.Printf("[%d/%d] Deleting all containers...\n", step, totalSteps)
	deletedContainers := 0
	for _, c := range containers {
		if err := exec.Command("incus", "delete", c.name, "--force").Run(); err == nil {
			deletedContainers++
		}
	}

	// Step 3: Delete storage pools
	step++
	fmt.Printf("[%d/%d] Deleting storage pools...\n", step, totalSteps)
	deletedPools := 0
	for _, pool := range storagePools {
		if err := exec.Command("incus", "storage", "delete", pool).Run(); err == nil {
			deletedPools++
		}
	}

	// Step 4: Delete networks
	step++
	fmt.Printf("[%d/%d] Deleting networks...\n", step, totalSteps)
	deletedNetworks := 0
	for _, net := range networks {
		if err := exec.Command("incus", "network", "delete", net).Run(); err == nil {
			deletedNetworks++
		}
	}

	// Step 5: Kill orphaned Incus forkproxy processes
	// These can survive container deletion and hold ports (e.g. port 80)
	step++
	fmt.Printf("[%d/%d] Killing orphaned Incus proxy processes...\n", step, totalSteps)
	exec.Command("pkill", "-9", "-f", "incusd forkproxy").Run()

	// Step 6: Stop Incus service
	step++
	fmt.Printf("[%d/%d] Stopping Incus service...\n", step, totalSteps)
	exec.Command("systemctl", "stop", "incus").Run()
	exec.Command("systemctl", "stop", "incus.socket").Run()

	// Step 7: Unmount busy filesystems
	// BUG-009 (sebastian-v0.2.18.10): /var/lib/incus/devices is a tmpfs that
	// Incus mounts at runtime. After `apt purge incus` the systemd unit file
	// is gone but the kernel mount table entry survives, leaving the directory
	// open and undeletable. We must lazy-unmount it explicitly before the
	// RemoveAll at step 10. Without this, /var/lib/incus is left as an
	// empty {devices/} stub that proves YouEye was installed.
	step++
	fmt.Printf("[%d/%d] Unmounting filesystems...\n", step, totalSteps)
	exec.Command("umount", "-l", "/var/lib/incus/guestapi").Run()
	exec.Command("umount", "-l", "/var/lib/incus/shmounts").Run()
	exec.Command("umount", "-l", "/var/lib/incus/devices").Run()

	// Step 8: Destroy ZFS pools (if any)
	// This must happen BEFORE removing /var/lib/incus because the ZFS pool
	// may be backed by a loop device file at /var/lib/incus/disks/default.img.
	// If we don't destroy the pool here, the orphaned zpool survives cleanup
	// and prevents re-initialization with ZFS on the next 'spine deploy'.
	step++
	fmt.Printf("[%d/%d] Cleaning up ZFS pools...\n", step, totalSteps)
	destroyZFSPools()

	// Step 9: Uninstall Incus packages
	step++
	fmt.Printf("[%d/%d] Uninstalling Incus packages...\n", step, totalSteps)
	if err := uninstallIncusPackages(); err != nil {
		fmt.Printf("Warning: %v\n", err)
	}
	// BUG-011 (sebastian-v0.2.18.10): after purging units, systemd's in-memory
	// state still has stale references to incus.service / incus-lxcfs.service
	// (showing as "not-found failed" in `systemctl list-units --all`). Clear
	// them so the host has no orphaned unit references after cleanup.
	exec.Command("systemctl", "daemon-reload").Run()
	exec.Command("systemctl", "reset-failed").Run()

	// Step 10: Remove directories
	step++
	fmt.Printf("[%d/%d] Removing Incus directories...\n", step, totalSteps)
	os.RemoveAll("/var/lib/incus")
	os.RemoveAll("/var/log/incus")
	os.RemoveAll("/var/cache/incus")

	// Step 11: Remove YouEye app data (unless --keep-data)
	if !cleanupKeepData {
		step++
		fmt.Printf("[%d/%d] Removing YouEye app data...\n", step, totalSteps)

		// BUG-014 (alisa-v0.2.21.1): preserve release branch config.
		// The branch setting lives at /var/lib/youeye/config/youeye.yaml
		// and is NOT deployment state — it's a user/operator choice about
		// which release channel this VM tracks. Wiping it forces a manual
		// `spine branch set` after every cleanup→deploy cycle.
		//
		// FIXED (iris-v0.3.1.3): only preserve release_branch, not the
		// entire file. Preserving everything (setup_completed, domain,
		// site_name, etc.) caused spine deploy to skip the setup wizard
		// after cleanup because setup_completed was still true.
		var savedBranch string
		if data, err := os.ReadFile(youeyeConfigPath); err == nil {
			var cfg branchConfig
			if err := yaml.Unmarshal(data, &cfg); err == nil && cfg.ReleaseBranch != "" {
				savedBranch = cfg.ReleaseBranch
				fmt.Printf("  Preserving release branch: %s\n", savedBranch)
			}
		}

		os.RemoveAll("/var/lib/youeye")

		// Restore only the release branch
		if savedBranch != "" {
			os.MkdirAll("/var/lib/youeye/config", 0755)
			minimal := fmt.Sprintf("release_branch: %s\n", savedBranch)
			if err := os.WriteFile(youeyeConfigPath, []byte(minimal), 0644); err != nil {
				fmt.Printf("  Warning: could not restore branch config: %v\n", err)
			} else {
				fmt.Println("  ✓ Release branch configuration restored")
			}
		}
	}

	// ── New cleanup steps (sebastian-v0.2.18.1, revised in 0.2.18.9) ────
	// These cover artifacts that the original cleanup left behind. Each
	// step is best-effort and prints whether it actually did anything.
	//
	// In 0.2.18.1 there was a "Remove the youeye system user" step here
	// (BUG-007). It was removed in 0.2.18.9 — the `youeye` user is part
	// of the host's provisioning, not something Spine creates, so Spine
	// has no business removing it.

	// Step 12: Delete the incusbr0 kernel bridge interface.
	step++
	fmt.Printf("[%d/%d] Removing Incus bridge interface...\n", step, totalSteps)
	removeIncusBridge()

	// Step 13: Delete Incus nftables rules.
	step++
	fmt.Printf("[%d/%d] Removing Incus firewall rules...\n", step, totalSteps)
	removeIncusNftables()

	// Step 14: Clean Incus runtime tmpfs directory.
	step++
	fmt.Printf("[%d/%d] Cleaning runtime directories...\n", step, totalSteps)
	if err := os.RemoveAll("/run/incus"); err == nil {
		fmt.Println("  Removed /run/incus")
	} else {
		fmt.Printf("  Could not remove /run/incus: %v\n", err)
	}

	// Step 15: Remove the Incus apt source and GPG key + spine's incus-startup
	// systemd drop-in + residual files left by Incus/dnsmasq/dpkg.
	step++
	fmt.Printf("[%d/%d] Removing Incus apt repository + spine systemd drop-in + residuals...\n", step, totalSteps)
	removeIncusAptRepo()
	// BUG-008 (sebastian-v0.2.18.10): spine deploy adds an incus-startup
	// systemd drop-in (configureIncusStartupDependency in deploy.go) that
	// makes incus-startup wait for spine.service. Cleanup never removed it,
	// leaving the file as a stray "YouEye was here" marker. Remove it now.
	removeSpineIncusStartupDropIn()
	// BUG-015 (alisa-v0.2.21.1): clean residual files that survived cleanup.
	removeResidualFiles()

	// Step 16: Remove ZFS packages installed by spine deploy, but only if
	// no non-Incus zpools exist (otherwise we'd break someone else's setup).
	step++
	fmt.Printf("[%d/%d] Removing ZFS packages...\n", step, totalSteps)
	removeZFSPackages()

	// Step 17: Flush apt's metadata after repo removal so a subsequent
	// `spine deploy` doesn't see stale package indexes.
	step++
	fmt.Printf("[%d/%d] Refreshing apt metadata...\n", step, totalSteps)
	exec.Command("apt-get", "update", "-qq").Run()
	fmt.Println("  apt cache refreshed")

	// Summary
	fmt.Println()
	fmt.Println("✓ Cleanup complete!")
	fmt.Println()
	fmt.Println("Removed:")
	if deletedContainers > 0 {
		fmt.Printf("  - %d container(s)\n", deletedContainers)
	}
	if deletedPools > 0 {
		fmt.Printf("  - %d storage pool(s)\n", deletedPools)
	}
	if deletedNetworks > 0 {
		fmt.Printf("  - %d network(s)\n", deletedNetworks)
	}
	fmt.Println("  - Incus packages (purged)")
	fmt.Println("  - /var/lib/incus")
	if !cleanupKeepData {
		fmt.Println("  - /var/lib/youeye (all app data)")
	}
	fmt.Println("  - incusbr0 bridge")
	fmt.Println("  - Incus nftables rules")
	fmt.Println("  - /run/incus runtime dir")
	fmt.Println("  - Zabbly apt source + GPG key")
	fmt.Println("  - ZFS packages (if installed by spine deploy)")
	fmt.Println()
	fmt.Println("To reinstall, run: spine deploy")

	return nil
}

type containerInfo struct {
	name    string
	running bool
}

func getContainerList() []containerInfo {
	// Get container list in CSV format: name,status
	out, err := exec.Command("incus", "list", "--format", "csv", "-c", "ns").Output()
	if err != nil {
		return nil
	}

	var containers []containerInfo
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}
		parts := strings.Split(line, ",")
		if len(parts) >= 2 {
			containers = append(containers, containerInfo{
				name:    parts[0],
				running: strings.ToUpper(parts[1]) == "RUNNING",
			})
		}
	}
	return containers
}

func getStoragePools() []string {
	out, err := exec.Command("incus", "storage", "list", "--format", "csv", "-c", "n").Output()
	if err != nil {
		return nil
	}

	var pools []string
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for _, line := range lines {
		if line != "" {
			pools = append(pools, line)
		}
	}
	return pools
}

func getNetworks() []string {
	out, err := exec.Command("incus", "network", "list", "--format", "csv", "-c", "n").Output()
	if err != nil {
		return nil
	}

	var networks []string
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for _, line := range lines {
		// Skip managed networks that Incus creates automatically
		if line != "" && !strings.HasPrefix(line, "lo") {
			networks = append(networks, line)
		}
	}
	return networks
}

func uninstallIncusPackages() error {
	// purge (not remove) so config files are deleted too — `remove` leaves
	// dpkg in `rc` state for incus-base and clutters dpkg -l output.
	//
	// `--auto-remove` cleans up dependencies that were pulled in ONLY for
	// these packages. This is the SCOPED form of autoremove — it does NOT
	// remove unrelated auto-marked packages from elsewhere on the system.
	// Without this, a bare `apt-get autoremove` would remove every package
	// across the host that's currently auto-marked but no longer needed,
	// which violates the BUG-007 principle (Spine doesn't remove things
	// it didn't install).
	cmd := exec.Command("apt-get", "purge", "--auto-remove", "-y", "incus", "incus-base", "incus-client")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// removeSpineIncusStartupDropIn removes /etc/systemd/system/incus-startup.service.d/
// spine-dependency.conf and the parent directory if empty. Counterpart to
// configureIncusStartupDependency() in deploy.go. Best-effort.
func removeSpineIncusStartupDropIn() {
	const dropIn = "/etc/systemd/system/incus-startup.service.d/spine-dependency.conf"
	const dropInDir = "/etc/systemd/system/incus-startup.service.d"

	if err := os.Remove(dropIn); err == nil {
		fmt.Println("  Removed /etc/systemd/system/incus-startup.service.d/spine-dependency.conf")
		// rmdir only succeeds if the directory is empty — exactly what we want.
		// If something else is using the .d directory we leave it alone.
		os.Remove(dropInDir)
		// daemon-reload so systemd forgets about the override.
		exec.Command("systemctl", "daemon-reload").Run()
	}
}

// removeIncusBridge deletes the incusbr0 kernel bridge if present.
func removeIncusBridge() {
	if err := exec.Command("ip", "link", "show", "incusbr0").Run(); err != nil {
		fmt.Println("  No incusbr0 bridge found, skipping")
		return
	}
	exec.Command("ip", "link", "set", "incusbr0", "down").Run()
	if err := exec.Command("ip", "link", "delete", "incusbr0").Run(); err != nil {
		fmt.Printf("  Warning: could not delete incusbr0: %v\n", err)
		return
	}
	fmt.Println("  Removed incusbr0 bridge")
}

// removeIncusNftables drops the inet/incus nftables table if present.
func removeIncusNftables() {
	if err := exec.Command("nft", "list", "table", "inet", "incus").Run(); err != nil {
		fmt.Println("  No Incus firewall rules found, skipping")
		return
	}
	if err := exec.Command("nft", "delete", "table", "inet", "incus").Run(); err != nil {
		fmt.Printf("  Warning: could not delete nftables table: %v\n", err)
		return
	}
	fmt.Println("  Removed nftables 'inet incus' table")
}

// removeIncusAptRepo deletes the Zabbly apt source list, GPG key, and the
// cached package indexes that apt downloaded for that source.
//
// BUG-010 (sebastian-v0.2.18.10): even after the .list source file is
// deleted, apt's per-source cache files in /var/lib/apt/lists/ remain
// until `apt-get clean` or explicit removal. Cleanup runs `apt-get update`
// at the end but `update` only refreshes lists for currently-configured
// repos — it doesn't garbage-collect entries for sources that no longer
// exist. So the cached indexes for pkgs.zabbly.com_* are stale leftovers
// with `incus` in the filename that prove YouEye was installed.
func removeIncusAptRepo() {
	removed := false
	if err := os.Remove("/etc/apt/sources.list.d/zabbly-incus-stable.list"); err == nil {
		removed = true
	}
	if err := os.Remove("/etc/apt/keyrings/zabbly.gpg"); err == nil {
		removed = true
	}
	// Also clean apt's cached package indexes for the Zabbly repo.
	if matches, err := filepath.Glob("/var/lib/apt/lists/pkgs.zabbly.com_*"); err == nil {
		for _, m := range matches {
			if err := os.Remove(m); err == nil {
				removed = true
			}
		}
	}
	if removed {
		fmt.Println("  Removed Incus apt source, GPG key, and cached package indexes")
	} else {
		fmt.Println("  No Incus apt source found, skipping")
	}
}

// removeResidualFiles cleans up files that previous cleanup versions missed.
// BUG-015/016/017 (alisa-v0.2.21.1):
//   - /etc/dnsmasq.d/incus — created by Incus bridge dnsmasq
//   - apt archive .deb files — downloaded packages survive purge
//   - dpkg systemd-helper tracker files — interfere with re-enable on redeploy
func removeResidualFiles() {
	removed := false

	// /etc/dnsmasq.d/incus — Incus creates this for bridge DNS
	if err := os.Remove("/etc/dnsmasq.d/incus"); err == nil {
		removed = true
	}
	// Remove the directory too if empty
	os.Remove("/etc/dnsmasq.d")

	// Clean downloaded .deb files from apt cache
	exec.Command("apt-get", "clean").Run()

	// Remove dpkg systemd-helper tracker files for incus/zfs packages.
	// These survive package purge and interfere with systemd service
	// re-enable on the next deploy.
	for _, pattern := range []string{
		"/var/lib/dpkg/info/incus*.deb-systemd-helper-enabled",
		"/var/lib/dpkg/info/zfs*.deb-systemd-helper-enabled",
	} {
		if matches, err := filepath.Glob(pattern); err == nil {
			for _, m := range matches {
				if err := os.Remove(m); err == nil {
					removed = true
				}
			}
		}
	}

	if removed {
		fmt.Println("  Removed residual files (dnsmasq config, apt cache, dpkg tracker files)")
	} else {
		fmt.Println("  No residual files found")
	}
}

// removeZFSPackages purges spine-installed ZFS packages, but only if no
// non-Incus zpool exists (we don't want to break a user's unrelated zpool).
func removeZFSPackages() {
	out, err := exec.Command("dpkg", "-l", "zfsutils-linux").CombinedOutput()
	if err != nil || !strings.Contains(string(out), "ii ") {
		fmt.Println("  ZFS not installed, skipping")
		return
	}

	// Look for any zpools other than the Incus 'default' pool. If any exist,
	// we leave ZFS alone — the user is using it for something else.
	if poolsOut, err := exec.Command("zpool", "list", "-H", "-o", "name").Output(); err == nil {
		for _, line := range strings.Split(strings.TrimSpace(string(poolsOut)), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || line == "default" {
				continue
			}
			fmt.Printf("  Other zpool '%s' present — leaving ZFS installed for safety\n", line)
			return
		}
	}

	// BUG-012 (sebastian-v0.2.18.10): the v0.2.18.1 cleanup ran a bare
	// `apt-get autoremove -y` after the ZFS purge. autoremove with no
	// package argument removes EVERY auto-marked package across the host
	// that is no longer needed by anything currently installed — including
	// totally unrelated packages that happened to be auto-marked years ago.
	//
	// Concretely on ye-sebastian, the bare autoremove deleted ~50 node-*
	// Debian library packages plus session-migration, squashfs-tools,
	// sshfs, xdelta3, xdg-utils, etc. — none of which Spine ever installed.
	//
	// Fix: use `apt-get purge --auto-remove -y <packages>` which is the
	// SCOPED form. It only removes the named packages plus dependencies
	// that became unneeded BECAUSE OF removing those packages. It does not
	// touch unrelated auto-marked packages.
	purge := exec.Command("apt-get", "purge", "--auto-remove", "-y",
		"zfsutils-linux", "zfs-zed", "libzfs4linux")
	purge.Stdout = os.Stdout
	purge.Stderr = os.Stderr
	if err := purge.Run(); err != nil {
		fmt.Printf("  Warning: zfs purge failed: %v\n", err)
	}
	fmt.Println("  Removed ZFS packages (scoped — does not touch unrelated packages)")
}

// destroyZFSPools destroys any ZFS pools that were created by Incus.
// This prevents orphaned zpools from blocking ZFS re-initialization
// on the next 'spine deploy'.
//
// BUG-FIX (alisa-v0.2.21.1): the previous implementation called only
// `zpool destroy -f default` which can fail silently when ZFS datasets
// are still mounted or busy (e.g. cached container images, leftover
// container datasets like youeye-pihole). The orphaned pool then
// blocks ZFS init on the next deploy, forcing a fallback to dir
// storage, and ghost container datasets cause "already running"
// errors during infrastructure deployment.
//
// Fix: explicitly unmount and destroy all child datasets in reverse
// order (deepest first) before destroying the pool itself.
func destroyZFSPools() {
	// Check if zpool command exists
	if _, err := exec.LookPath("zpool"); err != nil {
		fmt.Println("  ZFS not installed, skipping")
		return
	}

	// Check if the 'default' zpool exists (the name Incus uses)
	if err := exec.Command("zpool", "list", "default").Run(); err != nil {
		fmt.Println("  No ZFS pool 'default' found, skipping")
		return
	}

	// First, destroy all child datasets to release any holds/mounts.
	// We must go deepest-first (reverse order of `zfs list -r`).
	fmt.Println("  Destroying ZFS datasets...")
	if out, err := exec.Command("zfs", "list", "-H", "-o", "name", "-r", "default").Output(); err == nil {
		lines := strings.Split(strings.TrimSpace(string(out)), "\n")
		for i := len(lines) - 1; i >= 0; i-- {
			ds := strings.TrimSpace(lines[i])
			if ds == "" || ds == "default" {
				continue
			}
			// Unmount first — datasets may have legacy mounts that
			// survive container deletion and block zpool destroy.
			exec.Command("zfs", "unmount", ds).Run()
			if err := exec.Command("zfs", "destroy", "-f", ds).Run(); err != nil {
				fmt.Printf("  Warning: could not destroy dataset %s\n", ds)
			}
		}
	}

	// Now destroy the pool itself
	fmt.Println("  Destroying ZFS pool 'default'...")
	if out, err := exec.Command("zpool", "destroy", "-f", "default").CombinedOutput(); err != nil {
		fmt.Printf("  Warning: could not destroy ZFS pool: %s\n", strings.TrimSpace(string(out)))
	} else {
		fmt.Println("  ✓ ZFS pool 'default' destroyed")
	}
}
