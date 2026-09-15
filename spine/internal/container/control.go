// Package container provides container management for Control Panel deployment.
package container

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/incus"
	"github.com/youeye-platform/YouEye/spine/internal/releases"
	"github.com/youeye-platform/YouEye/spine/internal/update"
	"github.com/youeye-platform/YouEye/spine/internal/util"
)

// DeployControlPanel deploys the Control Panel container with all dependencies.
func DeployControlPanel(cfg *config.Config) error {
	fmt.Println("=== Deploying Control Panel ===")

	containerName := cfg.Deployment.Container.Name
	port := cfg.Deployment.ControlPanel.Port
	socketPath := cfg.API.SocketPath
	appDir := cfg.Deployment.ControlPanel.AppDir

	// Check if Incus is available
	if _, err := exec.LookPath("incus"); err != nil {
		return fmt.Errorf("Incus not found. Run 'spine install incus' first")
	}

	exists, err := exactContainerExists(containerName)
	if err != nil {
		return err
	}
	if !exists {
		if err := writeControlProvisionJournal(containerName, "creating-container"); err != nil {
			return err
		}
		if err := createContainer(containerName); err != nil {
			return err
		}
	} else {
		if _, err := util.RunCmdCapture("incus", "start", containerName); err != nil {
			state, stateErr := util.RunCmdCapture("incus", "list", containerName, "--format", "csv", "-c", "s")
			if stateErr != nil || strings.TrimSpace(state) != "RUNNING" {
				return fmt.Errorf("start existing Control Panel container: %w", err)
			}
		}
	}

	if err := waitForContainer(containerName); err != nil {
		return err
	}

	observation := inspectControlPanel(containerName, appDir)
	_, journalOwned := readControlProvisionJournal(containerName)
	if observation.AppBundle && observation.ControlUnit && observation.IdentityUnit && !observation.HostDeploySecret {
		if err := recoverDeploySecret(containerName); err != nil && !journalOwned {
			return fmt.Errorf("existing Control Panel deployment is incomplete and cannot be adopted safely: %w", err)
		}
		observation = inspectControlPanel(containerName, appDir)
	}
	if !canContinueControlProvisioning(observation, journalOwned) {
		return fmt.Errorf("existing Control Panel container is an unjournaled ambiguous partial deployment; refusing to overwrite it")
	}
	if observation.ready() {
		util.LogSuccess(fmt.Sprintf("Control Panel container '%s' is complete; reconciling it", containerName))
		if err := RepairControlPanelPortProxy(containerName, port); err != nil {
			return fmt.Errorf("failed to repair Control Panel localhost proxy: %w", err)
		}
		// A factory reset can reconstruct Incus around an already complete
		// application container while the host-side provenance file is absent.
		// Re-resolve and record the exact configured release even when no app
		// extraction is needed, so appliance health never has to infer identity
		// from container contents alone.
		recordControlProvenance(cfg, containerName, appDir)
		if err := writeControlProvisionJournal(containerName, "control-ready"); err != nil {
			return err
		}
		return nil
	}
	if err := writeControlProvisionJournal(containerName, "container-ready"); err != nil {
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
	if err := writeControlProvisionJournal(containerName, "interfaces-ready"); err != nil {
		return err
	}

	// Install Node.js
	if err := installNodeJS(containerName); err != nil {
		return err
	}
	if err := writeControlProvisionJournal(containerName, "runtime-ready"); err != nil {
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
	if err := writeControlProvisionJournal(containerName, "control-ready"); err != nil {
		return err
	}

	ip := util.GetPrimaryIP()
	fmt.Println("\n=== Control Panel Installation Complete ===")
	fmt.Println("")
	fmt.Printf("Access YouEye through Caddy at: http://%s/ or https://%s/\n", ip, ip)
	fmt.Printf("Local recovery probe remains available on this host at: http://127.0.0.1:%d\n", port)
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
	baseImage := "local:" + incus.SystemBaseImageAlias

	cmdOut, err := util.RunCmdCapture("incus", "init", baseImage, containerName,
		"-c", "security.privileged=false",
		"-c", "security.nesting=true")

	if err != nil {
		// Check if idmap error (only fallback to privileged if using dir driver)
		if storageDriver == "dir" && (strings.Contains(cmdOut, "idmapped") || strings.Contains(cmdOut, "Failed to change ownership")) {
			util.LogDebug("Unprivileged failed with idmap error, trying privileged (dir driver)")

			// Clean up failed container
			exec.Command("incus", "delete", containerName, "--force").Run()

			// Try privileged as fallback
			cmdOut2, err2 := util.RunCmdCapture("incus", "init", baseImage, containerName,
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

// incusGatewayIP returns the incusbr0 gateway address the Control Panel uses to
// reach the Incus HTTPS API.
func incusGatewayIP() string {
	out, err := util.RunCmdCapture("incus", "network", "get", "incusbr0", "ipv4.address")
	addr := strings.TrimSpace(out)
	if err != nil || addr == "" {
		return "10.87.209.1"
	}
	if i := strings.Index(addr, "/"); i > 0 {
		addr = addr[:i]
	}
	return addr
}

// setupIncusHTTPS enables the Incus HTTPS API and provisions a trusted client
// certificate for the Control Panel container, replacing the userspace
// incus-socket forkproxy.
func setupIncusHTTPS(containerName string) error {
	util.LogSubStep("Configuring Incus HTTPS API access for Control Panel...")
	gw := incusGatewayIP()

	if cmdOut, err := util.RunCmdCapture("incus", "config", "set", "core.https_address", gw+":8443"); err != nil {
		return fmt.Errorf("enable https listener: %w: %s", err, strings.TrimSpace(cmdOut))
	}

	certDir := "/var/lib/youeye/incus-client"
	os.MkdirAll(certDir, 0700)
	crt := certDir + "/cp.crt"
	key := certDir + "/cp.key"
	if _, err := os.Stat(crt); err != nil {
		if cmdOut, err := util.RunCmdCapture("openssl", "req", "-x509", "-newkey", "rsa:2048",
			"-keyout", key, "-out", crt, "-days", "3650", "-nodes",
			"-subj", "/CN=youeye-control-cp"); err != nil {
			return fmt.Errorf("generate client cert: %w: %s", err, strings.TrimSpace(cmdOut))
		}
	}

	// Trust the client cert (idempotent — a duplicate add is harmless).
	util.RunCmdCapture("incus", "config", "trust", "add-certificate", crt)

	// Push cert + key into the container for the CP service to use.
	util.RunIncusExec(containerName, "mkdir", "-p", "/etc/youeye")
	if cmdOut, err := util.RunCmdCapture("incus", "file", "push", crt, containerName+"/etc/youeye/incus-client.crt"); err != nil {
		return fmt.Errorf("push client cert: %w: %s", err, strings.TrimSpace(cmdOut))
	}
	if cmdOut, err := util.RunCmdCapture("incus", "file", "push", key, containerName+"/etc/youeye/incus-client.key"); err != nil {
		return fmt.Errorf("push client key: %w: %s", err, strings.TrimSpace(cmdOut))
	}
	util.RunIncusExec(containerName, "chmod", "600", "/etc/youeye/incus-client.key")

	util.LogSuccess("Incus HTTPS API access configured")
	return nil
}

// addSocketProxies adds Incus and Spine socket proxies to the container.
func addSocketProxies(containerName, spineSocketPath string) error {
	util.LogStep(3, 7, "Adding socket proxies...")

	// Incus API access over HTTPS replaces the legacy incus-socket forkproxy,
	// which copied every API byte in userspace and could grow without a useful
	// bound. The CP connects with a trusted client certificate instead.
	if err := setupIncusHTTPS(containerName); err != nil {
		util.LogDebug(fmt.Sprintf("Incus HTTPS setup warning: %v", err))
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

const controlSocketReadinessDropIn = `[Service]
Environment=SPINE_SOCKET=/var/run/youeye/youeye.sock
ExecStartPre=/bin/sh -c 'for i in $(seq 1 100); do test -S /var/run/youeye/youeye.sock && exit 0; sleep 0.1; done; echo "YouEye Spine socket was not ready after 10 seconds" >&2; exit 1'
`

// EnsureControlSocketReadiness makes the canonical proxied Spine socket
// explicit and prevents Control Panel or Identity from winning the Incus proxy
// listener startup race. It is called on both fresh deployment and updates so
// existing units converge to the same contract.
func EnsureControlSocketReadiness(containerName string) error {
	encoded := base64.StdEncoding.EncodeToString([]byte(controlSocketReadinessDropIn))
	script := fmt.Sprintf(`set -eu
for unit in youeye-control youeye-id; do
  test -f "/etc/systemd/system/${unit}.service" || continue
  install -d -m 0755 "/etc/systemd/system/${unit}.service.d"
  printf %%s %q | base64 -d > "/etc/systemd/system/${unit}.service.d/spine-socket.conf"
done
systemctl daemon-reload
`, encoded)
	out, err := exec.Command("incus", "exec", containerName, "--", "bash", "-c", script).CombinedOutput()
	if err != nil {
		return fmt.Errorf("reconcile Control Panel Spine socket readiness: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// addPortProxy adds port proxy to expose the Control Panel.
func addPortProxy(containerName string, port int) error {
	util.LogSubStep(fmt.Sprintf("Adding port %d proxy...", port))
	util.LogDebug(fmt.Sprintf("This exposes the Control Panel on localhost port %d for setup/recovery", port))

	if err := RepairControlPanelPortProxy(containerName, port); err != nil {
		return err
	}

	util.LogSuccess(fmt.Sprintf("Port %d localhost proxy added", port))
	return nil
}

func controlPanelPortProxyArgs(containerName string, port int) []string {
	return []string{"config", "device", "add", containerName, fmt.Sprintf("port%d", port), "proxy",
		"bind=host",
		fmt.Sprintf("listen=tcp:127.0.0.1:%d", port),
		fmt.Sprintf("connect=tcp:127.0.0.1:%d", port)}
}

// RepairControlPanelPortProxy makes the raw Control Panel host proxy
// localhost-only. Existing installs previously exposed this on 0.0.0.0:3000;
// update/reconcile paths call this to repair that drift in place.
func RepairControlPanelPortProxy(containerName string, port int) error {
	deviceName := fmt.Sprintf("port%d", port)
	_ = exec.Command("incus", "config", "device", "remove", containerName, deviceName).Run()

	if cmdOut, err := util.RunCmdCapture("incus", controlPanelPortProxyArgs(containerName, port)...); err != nil {
		util.LogError(fmt.Sprintf("Failed to add localhost port proxy: %s", strings.TrimSpace(cmdOut)))
		return fmt.Errorf("failed to add localhost port %d proxy: %w", port, err)
	}

	return VerifyControlPanelPortProxy(containerName, port)
}

func VerifyControlPanelPortProxy(containerName string, port int) error {
	out, err := util.RunCmdCapture("incus", "config", "device", "show", containerName)
	if err != nil {
		return fmt.Errorf("read %s devices: %w: %s", containerName, err, strings.TrimSpace(out))
	}
	deviceName := fmt.Sprintf("port%d:", port)
	wantListen := fmt.Sprintf("listen: tcp:127.0.0.1:%d", port)
	wantConnect := fmt.Sprintf("connect: tcp:127.0.0.1:%d", port)
	for _, want := range []string{deviceName, "bind: host", wantListen, wantConnect, "type: proxy"} {
		if !strings.Contains(out, want) {
			return fmt.Errorf("%s proxy missing %q", containerName, want)
		}
	}
	if strings.Contains(out, fmt.Sprintf("listen: tcp:0.0.0.0:%d", port)) {
		return fmt.Errorf("%s proxy still listens on all interfaces", containerName)
	}
	return nil
}

// installNodeJS installs Node.js in the container.
func installNodeJS(containerName string) error {
	util.LogStep(4, 7, "Installing Node.js in container...")
	if exec.Command("incus", "exec", containerName, "--", "sh", "-c",
		"test -x /usr/bin/node && command -v curl >/dev/null && command -v pamtester >/dev/null").Run() == nil {
		util.LogSuccess("Node.js and Control Panel prerequisites are already installed")
		return nil
	}

	if err := preflightContainerNetwork(containerName); err != nil {
		return err
	}

	util.LogSubStep("Updating package lists...")
	if err := util.RunIncusExec(containerName, "apt-get", "update"); err != nil {
		return fmt.Errorf("failed to update package lists in %s: %w", containerName, err)
	}

	util.LogSubStep("Installing curl, ca-certificates, and pamtester...")
	if err := util.RunIncusExec(containerName, "apt-get", "install", "-y", "curl", "ca-certificates", "pamtester"); err != nil {
		return fmt.Errorf("failed to install control panel prerequisites in %s: %w", containerName, err)
	}

	util.LogSubStep("Setting random container root password...")
	containerPassword := util.GenerateRandomPassword(32)
	if err := setContainerRootPassword(containerName, containerPassword); err != nil {
		return fmt.Errorf("failed to set container root password in %s: %w", containerName, err)
	}

	util.LogSubStep("Adding NodeSource repository...")
	if err := util.RunIncusExec(containerName, "bash", "-c",
		"curl -4 -fsSL https://deb.nodesource.com/setup_22.x | bash -"); err != nil {
		return fmt.Errorf("failed to add NodeSource repository in %s: %w", containerName, err)
	}

	util.LogSubStep("Installing Node.js 22...")
	if err := util.RunIncusExec(containerName, "apt-get", "install", "-y", "nodejs"); err != nil {
		return fmt.Errorf("failed to install Node.js in %s: %w", containerName, err)
	}
	if err := util.RunIncusExec(containerName, "bash", "-c", "test -x /usr/bin/node && /usr/bin/node --version"); err != nil {
		return fmt.Errorf("Node.js install verification failed in %s: %w", containerName, err)
	}

	util.LogSuccess("Node.js installed")
	return nil
}

func containerRootPasswordCommand(containerName, password string) *exec.Cmd {
	cmd := exec.Command("incus", "exec", containerName, "--", "chpasswd")
	cmd.Stdin = strings.NewReader("root:" + password + "\n")
	return cmd
}

func setContainerRootPassword(containerName, password string) error {
	out, err := containerRootPasswordCommand(containerName, password).CombinedOutput()
	if err != nil {
		return fmt.Errorf("chpasswd: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

var (
	containerNetworkPreflightAttempts = 12
	containerNetworkPreflightDelay    = 2 * time.Second
	containerNetworkSleep             = time.Sleep
)

func preflightContainerNetwork(containerName string) error {
	util.LogSubStep("Verifying container IPv4 networking...")

	checks := []struct {
		name string
		cmd  string
	}{
		{"IPv4 address", "ip -4 addr show dev eth0 | grep -q 'inet '"},
		{"IPv4 default route", "ip -4 route show default | grep -q '^default '"},
		{"Debian mirror DNS", "getent ahostsv4 deb.debian.org >/dev/null"},
		{"Debian mirror TCP", "timeout 10 bash -c '</dev/tcp/deb.debian.org/80'"},
	}

	var lastErr error
	for attempt := 1; attempt <= containerNetworkPreflightAttempts; attempt++ {
		lastErr = nil
		for _, check := range checks {
			out, err := exec.Command("incus", "exec", containerName, "--", "bash", "-c", check.cmd).CombinedOutput()
			if err != nil {
				lastErr = fmt.Errorf("%s: %w: %s", check.name, err, strings.TrimSpace(string(out)))
				break
			}
		}
		if lastErr == nil {
			util.LogSuccess("Container IPv4 networking verified")
			return nil
		}
		if attempt < containerNetworkPreflightAttempts {
			util.LogDebug(fmt.Sprintf("Container network is not ready (attempt %d/%d): %v", attempt, containerNetworkPreflightAttempts, lastErr))
			containerNetworkSleep(containerNetworkPreflightDelay)
		}
	}

	diagnostics, _ := exec.Command("incus", "exec", containerName, "--", "sh", "-c",
		"printf 'addresses: '; ip -4 -brief addr show dev eth0 2>&1; printf 'routes: '; ip -4 route 2>&1; printf 'resolver: '; tr '\\n' ' ' </etc/resolv.conf 2>&1").CombinedOutput()
	diagnosticText := strings.TrimSpace(string(diagnostics))
	if len(diagnosticText) > 4096 {
		diagnosticText = diagnosticText[:4096]
	}
	return fmt.Errorf("container network did not become ready after %d attempts (%v); diagnostics: %s",
		containerNetworkPreflightAttempts, lastErr, diagnosticText)
}

// DeployControlPanelApp downloads and deploys the Control Panel application.
func DeployControlPanelApp(cfg *config.Config) error {
	containerName := cfg.Deployment.Container.Name
	appDir := cfg.Deployment.ControlPanel.AppDir
	port := cfg.Deployment.ControlPanel.Port

	// Get download URL from release assets.
	util.LogSubStep("Fetching latest release info...")
	effectiveChannel, err := controlPanelReleaseChannel(cfg)
	if err != nil {
		return fmt.Errorf("failed to load release channel: %w", err)
	}
	downloadURL, err := releases.AssetURLForChannel(cfg, effectiveChannel, cfg.Releases.Repositories.ControlPanel, "standalone.tar", cfg.Releases.Repositories.ControlPanelTagPrefix)
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
	if err := releases.VerifySignedReleaseArtifact(client, downloadURL, tmpFile, effectiveChannel.ArtifactSHA256); err != nil {
		return fmt.Errorf("verify signed Control Panel release artifact: %w", err)
	}

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

	util.LogSubStep("Verifying bundled runtime dependencies...")
	if err := verifyControlPanelArtifact(containerName, appDir); err != nil {
		return err
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

	incusGW := incusGatewayIP()
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
Environment=INCUS_HTTPS_URL=%s:8443
Environment=INCUS_CLIENT_CERT=/etc/youeye/incus-client.crt
Environment=INCUS_CLIENT_KEY=/etc/youeye/incus-client.key
ExecStart=/usr/bin/node %s/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`, appDir, port, jwtSecret, hostIP, deploySecret, incusGW, appDir)

	util.RunIncusExec(containerName, "bash", "-c",
		fmt.Sprintf("cat > /etc/systemd/system/youeye-control.service << 'EOF'\n%sEOF", serviceContent))

	// The identity provider (port 3001) runs the same /opt/app bundle as the Control
	// Panel and shares its Incus client. It must get the same INCUS_HTTPS_URL + client
	// cert/key as the CP unit above — otherwise it falls back to the (removed) Incus
	// unix socket and returns HTTP 500 on the login flow (regression in spine-v0.4.10).
	// Keep these three Environment lines in sync with the Control Panel unit.
	identityServiceContent := fmt.Sprintf(`[Unit]
Description=Identity Provider
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=%s
Environment=NODE_ENV=production
Environment=PORT=3001
Environment=IDENTITY_SERVICE=true
Environment=JWT_SECRET=%s
Environment=HOST_IP=%s
Environment=SECURE_COOKIES=true
Environment=INCUS_HTTPS_URL=%s:8443
Environment=INCUS_CLIENT_CERT=/etc/youeye/incus-client.crt
Environment=INCUS_CLIENT_KEY=/etc/youeye/incus-client.key
ExecStart=/usr/bin/node %s/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`, appDir, util.GenerateJWTSecret(), hostIP, incusGW, appDir)

	util.RunIncusExec(containerName, "bash", "-c",
		fmt.Sprintf("cat > /etc/systemd/system/youeye-id.service << 'EOF'\n%sEOF", identityServiceContent))
	if err := EnsureControlSocketReadiness(containerName); err != nil {
		return err
	}

	// Start service
	util.LogStep(7, 7, "Starting Control Panel service...")
	util.LogSubStep("Reloading systemd...")
	util.RunIncusExec(containerName, "systemctl", "daemon-reload")

	util.LogSubStep("Enabling service...")
	util.RunIncusExec(containerName, "systemctl", "enable", "youeye-control")
	util.RunIncusExec(containerName, "systemctl", "enable", "youeye-id")

	util.LogSubStep("Starting service...")
	util.RunIncusExec(containerName, "systemctl", "start", "youeye-control")
	util.RunIncusExec(containerName, "systemctl", "start", "youeye-id")

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

	// Record channel provenance for the installed release.
	recordControlProvenance(cfg, containerName, appDir)

	return nil
}

func verifyControlPanelArtifact(containerName, appDir string) error {
	required := []string{
		"server.js",
		"package.json",
		"node_modules/styled-jsx/package.json",
	}
	for _, path := range required {
		fullPath := fmt.Sprintf("%s/%s", appDir, path)
		if err := util.RunIncusExec(containerName, "test", "-e", fullPath); err != nil {
			return fmt.Errorf("control panel artifact is missing required file %s: %w", fullPath, err)
		}
	}
	util.LogSuccess("Bundled runtime dependencies verified")
	return nil
}

func controlPanelReleaseChannel(cfg *config.Config) (channels.Channel, error) {
	chCfg, err := channels.Load()
	if err != nil {
		return channels.Channel{}, err
	}
	return chCfg.Effective(channels.ComponentControl, cfg), nil
}

// recordControlProvenance records the installed Control Panel release into the
// core provenance file after a deploy. Resolution failures are non-fatal — the
// deploy already succeeded — but are logged.
func recordControlProvenance(cfg *config.Config, containerName, appDir string) {
	chCfg, err := channels.Load()
	if err != nil {
		util.LogDebug(fmt.Sprintf("provenance: load channels failed: %v", err))
		return
	}
	cand, err := releases.ResolveComponent(cfg, channels.ComponentControl, cfg.Releases.Repositories.ControlPanel, cfg.Releases.Repositories.ControlPanelTagPrefix)
	if err != nil {
		util.LogDebug(fmt.Sprintf("provenance: resolve control failed: %v", err))
		return
	}
	// Prefer the actually-installed package.json version when available.
	installedVer := GetInstalledVersion(containerName, appDir)
	ver := cand.Version
	if installedVer != "" && installedVer != "unknown" {
		ver = installedVer
	}
	_ = chCfg
	if err := update.WriteProvenance(channels.ComponentControl, update.ProvenanceEntry{
		Version:        ver,
		Tag:            cand.Tag,
		Branch:         cand.Branch,
		Source:         cand.Source,
		ArtifactSHA256: cand.ArtifactSHA256,
	}); err != nil {
		util.LogDebug(fmt.Sprintf("provenance: write control failed: %v", err))
	}
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
