// Package container provides container management for Control Panel deployment.
package container

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"git.byka.wtf/potemsla/YouEye/spine/internal/config"
	"git.byka.wtf/potemsla/YouEye/spine/internal/incus"
	"git.byka.wtf/potemsla/YouEye/spine/internal/releases"
	"git.byka.wtf/potemsla/YouEye/spine/internal/util"
)

// DeployControlPanel deploys the Control Panel container with all dependencies.
func DeployControlPanel(cfg *config.Config) error {
	fmt.Println("=== Deploying Control Panel ===")

	containerName := cfg.Deployment.Container.Name
	port := cfg.Deployment.ControlPanel.Port
	socketPath := cfg.API.SocketPath

	// Check if Incus is available
	if _, err := exec.LookPath("incus"); err != nil {
		return fmt.Errorf("Incus not found. Run 'spine install incus' first")
	}

	// Check if container already exists — silently skip (same as OCI apps)
	out, _ := exec.Command("incus", "list", "--format", "csv", "-c", "n").Output()
	if strings.Contains(string(out), containerName) {
		util.LogSuccess(fmt.Sprintf("Control Panel container '%s' already exists, skipping", containerName))
		return nil
	}

	// Create container
	if err := createContainer(containerName); err != nil {
		return err
	}

	// Wait for container
	if err := waitForContainer(containerName); err != nil {
		return err
	}

	// Add socket proxies
	if err := addSocketProxies(containerName, socketPath); err != nil {
		return err
	}

	// Add port proxy
	if err := addPortProxy(containerName, port); err != nil {
		return err
	}

	// Install Node.js
	if err := installNodeJS(containerName); err != nil {
		return err
	}

	// Add volume mount for /var/lib/youeye (secrets, configs, app data)
	if err := addDataVolumeMount(containerName); err != nil {
		util.LogError(fmt.Sprintf("Warning: could not add data volume mount: %v", err))
	}

	// Mount host /proc/meminfo so the CP can read real host memory stats.
	// Without this, /proc/meminfo inside the container shows cgroup-limited
	// values (~8 GB) regardless of actual host memory pressure.
	if err := addHostMeminfo(containerName); err != nil {
		util.LogError(fmt.Sprintf("Warning: could not add host meminfo mount: %v", err))
	}

	// Deploy application
	if err := DeployControlPanelApp(cfg); err != nil {
		util.LogError(fmt.Sprintf("Could not deploy Control Panel app: %v", err))
		fmt.Println("You can deploy manually later using 'spine update control'")
		return err
	}

	ip := util.GetPrimaryIP()
	fmt.Println("\n=== Control Panel Installation Complete ===")
	fmt.Println("")
	fmt.Printf("Access Control Panel at: http://%s:%d\n", ip, port)
	fmt.Println("")

	return nil
}

