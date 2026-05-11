package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"git.byka.wtf/potemsla/YouEye/spine/internal/config"
	"git.byka.wtf/potemsla/YouEye/spine/internal/util"
	"git.byka.wtf/potemsla/YouEye/spine/internal/version"
	"github.com/spf13/cobra"
)

// ensureSpineUpToDate is invoked at the very top of `spine deploy`. It checks
// the configured release source for a newer Spine binary and, if found, runs
// the existing self-update path and re-execs the new binary in place. Any
// failure (network, download, exec) is logged as a warning and the deploy
// continues with the current binary.
//
// To prevent infinite re-exec loops, the post-update child process is given
// the SPINE_DEPLOY_UPDATED=1 env var, and runDeploy() skips this function
// when that var is set.
func ensureSpineUpToDate(cfg *config.Config) {
	fmt.Println("Checking for Spine updates...")
	hasUpdate, latest := checkSpineUpdate(cfg)
	if !hasUpdate || latest == "" {
		fmt.Printf("Spine is up to date (%s).\n\n", Version)
		return
	}
	if !version.IsNewer(latest, Version) {
		fmt.Printf("Spine is up to date (%s).\n\n", Version)
		return
	}

	fmt.Printf("Spine %s available (current: %s). Updating before deploy...\n", latest, Version)
	if err := updateSelf(); err != nil {
		fmt.Printf("Warning: self-update failed: %v\n", err)
		fmt.Println("Proceeding with current version...")
		fmt.Println()
		return
	}

	binary, err := os.Executable()
	if err != nil {
		fmt.Printf("Warning: could not resolve binary path for re-exec: %v\n", err)
		fmt.Println("Proceeding with current version...")
		fmt.Println()
		return
	}

	fmt.Println("Spine updated. Restarting deploy with new version...")
	env := append(os.Environ(), "SPINE_DEPLOY_UPDATED=1")
	if err := syscall.Exec(binary, os.Args, env); err != nil {
		// syscall.Exec only returns on failure.
		fmt.Printf("Warning: re-exec failed: %v\n", err)
		fmt.Println("Proceeding with current version...")
		fmt.Println()
	}
}

