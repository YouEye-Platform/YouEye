package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/container"
	"github.com/youeye-platform/YouEye/spine/internal/releases"
	"github.com/youeye-platform/YouEye/spine/internal/update"
	"github.com/youeye-platform/YouEye/spine/internal/util"
	"github.com/youeye-platform/YouEye/spine/internal/version"
)

// getServiceWorkingDir reads the actual WorkingDirectory from a systemd service
// file inside a container. Falls back to the config default if the service file
// can't be read. This handles cases where the initial deployment used a different
// path than the current config default (e.g., /opt/youeye-ui vs /opt/app).
func getServiceWorkingDir(containerName, serviceName, fallback string) string {
	out, err := exec.Command("incus", "exec", containerName, "--",
		"systemctl", "show", serviceName, "--property=WorkingDirectory", "--value").Output()
	if err == nil {
		dir := strings.TrimSpace(string(out))
		if dir != "" && dir != "/" {
			return dir
		}
	}
	return fallback
}

func ensureControlIdentityService(containerName, appDir string) error {
	script := fmt.Sprintf(`set -e
if [ ! -f /etc/systemd/system/youeye-id.service ]; then
  JWT="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  HOST_IP="$(hostname -I | awk '{print $1}')"
  cat > /etc/systemd/system/youeye-id.service <<EOF
[Unit]
Description=Identity Provider
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=%s
Environment=NODE_ENV=production
Environment=PORT=3001
Environment=IDENTITY_SERVICE=true
Environment=JWT_SECRET=${JWT}
Environment=HOST_IP=${HOST_IP}
Environment=SECURE_COOKIES=true
ExecStart=/usr/bin/node %s/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
fi
if [ -f /etc/youeye/incus-client.crt ] && [ -f /etc/youeye/incus-client.key ]; then
  INCUS_URL="$(systemctl show youeye-control --property=Environment --value 2>/dev/null | tr ' ' '\n' | sed -n 's/^INCUS_HTTPS_URL=//p' | head -n1)"
  if [ -z "$INCUS_URL" ] && [ -f /etc/systemd/system/youeye-control.service ]; then
    INCUS_URL="$(sed -n 's/^Environment=INCUS_HTTPS_URL=//p' /etc/systemd/system/youeye-control.service | head -n1)"
  fi
  if [ -z "$INCUS_URL" ]; then
    GW="$(ip route show default 2>/dev/null | awk '{print $3; exit}')"
    if [ -n "$GW" ]; then
      INCUS_URL="${GW}:8443"
    fi
  fi
  if [ -n "$INCUS_URL" ]; then
    mkdir -p /etc/systemd/system/youeye-id.service.d
    cat > /etc/systemd/system/youeye-id.service.d/incus-https.conf <<EOF
[Service]
Environment=INCUS_HTTPS_URL=${INCUS_URL}
Environment=INCUS_CLIENT_CERT=/etc/youeye/incus-client.crt
Environment=INCUS_CLIENT_KEY=/etc/youeye/incus-client.key
EOF
  fi
fi
systemctl daemon-reload
systemctl enable youeye-id
systemctl restart youeye-id
`, appDir, appDir)
	out, err := exec.Command("incus", "exec", containerName, "--", "bash", "-c", script).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	if err := container.EnsureControlSocketReadiness(containerName); err != nil {
		return err
	}
	return nil
}

var updateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update components",
}

var updateAssumeYes bool

var updateSelfCmd = &cobra.Command{
	Use:   "self",
	Short: "Update Spine to the latest version",
	RunE: func(cmd *cobra.Command, args []string) error {
		return updateSelf()
	},
}

var updateIncusCmd = &cobra.Command{
	Use:   "incus",
	Short: "Update Incus to the latest version",
	RunE: func(cmd *cobra.Command, args []string) error {
		return updateIncus()
	},
}

var updateSystemCmd = &cobra.Command{
	Use:   "system",
	Short: "Update the host system or signed appliance image",
	RunE: func(cmd *cobra.Command, args []string) error {
		return updateSystem()
	},
}

var updateControlCmd = &cobra.Command{
	Use:   "control",
	Short: "Update Control Panel to the latest version",
	RunE: func(cmd *cobra.Command, args []string) error {
		return updateControl()
	},
}