// createContainer creates the container with appropriate security settings.
// Uses `incus init` (not `launch`) so we can set a static IP before starting.
// ZFS storage uses unprivileged containers (more secure).
// Dir storage may need privileged fallback in LXC environments.
func createContainer(containerName string) error {
	util.LogStep(1, 7, "Creating container...")

	// First, detect current storage driver
	storageDriver := detectStorageDriver()
	util.LogDebug(fmt.Sprintf("Storage driver detected: %s", storageDriver))

	// Try unprivileged first (preferred) — init only, don't start yet
	cmdOut, err := util.RunCmdCapture("incus", "init", "images:debian/12", containerName,
		"-c", "security.privileged=false",
		"-c", "security.nesting=true")

	if err != nil {
		// Check if idmap error (only fallback to privileged if using dir driver)
		if storageDriver == "dir" && (strings.Contains(cmdOut, "idmapped") || strings.Contains(cmdOut, "Failed to change ownership")) {
			util.LogDebug("Unprivileged failed with idmap error, trying privileged (dir driver)")

			// Clean up failed container
			exec.Command("incus", "delete", containerName, "--force").Run()

			// Try privileged as fallback
			cmdOut2, err2 := util.RunCmdCapture("incus", "init", "images:debian/12", containerName,
				"-c", "security.privileged=true",
				"-c", "security.nesting=true")

			if err2 != nil {
				util.LogError(fmt.Sprintf("Failed to create privileged container: %s", strings.TrimSpace(cmdOut2)))
				return fmt.Errorf("failed to create container: %w", err2)
			}

			util.LogSuccess(fmt.Sprintf("Container '%s' created (privileged fallback)", containerName))
			util.LogDebug("Note: Privileged container used due to idmapped storage limitation")
			util.LogDebug("Consider deploying on a system with ZFS for better security")
			incus.StorageDriver = "dir-privileged" // Track that we needed privileged
		} else {
			util.LogError(fmt.Sprintf("Failed to create container: %s", strings.TrimSpace(cmdOut)))
			return fmt.Errorf("failed to create container: %w", err)
		}
	} else {
		util.LogSuccess(fmt.Sprintf("Container '%s' created (unprivileged)", containerName))
	}

	// Set static IP before starting so the container gets the right IP on first DHCP
	if err := incus.SetContainerStaticIP(containerName); err != nil {
		util.LogDebug(fmt.Sprintf("Warning: could not set static IP: %v", err))
	}

	// Now start the container
	util.LogDebug("Starting container...")
	if _, startErr := util.RunCmdCapture("incus", "start", containerName); startErr != nil {
		return fmt.Errorf("failed to start container %s: %w", containerName, startErr)
	}

	return nil
}

// detectStorageDriver returns the current storage driver type.
func detectStorageDriver() string {
	// First check the incus package variable
	if incus.StorageDriver != "" && incus.StorageDriver != "dir" {
		return incus.StorageDriver
	}
	
	// Otherwise check Incus directly
	out, err := exec.Command("incus", "storage", "list", "--format", "csv").Output()
	if err != nil {
		return "unknown"
	}
	
	if strings.Contains(string(out), ",zfs,") {
		return "zfs"
	} else if strings.Contains(string(out), ",btrfs,") {
		return "btrfs"
	} else if strings.Contains(string(out), ",dir,") {
		return "dir"
	}
	
	return "unknown"
}

// waitForContainer waits for the container to be ready.
func waitForContainer(containerName string) error {
	util.LogStep(2, 7, "Waiting for container to start...")
	
	containerReady := false
	for i := 0; i < 30; i++ {
		out, _ := exec.Command("incus", "exec", containerName, "--", "echo", "ready").Output()
		if strings.TrimSpace(string(out)) == "ready" {
			containerReady = true
			break
		}
		time.Sleep(1 * time.Second)
		fmt.Print(".")
	}
	fmt.Println()
	
	if !containerReady {
		util.LogError("Container did not start within 30 seconds")
		return fmt.Errorf("container failed to start")
	}
	
	util.LogSuccess("Container is running")
	return nil
}