var deployCmd = &cobra.Command{
	Use:   "deploy",
	Short: "Full deployment (Incus + Control Panel + Infrastructure)",
	Long:  `Deploy the complete YouEye infrastructure including Incus, Control Panel, and all apps.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		return runDeploy()
	},
}

// waitForSocket waits for the API socket to become available
func waitForSocket(socketPath string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(socketPath); err == nil {
			conn, err := net.DialTimeout("unix", socketPath, 100*time.Millisecond)
			if err == nil {
				conn.Close()
				return nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("timeout waiting for socket at %s", socketPath)
}

func runDeploy() error {
	cfg := GetConfig()

	fmt.Println("========================================")
	fmt.Println("  YouEye Full Deployment")
	fmt.Println("========================================")
	fmt.Println("")

	// Step 0: ensure Spine itself is up to date before deploying.
	// We never block the deploy on network failures — if the check or the
	// update itself fails we log a warning and continue with the current
	// binary. The SPINE_DEPLOY_UPDATED env var is used as a re-exec guard
	// so a fresh post-update binary doesn't loop forever.
	if os.Getenv("SPINE_DEPLOY_UPDATED") != "1" {
		ensureSpineUpToDate(cfg)
	}

	// Stop the spine systemd service (if running from a previous deploy)
	// before starting a new detached API process. Without this, systemd's
	// Restart=always respawns the old API after pkill, causing two
	// concurrent `spine api serve` processes whose runHostIPCheck goroutines
	// race with the CP's infrastructure deployment (BUG: Pi-Hole "already running").
	exec.Command("systemctl", "stop", "spine").Run()
	exec.Command("systemctl", "disable", "spine").Run()

	// Kill any remaining Spine API processes (fallback if service wasn't active)
	exec.Command("pkill", "-9", "-f", "spine api serve").Run()

	// Create base data directories
	createDataDirectories()

	// Step 1: Install Incus
	fmt.Println("[1/4] Installing Incus...")
	if err := installIncus(); err != nil {
		return fmt.Errorf("Incus installation failed: %w", err)
	}
	fmt.Println("")

	// Step 2: Start API server (as detached process)
	fmt.Println("[2/4] Starting Spine API server...")

	socketDir := "/var/run/spine"
	os.MkdirAll(socketDir, 0755)

	apiCmd := exec.Command("spine", "api", "serve")
	apiCmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true,
	}
	apiCmd.Stdout = nil
	apiCmd.Stderr = nil
	apiCmd.Stdin = nil
	if err := apiCmd.Start(); err != nil {
		fmt.Printf("Warning: could not start API server: %v\n", err)
	} else {
		if err := waitForSocket(cfg.API.SocketPath, 5*time.Second); err != nil {
			fmt.Printf("Warning: API socket not ready: %v\n", err)
		}
	}
	fmt.Println("✓ API server started")
	fmt.Println("")

	// Ensure swap exists as a safety net for memory pressure
	ensureSwapFile()

	// Step 3: Deploy Control Panel container
	fmt.Println("[3/4] Deploying Control Panel...")
	if err := installControl(); err != nil {
		return fmt.Errorf("Control Panel deployment failed: %w", err)
	}

	// Step 4: Deploy all infrastructure via Control Panel SSE endpoint
	fmt.Println("\n[4/4] Deploying infrastructure apps via Control Panel...")
	if err := deployInfrastructureViaCP(); err != nil {
		return fmt.Errorf("Infrastructure deployment failed: %w", err)
	}

	// Provision the UI bridge token to both containers
	provisionBridgeToken()

	// Provision CLI authentication token for the `youeye` CLI tool
	provisionCLIToken()

	// Auto-enable Spine API on boot
	enableSpineService()

	ip := util.GetPrimaryIP()

	// Persist the host IP so the next `spine api serve` startup recognises
	// any future change. Without this seed, the first post-deploy boot
	// would write the file as a no-op (first-run path) and any IP change
	// between deploy and that boot would be missed.
	if err := util.WriteStoredHostIP(ip); err != nil {
		fmt.Printf("Warning: could not persist host IP %s to %s: %v\n", ip, util.HostIPFile, err)
	}

	fmt.Println("")
	fmt.Println("========================================")
	fmt.Println("  Deployment Complete!")
	fmt.Println("========================================")
	fmt.Println("")
	fmt.Printf("Setup URL:     https://%s\n", ip)
	fmt.Printf("Control Panel: http://%s:3000\n", ip)
	fmt.Printf("Pi-Hole DNS:   %s:53\n", ip)
	fmt.Println("")

	return nil
}

// deployInfrastructureViaCP calls the Control Panel SSE endpoint to deploy
// all infrastructure apps (PostgreSQL, Authentik, Caddy, Pi-Hole, UI).
func deployInfrastructureViaCP() error {
	hostIP := util.GetPrimaryIP()

	// Read deploy secret from host file (written during CP container creation)
	secretBytes, err := os.ReadFile("/var/lib/youeye/control/.deploy_secret")
	if err != nil {
		return fmt.Errorf("cannot read deploy secret: %w", err)
	}
	deploySecret := strings.TrimSpace(string(secretBytes))

	// POST to Control Panel deployment endpoint
	body := fmt.Sprintf(`{"host_ip":"%s"}`, hostIP)
	req, err := http.NewRequest("POST", "http://127.0.0.1:3000/api/deploy/infrastructure", strings.NewReader(body))
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
	var lastEvent deploymentEvent
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
		lastEvent = event

		// Print progress
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
		if event.Detail != "" && event.Status == "error" {
			fmt.Printf("    Detail: %s\n", event.Detail)
		}
	}

	if scanner.Err() != nil {
		return fmt.Errorf("error reading SSE stream: %w (last event: step=%d status=%s)", scanner.Err(), lastEvent.Step, lastEvent.Status)
	}

	// Check if last event indicates overall failure
	if lastEvent.Status == "error" && lastEvent.Step <= 3 {
		return fmt.Errorf("critical deployment step %d failed: %s", lastEvent.Step, lastEvent.Message)
	}

	return nil
}

type deploymentEvent struct {
	Step       int    `json:"step"`
	TotalSteps int    `json:"totalSteps"`
	Status     string `json:"status"`
	Message    string `json:"message"`
	Detail     string `json:"detail,omitempty"`
}

// provisionBridgeToken generates a shared bridge token and pushes it to both
// the Control Panel and UI containers. This token is used for server-to-server
// authentication between the UI and CP bridge API.
//
// The token is stored on the host at /var/lib/youeye/control/.bridge_token
// and pushed to /etc/youeye/ui-bridge-token in both containers.
// If a token already exists on the host, it is reused (idempotent).
func provisionBridgeToken() {
	fmt.Println("Provisioning UI bridge token...")

	hostTokenPath := "/var/lib/youeye/control/.bridge_token"
	containerTokenPath := "/etc/youeye/ui-bridge-token"

	// Determine the token to use. Priority:
	// 1. Existing host-side token (from previous deploy)
	// 2. Token already inside the CP container (if CP auto-generated one)
	// 3. Generate a new token
	var token string
	if data, err := os.ReadFile(hostTokenPath); err == nil && len(strings.TrimSpace(string(data))) == 64 {
		token = strings.TrimSpace(string(data))
		fmt.Println("  Using existing bridge token from host")
	} else if out, err := exec.Command("incus", "exec", "youeye-control", "--",
		"cat", containerTokenPath).Output(); err == nil && len(strings.TrimSpace(string(out))) == 64 {
		token = strings.TrimSpace(string(out))
		fmt.Println("  Using existing bridge token from CP container")
	} else {
		token = util.GenerateBridgeToken()
		fmt.Println("  Generated new bridge token")
	}

	// Always persist the token on the host
	os.MkdirAll("/var/lib/youeye/control", 0700)
	if err := os.WriteFile(hostTokenPath, []byte(token), 0600); err != nil {
		fmt.Printf("  Warning: could not save bridge token to host: %v\n", err)
	}

	// Write token to a temp file for pushing to containers
	tmpFile := "/tmp/.ye-bridge-token"
	if err := os.WriteFile(tmpFile, []byte(token), 0600); err != nil {
		fmt.Printf("  Warning: could not write temp token file: %v\n", err)
		return
	}
	defer os.Remove(tmpFile)

	// Push token to both containers
	containers := []string{"youeye-control", "youeye-ui"}
	needCPRestart := false
	for _, ctr := range containers {
		// Check if container exists and is running
		out, err := exec.Command("incus", "list", ctr, "--format", "csv", "-c", "s").Output()
		if err != nil || !strings.Contains(strings.ToUpper(string(out)), "RUNNING") {
			fmt.Printf("  Skipping %s (not running)\n", ctr)
			continue
		}

		// Ensure /etc/youeye directory exists inside container
		exec.Command("incus", "exec", ctr, "--", "mkdir", "-p", "/etc/youeye").Run()

		// Check if the container already has the correct token
		existingOut, _ := exec.Command("incus", "exec", ctr, "--", "cat", containerTokenPath).Output()
		if strings.TrimSpace(string(existingOut)) == token {
			fmt.Printf("  ✓ %s already has correct token\n", ctr)
			continue
		}

		// Push the token file
		target := ctr + containerTokenPath
		if err := util.RunCmdQuiet("incus", "file", "push", tmpFile, target); err != nil {
			fmt.Printf("  Warning: could not push token to %s: %v\n", ctr, err)
			continue
		}

		// Set restrictive permissions
		exec.Command("incus", "exec", ctr, "--", "chmod", "600", containerTokenPath).Run()

		fmt.Printf("  ✓ Token pushed to %s\n", ctr)

		// If CP got a new/different token, it needs a restart to clear in-memory cache
		if ctr == "youeye-control" {
			needCPRestart = true
		}
	}

	// Restart CP if its token file changed (to clear the in-memory token cache)
	if needCPRestart {
		fmt.Println("  Restarting Control Panel to apply new token...")
		exec.Command("incus", "exec", "youeye-control", "--",
			"systemctl", "restart", "youeye-control").Run()
		// Brief wait for CP to come back up
		time.Sleep(3 * time.Second)
	}

	fmt.Println("✓ Bridge token provisioned")
}

// provisionCLIToken generates a CLI authentication token and pushes it to the
// Control Panel container. This token allows the `youeye` CLI tool to call
// CP API endpoints without a browser session.
//
// The token is stored on the host at /var/lib/youeye/config/cli-token (0600)
// and pushed to /etc/youeye/cli-token in the CP container.
func provisionCLIToken() {
	fmt.Println("Provisioning CLI authentication token...")

	hostTokenPath := "/var/lib/youeye/config/cli-token"
	containerTokenPath := "/etc/youeye/cli-token"

	// Reuse existing token if it exists, otherwise generate a new one
	var token string
	if data, err := os.ReadFile(hostTokenPath); err == nil && len(strings.TrimSpace(string(data))) == 64 {
		token = strings.TrimSpace(string(data))
		fmt.Println("  Using existing CLI token from host")
	} else {
		token = util.GenerateBridgeToken()
		fmt.Println("  Generated new CLI token")
	}

	// Persist on host
	os.MkdirAll("/var/lib/youeye/config", 0700)
	if err := os.WriteFile(hostTokenPath, []byte(token), 0600); err != nil {
		fmt.Printf("  Warning: could not save CLI token: %v\n", err)
		return
	}

	// Push to CP container
	out, err := exec.Command("incus", "list", "youeye-control", "--format", "csv", "-c", "s").Output()
	if err != nil || !strings.Contains(strings.ToUpper(string(out)), "RUNNING") {
		fmt.Println("  Skipping CP push (not running)")
		return
	}

	exec.Command("incus", "exec", "youeye-control", "--", "mkdir", "-p", "/etc/youeye").Run()

	existingOut, _ := exec.Command("incus", "exec", "youeye-control", "--", "cat", containerTokenPath).Output()
	if strings.TrimSpace(string(existingOut)) == token {
		fmt.Println("  ✓ CP already has correct CLI token")
	} else {
		tmpFile := "/tmp/.ye-cli-token"
		if err := os.WriteFile(tmpFile, []byte(token), 0600); err != nil {
			fmt.Printf("  Warning: could not write temp CLI token: %v\n", err)
			return
		}
		defer os.Remove(tmpFile)

		if err := util.RunCmdQuiet("incus", "file", "push", tmpFile, "youeye-control"+containerTokenPath); err != nil {
			fmt.Printf("  Warning: could not push CLI token to CP: %v\n", err)
			return
		}
		exec.Command("incus", "exec", "youeye-control", "--", "chmod", "600", containerTokenPath).Run()
		fmt.Println("  ✓ CLI token pushed to CP")
	}

	fmt.Println("✓ CLI token provisioned")
}

// enableSpineService creates and enables the Spine systemd service
func enableSpineService() {
	// Always update service file to ensure latest configuration
	// (handles upgrades from older versions)
	// We MUST order spine.service after network-online.target (not just
	// network.target) because the host-IP-change check inside `spine api
	// serve` calls util.GetPrimaryIP() at startup. network.target only
	// guarantees "interfaces are up", NOT "DHCP has assigned addresses".
	// On a slow-DHCP boot, GetPrimaryIP() would race and return either
	// the placeholder (refusing to migrate) or — worse — could in some
	// edge cases pick up the Incus bridge IP. network-online.target +
	// systemd-networkd-wait-online.service makes systemd block until at
	// least one routable address is configured.
	// Ordering rationale:
	//   - network-online.target so DHCP has assigned the LAN IP before
	//     util.GetPrimaryIP() runs (otherwise we'd race DHCP at boot and
	//     either return the placeholder or pick up the Incus bridge IP).
	//
	// We DO NOT order spine.service After=incus.service, even though the
	// host-IP-check goroutine talks to the Incus daemon. The reason is
	// BUG-005, hit in the 0.2.18.7 physical IP-change test:
	//
	//   - youeye-ui has a proxy device that listens on
	//     /var/run/spine/spine.sock (the Spine API socket).
	//   - incus.service auto-starts boot.autostart=true containers as
	//     part of its own startup, BEFORE waitready returns.
	//   - youeye-ui can't start until /var/run/spine/spine.sock exists,
	//     i.e. until spine.service is active.
	//   - With After=incus.service, spine.service was queued behind
	//     incus.service waiting for it to be active.
	//   - Cascading deadlock: incus → ui → spine.sock → spine.service →
	//     incus.service. Boot stuck forever.
	//
	// Spine and Incus must start in PARALLEL (both After=network-online).
	// At goroutine startup time, the daemon may still be initializing —
	// that's fine, the `incus` CLI commands have their own timeouts via
	// runWithTimeout, and `incus.socket` socket-activates incusd anyway
	// if it's not yet running.
	//
	// We also do NOT use `Before=incus-startup.service` or any ExecStartPre.
	// The 0.2.18.6 attempt did, on the assumption that incus-startup
	// brings up boot.autostart=true containers — that turned out to be
	// wrong (incus.service itself starts them as part of its own startup,
	// before waitready returns), so the ExecStartPre approach couldn't
	// fix the pihole proxy device before pihole came up broken.
	//
	// The fix in 0.2.18.7+ is structural: pihole is created with
	// boot.autostart=false (see piholeManifest in YE-ControlPanel) so
	// Incus never auto-starts it; Spine becomes the canonical owner of
	// pihole's boot lifecycle and starts it from the host-IP-check
	// goroutine after fixing the proxy device on a guaranteed-stopped
	// container.
	serviceContent := `[Unit]
Description=YouEye Spine - System Management Service
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStartPre=/bin/mkdir -p /var/run/spine
ExecStart=/usr/local/bin/spine api serve
# Wait for socket to be ready before service is considered started
# This ensures dependent services (incus-startup) start after socket exists
ExecStartPost=/bin/bash -c 'for i in {1..50}; do [ -S /var/run/spine/spine.sock ] && exit 0; sleep 0.1; done; exit 1'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`
	if err := os.WriteFile("/etc/systemd/system/spine.service", []byte(serviceContent), 0644); err != nil {
		fmt.Printf("Warning: could not create service file: %v\n", err)
		return
	}

	// Reload systemd and enable service
	exec.Command("systemctl", "daemon-reload").Run()
	if err := exec.Command("systemctl", "enable", "--now", "spine").Run(); err != nil {
		fmt.Printf("Warning: could not enable spine service: %v\n", err)
		return
	}
	fmt.Println("✓ Spine API enabled on boot")

	// Configure Incus startup to wait for Spine socket
	configureIncusStartupDependency()
}