func init() {
	updateSelfCmd.Flags().BoolVarP(&updateAssumeYes, "yes", "y", false, "confirm channel switch / downgrade without prompting")
	updateControlCmd.Flags().BoolVarP(&updateAssumeYes, "yes", "y", false, "confirm channel switch / downgrade without prompting")

	updateCmd.AddCommand(updateSelfCmd)
	updateCmd.AddCommand(updateIncusCmd)
	updateCmd.AddCommand(updateSystemCmd)
	updateCmd.AddCommand(updateControlCmd)
}

// updateDecision captures the resolved candidate and whether an install should
// proceed. A channel switch (different branch) installs even a lower version but
// requires interactive confirmation unless assumeYes.
type updateDecision struct {
	proceed  bool
	isSwitch bool
}

// decideUpdate compares the resolved candidate against the installed provenance
// for a component and decides whether to install. A strictly newer candidate is
// a plain update no matter which branch produced it — fallback overtaking a
// branch install (main newer than a stale feature line) must not prompt. The
// confirm gate exists only for moving to a NOT-newer candidate after a channel
// change (downgrade/sidegrade). Missing provenance is treated as same-branch.
func decideUpdate(component, currentVersion, candVersion, candBranch string, assumeYes bool) updateDecision {
	prov, hasProv := update.GetProvenance(component)
	installedBranch := ""
	if hasProv {
		installedBranch = prov.Branch
	}
	differentBranch := installedBranch != "" && installedBranch != candBranch

	if version.IsNewer(candVersion, currentVersion) {
		return updateDecision{proceed: true, isSwitch: differentBranch}
	}
	if !differentBranch {
		return updateDecision{proceed: false}
	}

	// Channel switch to a not-newer candidate — install the exact candidate
	// even though it is lower/equal, gated by confirmation.
	relation := "downgrade"
	if version.CompareVersions(candVersion, currentVersion) == 0 {
		relation = "same version"
	}

	if !assumeYes {
		fmt.Printf("Channel switch: %s %s → %s %s (%s). Continue? [y/N]: ",
			installedBranch, version.FormatVersion(currentVersion),
			candBranch, version.FormatVersion(candVersion), relation)
		var resp string
		fmt.Scanln(&resp)
		if strings.ToLower(strings.TrimSpace(resp)) != "y" {
			fmt.Println("Cancelled.")
			return updateDecision{proceed: false, isSwitch: true}
		}
	}
	return updateDecision{proceed: true, isSwitch: true}
}

