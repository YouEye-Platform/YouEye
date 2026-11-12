package cmd

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/container"
	"github.com/youeye-platform/YouEye/spine/internal/util"
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

var updateIncusCmd = &cobra.Command{
	Use:   "incus",
	Short: "Update Incus to the latest version",
	RunE: func(cmd *cobra.Command, args []string) error {
		return updateIncus()
	},
}

var updateSystemCmd = &cobra.Command{
	Use:   "system",
	Short: "Update the host system or appliance image",
	RunE: func(cmd *cobra.Command, args []string) error {
		return updateSystem()
	},
}

func init() {
	updateCmd.AddCommand(updateIncusCmd)
	updateCmd.AddCommand(updateSystemCmd)
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

type controlUpdateFinalizers struct {
	reconcileInfrastructure func() error
	provisionBridgeToken    func() error
	provisionCLIToken       func() error
	enforceUIEgressBlock    func() error
	repairControlProxy      func() error
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
