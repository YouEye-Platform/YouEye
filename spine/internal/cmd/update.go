package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"git.byka.wtf/potemsla/YouEye/spine/internal/releases"
	"git.byka.wtf/potemsla/YouEye/spine/internal/update"
	"git.byka.wtf/potemsla/YouEye/spine/internal/util"
	"git.byka.wtf/potemsla/YouEye/spine/internal/version"
	"github.com/spf13/cobra"
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

var updateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update components",
}

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
	Short: "Update host OS packages",
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
	updateCmd.AddCommand(updateSelfCmd)
	updateCmd.AddCommand(updateIncusCmd)
	updateCmd.AddCommand(updateSystemCmd)
	updateCmd.AddCommand(updateControlCmd)
}

func updateSelf() error {
	fmt.Println("=== Updating Spine ===")

	cfg := GetConfig()
	branch := releases.ReadReleaseBranch()

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

	// Get latest release info from configured release source
	if branch != "" && branch != "main" {
		fmt.Printf("Release branch: %s\n", branch)
	}
	fmt.Println("Checking for updates...")
	tag, effectiveBranch := releases.GetLatestTagForBranch(cfg, cfg.Releases.Repositories.Spine, branch, cfg.Releases.Repositories.SpineTagPrefix)
	if tag == "" {
		fmt.Println("No releases found. You're running the development version.")
		update.ClearStatus()
		return nil
	}
	latestVersion := releases.ExtractVersionFromFullTag(tag, effectiveBranch, cfg.Releases.Repositories.SpineTagPrefix)

	// Log fallback so the agent knows which tag was used
	if branch != "" && branch != "main" && effectiveBranch == "main" {
		fmt.Printf("No %s-branch tag found — falling back to main tag: %s\n", branch, tag)
	}

	fmt.Printf("Current version: %s\n", Version)
	fmt.Printf("Latest version: %s\n", latestVersion)

	if !version.IsNewer(latestVersion, Version) {
		fmt.Println("✓ Spine is already up to date")
		update.ClearStatus()
		return nil
	}

	// Get current binary path
	currentBinary, err := os.Executable()
	if err != nil {
		currentBinary = cfg.Paths.SpineBinary
	}

	update.Emit("spine", update.StatusDownloading, 20, fmt.Sprintf("Downloading %s...", latestVersion))

	// Download new binary using the resolved tag (may be main tag if branch tag not found)
	downloadURL := releases.BuildDownloadURL(cfg, cfg.Releases.Repositories.Spine, tag, fmt.Sprintf("spine-linux-%s", arch))
	fmt.Printf("Downloading from %s...\n", downloadURL)

	// Download to temp file with random suffix
	tmpFile := fmt.Sprintf("/tmp/spine-update-%d", time.Now().UnixNano())
	resp, err := http.Get(downloadURL)
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

	// Replace binary: unlink first (avoids "text file busy" on Linux), then rename
	fmt.Println("Installing update...")
	os.Remove(currentBinary) // Unlink running binary — kernel keeps inode alive until process exits
	if err := os.Rename(tmpFile, currentBinary); err != nil {
		// Rename failed (possibly cross-device), try copy
		if err := copyFile(tmpFile, currentBinary); err != nil {
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

	// Verify installation
	fmt.Println("Verifying installation...")
	verifyInstall := exec.Command(currentBinary, "version")
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

	// Write completed status BEFORE restart — after restart, old process is gone
	update.Complete("spine", Version, latestVersion)

	// Restart the spine service so the API reflects the new version
	fmt.Println("Restarting Spine service...")
	if err := exec.Command("systemctl", "restart", "spine").Run(); err != nil {
		fmt.Printf("Warning: could not restart spine service: %v\n", err)
		fmt.Println("You may need to manually restart: systemctl restart spine")
	} else {
		fmt.Println("  ✓ Spine service restarted")
	}

	fmt.Println("✓ Spine updated successfully")
	fmt.Println("Run 'spine version' to verify")
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
	branch := releases.ReadReleaseBranch()
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
	fmt.Printf("Current version: %s\n", currentVersion)

	// Get latest version from configured release source
	if branch != "" && branch != "main" {
		fmt.Printf("Release branch: %s\n", branch)
	}
	fmt.Println("Checking for updates...")
	cpTag, cpEffectiveBranch := releases.GetLatestTagForBranch(cfg, cfg.Releases.Repositories.ControlPanel, branch, cfg.Releases.Repositories.ControlPanelTagPrefix)
	if cpTag == "" {
		return fmt.Errorf("could not determine latest version")
	}
	latestVersion := releases.ExtractVersionFromFullTag(cpTag, cpEffectiveBranch, cfg.Releases.Repositories.ControlPanelTagPrefix)

	// Log fallback so the agent knows which tag was used
	if branch != "" && branch != "main" && cpEffectiveBranch == "main" {
		fmt.Printf("No %s-branch tag found — falling back to main tag: %s\n", branch, cpTag)
	}

	fmt.Printf("Latest version: %s\n", latestVersion)

	if !version.IsNewer(latestVersion, currentVersion) {
		fmt.Println("✓ Control Panel is already up to date")
		return nil
	}

	fmt.Printf("Updating from %s to %s...\n", currentVersion, latestVersion)

	// Create snapshot before update
	fmt.Println("Creating snapshot...")
	snapshotName := "pre-update"
	util.RunCmd("incus", "snapshot", "delete", containerName, snapshotName)
	if err := util.RunCmd("incus", "snapshot", "create", containerName, snapshotName); err != nil {
		fmt.Println("Warning: could not create snapshot")
	}

	// Download the release tarball using the resolved tag (may be main tag if branch tag not found)
	downloadURL := releases.BuildDownloadURL(cfg, cfg.Releases.Repositories.ControlPanel, cpTag, "standalone.tar")
	fmt.Printf("Downloading from %s...\n", downloadURL)

	tmpFile := "/tmp/control-update.tar"
	resp, err := http.Get(downloadURL)
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

	// Re-provision the bridge token to ensure both containers have it
	provisionBridgeToken()

	fmt.Printf("✓ Control Panel updated successfully to %s\n", latestVersion)

	// Reconcile infrastructure: deploy any missing containers.
	// This handles the case where infrastructure containers (Pi-Hole, Caddy, etc.)
	// were lost or never deployed, ensuring `spine update control` restores them.
	fmt.Println("\nReconciling infrastructure...")
	if err := reconcileInfrastructureViaCP(); err != nil {
		fmt.Printf("⚠ Infrastructure reconciliation failed: %v\n", err)
		fmt.Println("  You can retry with: spine deploy")
		// Non-fatal — the CP update itself succeeded
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

	// POST to Control Panel reconcile endpoint
	body := fmt.Sprintf(`{"host_ip":"%s"}`, hostIP)
	req, err := http.NewRequest("POST", "http://127.0.0.1:3000/api/deploy/infrastructure/reconcile", strings.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Deploy-Secret", deploySecret)

	client := &http.Client{Timeout: 30 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to connect to Control Panel: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		bodyBytes := make([]byte, 1024)
		n, _ := resp.Body.Read(bodyBytes)
		return fmt.Errorf("Control Panel returned status %d: %s", resp.StatusCode, string(bodyBytes[:n]))
	}

	// Read SSE stream and print progress
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}

		jsonStr := strings.TrimPrefix(line, "data: ")
		var event deploymentEvent
		if err := json.Unmarshal([]byte(jsonStr), &event); err != nil {
			continue
		}

		icon := "⏳"
		switch event.Status {
		case "success":
			icon = "✓"
		case "error":
			icon = "✗"
		case "skipped":
			icon = "→"
		}
		fmt.Printf("  %s [%d/%d] %s\n", icon, event.Step, event.TotalSteps, event.Message)
	}

	if scanner.Err() != nil {
		return fmt.Errorf("error reading SSE stream: %w", scanner.Err())
	}

	return nil
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