func updateSelf() error {
	if err := requireRuntimeCapability(appliance.ActionSpineUpdate); err != nil {
		return err
	}
	fmt.Println("=== Updating Spine ===")

	cfg := GetConfig()

	update.Start("spine", Version)

	// Determine architecture
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "amd64"
	} else if arch == "arm64" {
		arch = "arm64"
	} else {
		return fmt.Errorf("unsupported architecture: %s", arch)
	}

	// Resolve the candidate release via the spine channel.
	fmt.Println("Checking for updates...")
	cand, err := releases.ResolveComponent(cfg, channels.ComponentSpine, cfg.Releases.Repositories.Spine, cfg.Releases.Repositories.SpineTagPrefix)
	if err != nil {
		fmt.Println("No releases found. You're running the development version.")
		update.ClearStatus()
		return nil
	}
	tag := cand.Tag
	effectiveBranch := cand.Branch
	latestVersion := cand.Version

	if effectiveBranch != "" && effectiveBranch != "main" {
		fmt.Printf("Channel branch: %s\n", effectiveBranch)
	}

	fmt.Printf("Current version: %s\n", version.FormatVersion(Version))
	fmt.Printf("Latest version: %s (%s)\n", version.FormatVersion(latestVersion), effectiveBranch)

	decision := decideUpdate(channels.ComponentSpine, Version, latestVersion, effectiveBranch, updateAssumeYes)
	if !decision.proceed {
		if !decision.isSwitch {
			fmt.Println("✓ Spine is already up to date")
		}
		update.ClearStatus()
		return nil
	}

	// Get current binary path
	currentBinary, err := os.Executable()
	if err != nil {
		currentBinary = cfg.Paths.SpineBinary
	}

	update.Emit("spine", update.StatusDownloading, 20, fmt.Sprintf("Downloading %s...", latestVersion))

	// Download new binary using the resolved candidate (honors the channel source)
	downloadURL := releases.BuildCandidateDownloadURL(cfg, cand, cfg.Releases.Repositories.Spine, fmt.Sprintf("spine-linux-%s", arch))
	fmt.Printf("Downloading from %s...\n", downloadURL)

	// Download to temp file with random suffix (IPv4-only to avoid IPv6 hangs)
	tmpFile := fmt.Sprintf("/tmp/spine-update-%d", time.Now().UnixNano())
	dlClient := releases.NewIPv4Client(10 * time.Minute)
	resp, err := dlClient.Get(downloadURL)
	if err != nil {
		update.Fail("spine", Version, fmt.Sprintf("download failed: %v", err))
		return fmt.Errorf("failed to download update: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		update.Fail("spine", Version, fmt.Sprintf("download returned status %d", resp.StatusCode))
		return fmt.Errorf("download failed with status: %d", resp.StatusCode)
	}

	f, err := os.Create(tmpFile)
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	_, err = io.Copy(f, resp.Body)
	f.Close()
	if err != nil {
		os.Remove(tmpFile)
		return fmt.Errorf("failed to download: %w", err)
	}
	if err := releases.VerifySignedReleaseArtifact(dlClient, downloadURL, tmpFile, cand.ArtifactSHA256); err != nil {
		os.Remove(tmpFile)
		update.Fail("spine", Version, "release signature verification failed")
		return fmt.Errorf("verify signed Spine release: %w", err)
	}

	// Make executable
	if err := os.Chmod(tmpFile, 0755); err != nil {
		os.Remove(tmpFile)
		return fmt.Errorf("failed to set permissions: %w", err)
	}

	update.Emit("spine", update.StatusVerifying, 50, "Verifying downloaded binary...")

	// Verify the new binary works by running --version
	fmt.Println("Verifying downloaded binary...")
	verifyCmd := exec.Command(tmpFile, "version")
	verifyOut, err := verifyCmd.CombinedOutput()
	if err != nil {
		os.Remove(tmpFile)
		update.Fail("spine", Version, "downloaded binary verification failed")
		return fmt.Errorf("downloaded binary verification failed: %w\nOutput: %s", err, string(verifyOut))
	}
	fmt.Printf("  ✓ New binary verified: %s", string(verifyOut))

	// Create backup of current binary
	backupFile := currentBinary + ".backup"
	if cfg.Security.BackupOnUpdate {
		fmt.Println("Creating backup of current binary...")
		if err := copyFile(currentBinary, backupFile); err != nil {
			fmt.Printf("Warning: could not create backup: %v\n", err)
			// Continue anyway - backup is optional
		} else {
			fmt.Printf("  ✓ Backup created at %s\n", backupFile)
		}
	}

	update.Emit("spine", update.StatusInstalling, 70, "Installing update...")

	// Canonical install path is /usr/local/bin/youeye; spine is a backward-compat symlink.
	// The running binary may be either path — normalize to install at the canonical location
	// and ensure the symlink exists.
	canonicalBinary := cfg.Paths.SpineBinary // /usr/local/bin/youeye
	legacyBinary := "/usr/local/bin/spine"

	// Replace binary: unlink first (avoids "text file busy" on Linux), then rename
	fmt.Println("Installing update...")
	os.Remove(canonicalBinary) // Unlink running binary — kernel keeps inode alive until process exits
	os.Remove(legacyBinary)    // Remove old binary or symlink so we can recreate
	if err := os.Rename(tmpFile, canonicalBinary); err != nil {
		// Rename failed (possibly cross-device), try copy
		if err := copyFile(tmpFile, canonicalBinary); err != nil {
			// Restore from backup if available
			if cfg.Security.BackupOnUpdate {
				if restoreErr := copyFile(backupFile, currentBinary); restoreErr != nil {
					fmt.Printf("CRITICAL: Update failed and restore failed! Manual intervention required.\n")
					fmt.Printf("Backup file: %s\n", backupFile)
				}
			}
			os.Remove(tmpFile)
			update.Fail("spine", Version, "failed to install update binary")
			return fmt.Errorf("failed to install update: %w", err)
		}
		os.Remove(tmpFile)
	}

	// Create backward-compatible spine symlink
	os.Symlink(canonicalBinary, legacyBinary)

	// Verify installation
	fmt.Println("Verifying installation...")
	verifyInstall := exec.Command(canonicalBinary, "version")
	if out, err := verifyInstall.CombinedOutput(); err != nil {
		// Installation verification failed, try to restore backup
		fmt.Printf("Installation verification failed: %s\n", string(out))
		if cfg.Security.BackupOnUpdate {
			fmt.Println("Restoring from backup...")
			if err := os.Rename(backupFile, currentBinary); err != nil {
				update.Fail("spine", Version, "CRITICAL: restore from backup failed")
				return fmt.Errorf("CRITICAL: Restore from backup failed: %w. Manual intervention required.", err)
			}
			fmt.Println("  ✓ Restored previous version from backup")
			update.Fail("spine", Version, "installation verification failed, rolled back")
			return fmt.Errorf("update failed, rolled back to previous version")
		}
		update.Fail("spine", Version, "installation verification failed")
		return fmt.Errorf("update failed: %w", err)
	}

	// Clean up backup (optional - keep last backup)
	// os.Remove(backupFile)

	update.Emit("spine", update.StatusRestarting, 90, "Restarting Spine service...")

	// Record provenance BEFORE restart — after restart, old process is gone.
	if err := update.WriteProvenance(channels.ComponentSpine, update.ProvenanceEntry{
		Version:        latestVersion,
		Tag:            tag,
		Branch:         effectiveBranch,
		Source:         cand.Source,
		ArtifactSHA256: cand.ArtifactSHA256,
	}); err != nil {
		fmt.Printf("Warning: could not record provenance: %v\n", err)
	}

	// Write completed status BEFORE restart — after restart, old process is gone
	update.Complete("spine", Version, latestVersion)

	// Migrate spine.service → youeye.service if the old service is still active
	if _, err := os.Stat("/etc/systemd/system/spine.service"); err == nil {
		fmt.Println("Migrating spine.service → youeye.service...")
		exec.Command("systemctl", "stop", "spine").Run()
		exec.Command("systemctl", "disable", "spine").Run()
		os.Remove("/etc/systemd/system/spine.service")

		serviceContent := `[Unit]
Description=YouEye Platform Management Service
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStartPre=/bin/mkdir -p /var/run/youeye
ExecStart=/usr/local/bin/youeye api serve
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`
		os.WriteFile("/etc/systemd/system/youeye.service", []byte(serviceContent), 0644)
		exec.Command("systemctl", "daemon-reload").Run()
		exec.Command("systemctl", "enable", "youeye").Run()
	}

	// Restart the service so the API reflects the new version
	fmt.Println("Restarting YouEye service...")
	if err := exec.Command("systemctl", "restart", "youeye").Run(); err != nil {
		// Last resort: try legacy name (should not happen after migration above)
		if err2 := exec.Command("systemctl", "restart", "spine").Run(); err2 != nil {
			fmt.Printf("Warning: could not restart service: %v\n", err)
			fmt.Println("You may need to manually restart: systemctl restart youeye")
		} else {
			fmt.Println("  ✓ Service restarted (legacy)")
		}
	} else {
		fmt.Println("  ✓ YouEye service restarted")
	}

	fmt.Println("✓ YouEye updated successfully")
	fmt.Println("Run 'youeye version' to verify")
	return nil
}