// addSocketProxies adds Incus and Spine socket proxies to the container.
func addSocketProxies(containerName, spineSocketPath string) error {
	util.LogStep(3, 7, "Adding socket proxies...")
	
	// Incus socket proxy
	util.LogSubStep("Adding Incus socket proxy...")
	util.LogDebug("This allows the Control Panel to communicate with Incus")
	util.RunIncusExec(containerName, "mkdir", "-p", "/var/lib/incus")
	if cmdOut, err := util.RunCmdCapture("incus", "config", "device", "add", containerName, "incus-socket", "proxy",
		"bind=container",
		"connect=unix:/var/lib/incus/unix.socket",
		"listen=unix:/var/lib/incus/unix.socket",
		"uid=0", "gid=0", "mode=0666"); err != nil {
		util.LogDebug(fmt.Sprintf("Incus socket proxy warning: %s", strings.TrimSpace(cmdOut)))
	} else {
		util.LogSuccess("Incus socket proxy added")
	}

	// Spine socket proxy
	util.LogSubStep("Adding YouEye socket proxy...")
	util.LogDebug("This allows the Control Panel to communicate with the YouEye API")

	// Derive the socket directory from the socket path
	spineSocketDir := "/var/run/youeye"
	if idx := strings.LastIndex(spineSocketPath, "/"); idx > 0 {
		spineSocketDir = spineSocketPath[:idx]
	}

	// Create directory on host
	os.MkdirAll(spineSocketDir, 0755)

	// Create directory inside container for initial setup
	util.RunIncusExec(containerName, "mkdir", "-p", spineSocketDir)

	// CRITICAL: Create tmpfiles.d config so socket dir is created at boot
	// This is needed because /var/run is a tmpfs that resets on reboot
	// Without this, the socket proxy device fails after reboot
	tmpfilesConfig := fmt.Sprintf("d %s 0755 root root -", spineSocketDir)
	util.RunIncusExec(containerName, "bash", "-c",
		fmt.Sprintf("echo '%s' > /etc/tmpfiles.d/youeye.conf", tmpfilesConfig))
	util.LogDebug(fmt.Sprintf("Created tmpfiles.d config for %s persistence across reboots", spineSocketDir))
	
	if cmdOut, err := util.RunCmdCapture("incus", "config", "device", "add", containerName, "youeye-socket", "proxy",
		"bind=container",
		"connect=unix:"+spineSocketPath,
		"listen=unix:"+spineSocketPath,
		"uid=0", "gid=0", "mode=0666"); err != nil {
		util.LogDebug(fmt.Sprintf("YouEye socket proxy warning: %s", strings.TrimSpace(cmdOut)))
	} else {
		util.LogSuccess("YouEye socket proxy added")
	}
	
	return nil
}

// addPortProxy adds port proxy to expose the Control Panel.
func addPortProxy(containerName string, port int) error {
	util.LogSubStep(fmt.Sprintf("Adding port %d proxy...", port))
	util.LogDebug(fmt.Sprintf("This exposes the Control Panel on host port %d", port))
	
	if cmdOut, err := util.RunCmdCapture("incus", "config", "device", "add", containerName, fmt.Sprintf("port%d", port), "proxy",
		"bind=host",
		fmt.Sprintf("listen=tcp:0.0.0.0:%d", port),
		fmt.Sprintf("connect=tcp:127.0.0.1:%d", port)); err != nil {
		util.LogError(fmt.Sprintf("Failed to add port proxy: %s", strings.TrimSpace(cmdOut)))
		return fmt.Errorf("failed to add port %d proxy: %w", port, err)
	}
	
	util.LogSuccess(fmt.Sprintf("Port %d proxy added", port))
	return nil
}

// installNodeJS installs Node.js in the container.
func installNodeJS(containerName string) error {
	util.LogStep(4, 7, "Installing Node.js in container...")
	
	util.LogSubStep("Updating package lists...")
	util.RunIncusExec(containerName, "apt-get", "update")
	
	util.LogSubStep("Installing curl, ca-certificates, and pamtester...")
	util.RunIncusExec(containerName, "apt-get", "install", "-y", "curl", "ca-certificates", "pamtester")
	
	util.LogSubStep("Setting random container root password...")
	containerPassword := util.GenerateRandomPassword(32)
	util.RunIncusExec(containerName, "bash", "-c", fmt.Sprintf("echo 'root:%s' | chpasswd", containerPassword))
	
	util.LogSubStep("Adding NodeSource repository...")
	util.RunIncusExec(containerName, "bash", "-c",
		"curl -fsSL https://deb.nodesource.com/setup_22.x | bash -")
	
	util.LogSubStep("Installing Node.js 22...")
	util.RunIncusExec(containerName, "apt-get", "install", "-y", "nodejs")
	
	util.LogSuccess("Node.js installed")
	return nil
}