// configureIncusStartupDependency creates a systemd override so incus-startup.service
// waits for spine.service before starting containers. This ensures the Spine socket
// exists before containers with spine-socket proxy devices try to start.
func configureIncusStartupDependency() {
	overrideDir := "/etc/systemd/system/incus-startup.service.d"
	overrideFile := overrideDir + "/spine-dependency.conf"

	// Check if override already exists
	if _, err := os.Stat(overrideFile); err == nil {
		return // Already configured
	}

	// Create override directory
	if err := os.MkdirAll(overrideDir, 0755); err != nil {
		fmt.Printf("Warning: could not create systemd override directory: %v\n", err)
		return
	}

	// Create override file that makes incus-startup wait for spine
	overrideContent := `[Unit]
# Wait for Spine API socket before starting containers
# This ensures containers with spine-socket proxy device can start successfully
After=spine.service
Wants=spine.service
`
	if err := os.WriteFile(overrideFile, []byte(overrideContent), 0644); err != nil {
		fmt.Printf("Warning: could not create systemd override: %v\n", err)
		return
	}

	// Reload systemd to pick up the new override
	exec.Command("systemctl", "daemon-reload").Run()
	fmt.Println("✓ Incus configured to wait for Spine")
}

// createDataDirectories creates the base directory structure for app persistent storage.
// These directories are used by Incus disk devices are mounted into containers.
func createDataDirectories() {
	basePath := "/var/lib/youeye"
	
	dirs := []string{
		basePath,
		basePath + "/caddy/config",
		basePath + "/caddy/data",
		basePath + "/postgres/data",
		basePath + "/authentik/media",
		basePath + "/authentik/certs",
		basePath + "/authentik/templates",
		basePath + "/pihole/etc",
		basePath + "/pihole/dnsmasq",
		basePath + "/config",
		basePath + "/control/data",
		basePath + "/ui",
	}
	
	fmt.Println("Creating YouEye data directories...")
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0755); err != nil {
			fmt.Printf("Warning: could not create %s: %v\n", dir, err)
		}
	}
	fmt.Println("✓ Data directories created at /var/lib/youeye/")
}