// copyFile copies a file from src to dst
func copyFile(src, dst string) error {
	sourceFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer sourceFile.Close()

	destFile, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer destFile.Close()

	if _, err := io.Copy(destFile, sourceFile); err != nil {
		return err
	}

	// Copy permissions
	sourceInfo, err := os.Stat(src)
	if err != nil {
		return err
	}
	return os.Chmod(dst, sourceInfo.Mode())
}

func updateIncus() error {
	if err := requireRuntimeCapability(appliance.ActionIncusUpdate); err != nil {
		return err
	}
	fmt.Println("=== Updating Incus ===")

	// Get current version
	out, _ := exec.Command("incus", "version").Output()
	fmt.Printf("Current version:\n%s\n", string(out))

	// Update via apt
	fmt.Println("Updating package list...")
	if err := util.RunCmd("apt-get", "update"); err != nil {
		return err
	}

	fmt.Println("Upgrading Incus...")
	if err := util.RunCmd("apt-get", "install", "-y", "--only-upgrade", "incus"); err != nil {
		return err
	}

	// Show new version
	out, _ = exec.Command("incus", "version").Output()
	fmt.Printf("New version:\n%s\n", string(out))

	fmt.Println("✓ Incus updated")
	return nil
}

func updateSystem() error {
	runtimeStatus, _, runtimeErr := applianceRuntime()
	if runtimeErr != nil {
		return runtimeErr
	}
	if runtimeStatus.Kind == appliance.RuntimeApplianceImage {
		return runSystemUpdateStatus(false)
	}
	if err := requireRuntimeCapability(appliance.ActionSystemUpdate); err != nil {
		return err
	}
	fmt.Println("=== Updating Host System ===")
	fmt.Println("")
	fmt.Println("⚠️  WARNING: This will update all system packages.")
	fmt.Println("⚠️  Kernel updates may require a reboot.")
	fmt.Println("")

	// Show upgradable packages
	fmt.Println("Checking for updates...")
	util.RunCmd("apt-get", "update")
	out, _ := exec.Command("apt", "list", "--upgradable").Output()
	lines := strings.Split(string(out), "\n")
	upgradable := len(lines) - 2 // Subtract header and empty line
	if upgradable < 0 {
		upgradable = 0
	}

	if upgradable == 0 {
		fmt.Println("✓ System is up to date")
		return nil
	}

	fmt.Printf("Found %d upgradable packages.\n", upgradable)
	fmt.Print("Continue? [y/N]: ")
	var response string
	fmt.Scanln(&response)
	if strings.ToLower(response) != "y" {
		fmt.Println("Cancelled")
		return nil
	}

	// Run upgrade
	fmt.Println("Upgrading packages...")
	if err := util.RunCmd("apt-get", "upgrade", "-y"); err != nil {
		return err
	}

	fmt.Println("✓ System updated")

	// Check if reboot required
	if _, err := os.Stat("/var/run/reboot-required"); err == nil {
		fmt.Println("")
		fmt.Println("⚠️  A reboot is required to complete the update.")
		fmt.Println("   Run 'sudo reboot' when ready.")
	}

	return nil
}