// DeployControlPanelApp downloads and deploys the Control Panel application.
func DeployControlPanelApp(cfg *config.Config) error {
	containerName := cfg.Deployment.Container.Name
	appDir := cfg.Deployment.ControlPanel.AppDir
	port := cfg.Deployment.ControlPanel.Port

	// Get download URL from release assets
	util.LogSubStep("Fetching latest release info...")
	downloadURL, err := GetControlPanelDownloadURL(cfg)
	if err != nil {
		return fmt.Errorf("failed to get download URL: %w", err)
	}

	util.LogSubStep(fmt.Sprintf("Downloading from %s", downloadURL))

	// Download the tarball (IPv4-only to avoid IPv6 hangs on fresh VMs)
	client := releases.NewIPv4Client(10 * time.Minute)
	resp, err := client.Get(downloadURL)
	if err != nil {
		return fmt.Errorf("failed to download: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("download failed with status: %d", resp.StatusCode)
	}

	// Save to temp file
	tmpFile := "/tmp/control-panel.tar"
	f, err := os.Create(tmpFile)
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	
	written, err := io.Copy(f, resp.Body)
	f.Close()
	if err != nil {
		return fmt.Errorf("failed to save download: %w", err)
	}
	util.LogSuccess(fmt.Sprintf("Downloaded %.2f MB", float64(written)/1024/1024))
	defer os.Remove(tmpFile)

	// Deploy to container
	util.LogStep(6, 7, "Deploying to container...")
	util.LogSubStep(fmt.Sprintf("Creating %s directory...", appDir))
	util.RunIncusExec(containerName, "mkdir", "-p", appDir)

	util.LogSubStep("Pushing tarball to container...")
	if cmdOut, err := util.RunCmdCapture("incus", "file", "push", tmpFile, containerName+"/tmp/app.tar"); err != nil {
		util.LogError(fmt.Sprintf("Failed to push tarball: %s", strings.TrimSpace(cmdOut)))
		return fmt.Errorf("failed to push tarball: %w", err)
	}

	util.LogSubStep("Extracting tarball...")
	// Tarball contains files at root level: server.js, .next/, node_modules/, public/
	// Created by: cd .next/standalone && tar -cvf ../standalone.tar *
	if err := util.RunIncusExec(containerName, "tar", "-xf", "/tmp/app.tar", "-C", appDir, "--no-same-owner"); err != nil {
		return fmt.Errorf("failed to extract tarball: %w", err)
	}

	util.RunIncusExec(containerName, "rm", "/tmp/app.tar")

	util.LogSubStep("Installing styled-jsx dependency...")
	if err := util.RunIncusExec(containerName, "bash", "-c", fmt.Sprintf("cd %s && pnpm install styled-jsx --silent", appDir)); err != nil {
		util.LogDebug("Warning: failed to install styled-jsx, service may not start")
	}

	// Create systemd service
	util.LogSubStep("Creating systemd service...")
	jwtSecret := util.GenerateJWTSecret()
	util.LogSubStep("Generated secure JWT_SECRET for this deployment")
	
	// Generate deploy secret for Spine→CP authenticated calls
	deploySecret := util.GenerateJWTSecret()
	util.LogSubStep("Generated secure deploy secret for Spine→CP communication")

	// Save deploy secret to host filesystem so Spine can read it later
	// when calling the CP infrastructure deployment endpoint
	deploySecretDir := "/var/lib/youeye/control"
	os.MkdirAll(deploySecretDir, 0700)
	if err := os.WriteFile(deploySecretDir+"/.deploy_secret", []byte(deploySecret), 0600); err != nil {
		util.LogDebug(fmt.Sprintf("Warning: could not save deploy secret: %v", err))
	}
	
	// Get host IP for Pi-Hole DNS binding (avoids conflict with Incus dnsmasq)
	hostIP := util.GetPrimaryIP()
	util.LogDebug(fmt.Sprintf("Host IP for Control Panel: %s", hostIP))
	
	serviceContent := fmt.Sprintf(`[Unit]
Description=YouEye Control Panel
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=%s
Environment=NODE_ENV=production
Environment=PORT=%d
Environment=JWT_SECRET=%s
Environment=HOST_IP=%s
Environment=TEST_ADMIN_SECRET=%s
Environment=SECURE_COOKIES=true
ExecStart=/usr/bin/node %s/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`, appDir, port, jwtSecret, hostIP, deploySecret, appDir)

	util.RunIncusExec(containerName, "bash", "-c",
		fmt.Sprintf("cat > /etc/systemd/system/youeye-control.service << 'EOF'\n%sEOF", serviceContent))

	// Start service
	util.LogStep(7, 7, "Starting Control Panel service...")
	util.LogSubStep("Reloading systemd...")
	util.RunIncusExec(containerName, "systemctl", "daemon-reload")
	
	util.LogSubStep("Enabling service...")
	util.RunIncusExec(containerName, "systemctl", "enable", "youeye-control")
	
	util.LogSubStep("Starting service...")
	util.RunIncusExec(containerName, "systemctl", "start", "youeye-control")

	// Health check
	util.LogSubStep(fmt.Sprintf("Waiting for health check (http://127.0.0.1:%d/login)...", port))
	healthy := false
	for i := 0; i < 30; i++ {
		time.Sleep(2 * time.Second)
		out, err := exec.Command("curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
			fmt.Sprintf("http://127.0.0.1:%d/login", port)).Output()
		if err == nil && (string(out) == "200" || string(out) == "308") {
			healthy = true
			break
		}
		fmt.Print(".")
	}
	fmt.Println()

	if !healthy {
		util.LogError("Health check failed after 60 seconds")
		util.LogSubStep("Checking service status...")
		util.RunIncusExec(containerName, "systemctl", "status", "youeye-control")
		util.LogSubStep("Checking service logs...")
		util.RunIncusExec(containerName, "journalctl", "-u", "youeye-control", "-n", "20", "--no-pager")
		return fmt.Errorf("health check failed - service may not have started correctly")
	}

	version := GetInstalledVersion(containerName, appDir)
	util.LogSuccess(fmt.Sprintf("Control Panel v%s deployed successfully", version))

	return nil
}

// GetControlPanelDownloadURL gets the download URL for standalone.tar from the
// latest release matching the configured release branch. Uses the shared releases
// package to ensure consistent branch-aware filtering across deploy and update paths.
func GetControlPanelDownloadURL(cfg *config.Config) (string, error) {
	return releases.GetAssetURLForBranch(cfg, cfg.Releases.Repositories.ControlPanel, "standalone.tar", cfg.Releases.Repositories.ControlPanelTagPrefix)
}

// GetInstalledVersion gets the version from the installed package.json.
func GetInstalledVersion(containerName, appDir string) string {
	out, err := exec.Command("incus", "exec", containerName, "--",
		"cat", appDir+"/package.json").Output()
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

// addHostMeminfo mounts the host's /proc/meminfo read-only into the CP container
// at /host/proc/meminfo. The health monitor reads this to get accurate host memory
// stats for memory throttling and low-memory alerts.
func addHostMeminfo(containerName string) error {
	util.LogSubStep("Adding host /proc/meminfo mount...")

	if cmdOut, err := util.RunCmdCapture("incus", "config", "device", "add", containerName, "host-meminfo", "disk",
		"source=/proc/meminfo",
		"path=/host/proc/meminfo"); err != nil {
		util.LogDebug(fmt.Sprintf("Host meminfo mount warning: %s", strings.TrimSpace(cmdOut)))
		return err
	}

	util.LogSuccess("Host /proc/meminfo mounted at /host/proc/meminfo")
	return nil
}

// addDataVolumeMount adds a disk device that mounts /var/lib/youeye from the host
// into the CP container. This gives CP access to secrets, configs, and app data.
func addDataVolumeMount(containerName string) error {
	util.LogSubStep("Adding /var/lib/youeye volume mount...")

	// Ensure host directory exists
	os.MkdirAll("/var/lib/youeye", 0755)

	if cmdOut, err := util.RunCmdCapture("incus", "config", "device", "add", containerName, "youeye-data", "disk",
		"source=/var/lib/youeye",
		"path=/var/lib/youeye",
		"shift=true"); err != nil {
		util.LogDebug(fmt.Sprintf("Volume mount warning: %s", strings.TrimSpace(cmdOut)))
		return err
	}

	util.LogSuccess("Volume mount added for /var/lib/youeye")
	return nil
}