// ensureSwapFile creates a swap file if none exists.
// Swap converts memory pressure from "app gets killed" into "app slows down".
// Skipped inside LXC containers (swap is managed by the host/Proxmox).
func ensureSwapFile() {
	const swapPath = "/var/lib/youeye/swapfile"

	// Check if swap already exists
	out, _ := exec.Command("swapon", "--show", "--noheadings").Output()
	if len(strings.TrimSpace(string(out))) > 0 {
		return // swap already active
	}

	// Detect LXC environment — can't create swap inside a container
	if err := exec.Command("systemd-detect-virt", "-c").Run(); err == nil {
		fmt.Println("Running inside a container — skipping swap creation")
		return
	}

	// Read total RAM in MB
	meminfo, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		fmt.Printf("Warning: could not read /proc/meminfo: %v\n", err)
		return
	}
	totalRAM := 0
	for _, line := range strings.Split(string(meminfo), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kb, _ := strconv.Atoi(fields[1])
				totalRAM = kb / 1024 // convert to MB
			}
			break
		}
	}
	if totalRAM == 0 {
		return
	}

	// Read available disk space in MB
	dfOut, err := exec.Command("df", "/", "--output=avail", "-BM").Output()
	if err != nil {
		fmt.Printf("Warning: could not check disk space: %v\n", err)
		return
	}
	dfLines := strings.Split(strings.TrimSpace(string(dfOut)), "\n")
	diskFreeMB := 0
	if len(dfLines) >= 2 {
		diskFreeMB, _ = strconv.Atoi(strings.TrimRight(strings.TrimSpace(dfLines[len(dfLines)-1]), "M"))
	}
	if diskFreeMB == 0 {
		return
	}

	// Calculate: min(RAM, 10% of disk, 8GB cap), floor 512MB
	swapMB := totalRAM
	disk10pct := diskFreeMB / 10
	if disk10pct < swapMB {
		swapMB = disk10pct
	}
	if swapMB > 8192 {
		swapMB = 8192
	}
	if swapMB < 512 {
		swapMB = 512
	}

	fmt.Printf("Creating %d MB swap file at %s...\n", swapMB, swapPath)

	if err := exec.Command("fallocate", "-l", fmt.Sprintf("%dM", swapMB), swapPath).Run(); err != nil {
		fmt.Printf("Warning: fallocate failed: %v\n", err)
		return
	}
	if err := os.Chmod(swapPath, 0600); err != nil {
		fmt.Printf("Warning: chmod failed: %v\n", err)
		return
	}
	if err := exec.Command("mkswap", swapPath).Run(); err != nil {
		fmt.Printf("Warning: mkswap failed: %v\n", err)
		return
	}
	if err := exec.Command("swapon", swapPath).Run(); err != nil {
		fmt.Printf("Warning: swapon failed: %v\n", err)
		return
	}

	// Add to fstab for persistence across reboots
	fstabLine := swapPath + " swap swap defaults 0 0\n"
	fstab, _ := os.ReadFile("/etc/fstab")
	if !strings.Contains(string(fstab), swapPath) {
		f, err := os.OpenFile("/etc/fstab", os.O_APPEND|os.O_WRONLY, 0644)
		if err == nil {
			f.WriteString(fstabLine)
			f.Close()
		}
	}

	fmt.Printf("✓ Swap file created (%d MB)\n", swapMB)
}