func updateControl() error {
	fmt.Println("=== Updating Control Panel ===")

	cfg := GetConfig()
	containerName := cfg.Deployment.Container.Name
	port := cfg.Deployment.ControlPanel.Port

	// Check if container exists
	out, err := exec.Command("incus", "list", "--format", "csv", "-c", "n").Output()
	if err != nil || !strings.Contains(string(out), containerName) {
		return fmt.Errorf("Control Panel container not found")
	}

	// Use the actual systemd service WorkingDirectory (may differ from config on older deployments)
	appDir := getServiceWorkingDir(containerName, "youeye-control", cfg.Deployment.ControlPanel.AppDir)

	// Get current version
	currentVersion := getControlPanelVersion()
	fmt.Printf("Current version: %s\n", version.FormatVersion(currentVersion))

	// Resolve the candidate release via the control channel.
	fmt.Println("Checking for updates...")
	cand, err := releases.ResolveComponent(cfg, channels.ComponentControl, cfg.Releases.Repositories.ControlPanel, cfg.Releases.Repositories.ControlPanelTagPrefix)
	if err != nil {
		return fmt.Errorf("could not determine latest version: %w", err)
	}
	cpTag := cand.Tag
	cpEffectiveBranch := cand.Branch
	latestVersion := cand.Version
	channelConfig, err := channels.Load()
	if err != nil {
		return fmt.Errorf("load Control Panel release channel: %w", err)
	}
	controlChannel := channelConfig.Effective(channels.ComponentControl, cfg)

	if cpEffectiveBranch != "" && cpEffectiveBranch != "main" {
		fmt.Printf("Channel branch: %s\n", cpEffectiveBranch)
	}
	fmt.Printf("Latest version: %s (%s)\n", version.FormatVersion(latestVersion), cpEffectiveBranch)

	decision := decideUpdate(channels.ComponentControl, currentVersion, latestVersion, cpEffectiveBranch, updateAssumeYes)
	if !decision.proceed {
		if decision.isSwitch {
			return nil
		}
		if err := ensureControlIdentityService(containerName, appDir); err != nil {
			return fmt.Errorf("Control Panel is up to date, but YouEye ID service repair failed: %w", err)
		}
		fmt.Println("✓ Control Panel is already up to date")
		return nil
	}

	fmt.Printf("Updating from %s to %s...\n", version.FormatVersion(currentVersion), version.FormatVersion(latestVersion))

	// Create snapshot before update
	fmt.Println("Creating snapshot...")
	snapshotName := "pre-update"
	// Absence is the normal first-update state; remove an older rollback point
	// quietly so it is not misreported as a failed snapshot operation.
	_ = util.RunCmdQuiet("incus", "snapshot", "delete", containerName, snapshotName)
	if err := util.RunCmd("incus", "snapshot", "create", containerName, snapshotName); err != nil {
		return fmt.Errorf("could not create required pre-update snapshot: %w", err)
	}

	// Download the release tarball using the resolved tag (may be main tag if branch tag not found)
	downloadURL := releases.BuildCandidateDownloadURL(cfg, cand, cfg.Releases.Repositories.ControlPanel, "standalone.tar")
	fmt.Printf("Downloading from %s...\n", downloadURL)

	tmpFile := "/tmp/control-update.tar"
	cpDlClient := releases.NewIPv4Client(10 * time.Minute)
	resp, err := cpDlClient.Get(downloadURL)
	if err != nil {
		return fmt.Errorf("failed to download update: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("download failed with status: %d", resp.StatusCode)
	}

	f, err := os.Create(tmpFile)
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	_, err = io.Copy(f, resp.Body)
	f.Close()
	if err != nil {
		return fmt.Errorf("failed to download: %w", err)
	}
	if err := releases.VerifySignedReleaseArtifact(cpDlClient, downloadURL, tmpFile, controlChannel.ArtifactSHA256); err != nil {
		return fmt.Errorf("verify signed Control Panel release artifact: %w", err)
	}

	fmt.Println("Stopping Control Panel...")
	util.RunIncusExec(containerName, "systemctl", "stop", "youeye-control")

	// Clear old files and deploy new ones
	fmt.Println("Deploying new version...")
	util.RunIncusExec(containerName, "rm", "-rf", appDir)
	util.RunIncusExec(containerName, "mkdir", "-p", appDir)

	// Push tarball to container
	if err := util.RunCmd("incus", "file", "push", tmpFile, containerName+"/tmp/update.tar"); err != nil {
		fmt.Println("❌ Failed to push update, rolling back...")
		util.RunCmd("incus", "snapshot", "restore", containerName, snapshotName)
		return fmt.Errorf("failed to push update")
	}

	// Extract tarball (files are at root level: server.js, .next/, node_modules/, etc.)
	if err := util.RunIncusExec(containerName, "tar", "-xf", "/tmp/update.tar", "-C", appDir, "--no-same-owner"); err != nil {
		fmt.Println("❌ Failed to extract update, rolling back...")
		util.RunCmd("incus", "snapshot", "restore", containerName, snapshotName)
		return fmt.Errorf("failed to extract update")
	}

	// Clean up
	util.RunIncusExec(containerName, "rm", "/tmp/update.tar")
	os.Remove(tmpFile)

	if err := ensureControlIdentityService(containerName, appDir); err != nil {
		fmt.Println("❌ Failed to ensure YouEye ID service, rolling back...")
		util.RunCmd("incus", "snapshot", "restore", containerName, snapshotName)
		util.RunIncusExec(containerName, "systemctl", "start", "youeye-control")
		return fmt.Errorf("failed to ensure YouEye ID service: %w", err)
	}

	fmt.Println("Starting Control Panel...")
	util.RunIncusExec(containerName, "systemctl", "start", "youeye-control")

	// Health check (curl from inside container)
	fmt.Println("Checking health...")
	healthy := false
	for i := 0; i < 15; i++ {
		time.Sleep(2 * time.Second)
		out, err := exec.Command("incus", "exec", containerName, "--",
			"curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
			fmt.Sprintf("http://localhost:%d/api/auth/session", port)).Output()
		if err == nil && (string(out) == "200" || string(out) == "401") {
			healthy = true
			break
		}
		fmt.Print(".")
	}
	fmt.Println()

	if !healthy {
		fmt.Println("❌ Health check failed, rolling back...")
		util.RunIncusExec(containerName, "systemctl", "stop", "youeye-control")
		util.RunCmd("incus", "snapshot", "restore", containerName, snapshotName)
		util.RunIncusExec(containerName, "systemctl", "start", "youeye-control")
		return fmt.Errorf("update failed, rolled back to previous version")
	}

	// Record provenance for the installed Control Panel release.
	if err := update.WriteProvenance(channels.ComponentControl, update.ProvenanceEntry{
		Version:        latestVersion,
		Tag:            cpTag,
		Branch:         cpEffectiveBranch,
		Source:         cand.Source,
		ArtifactSHA256: cand.ArtifactSHA256,
	}); err != nil {
		fmt.Printf("Warning: could not record provenance: %v\n", err)
	}

	if err := runControlUpdateFinalization(controlUpdateFinalizers{
		reconcileInfrastructure: reconcileInfrastructureViaCP,
		provisionBridgeToken:    provisionBridgeToken,
		provisionCLIToken:       provisionCLIToken,
		enforceUIEgressBlock:    container.EnforceUIEgressBlock,
		repairControlProxy: func() error {
			return container.RepairControlPanelPortProxy(containerName, port)
		},
	}); err != nil {
		return err
	}

	fmt.Printf("✓ Control Panel updated successfully to %s\n", version.FormatVersion(latestVersion))

	return nil
}

type controlUpdateFinalizers struct {
	reconcileInfrastructure func() error
	provisionBridgeToken    func() error
	provisionCLIToken       func() error
	enforceUIEgressBlock    func() error
	repairControlProxy      func() error
}

// runControlUpdateFinalization restores infrastructure before pushing credentials
// and policy into the UI. Reconciliation may replace an unhealthy UI container,
// so doing it last would discard the newly provisioned bridge token.
func runControlUpdateFinalization(finalizers controlUpdateFinalizers) error {
	fmt.Println("\nReconciling infrastructure...")
	if err := finalizers.reconcileInfrastructure(); err != nil {
		return fmt.Errorf("Control Panel updated, but infrastructure reconciliation failed: %w", err)
	}

	if err := finalizers.provisionBridgeToken(); err != nil {
		return fmt.Errorf("re-provision bridge token: %w", err)
	}
	if err := finalizers.provisionCLIToken(); err != nil {
		return fmt.Errorf("re-provision CLI token: %w", err)
	}
	if err := finalizers.enforceUIEgressBlock(); err != nil {
		return fmt.Errorf("failed to enforce UI→Control Panel egress block: %w", err)
	}
	if err := finalizers.repairControlProxy(); err != nil {
		return fmt.Errorf("failed to repair Control Panel localhost proxy: %w", err)
	}

	return nil
}

// reconcileInfrastructureViaCP calls the Control Panel's reconcile endpoint
// to deploy any missing infrastructure containers without touching existing ones.
func reconcileInfrastructureViaCP() error {
	hostIP := util.GetPrimaryIP()

	// Read deploy secret from host file
	secretBytes, err := os.ReadFile("/var/lib/youeye/control/.deploy_secret")
	if err != nil {
		return fmt.Errorf("cannot read deploy secret: %w", err)
	}
	deploySecret := strings.TrimSpace(string(secretBytes))

	return newDeploymentJobClient(deploymentBaseURL, deploySecret).execute("reconcile", hostIP)
}

// getControlPanelVersion gets the current version from container
func getControlPanelVersion() string {
	out, err := exec.Command("incus", "exec", "youeye-control", "--",
		"cat", "/opt/app/package.json").Output()
	if err != nil {
		return "unknown"
	}

	var pkg struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(out, &pkg) == nil && pkg.Version != "" {
		return pkg.Version
	}
	return "unknown"
}
