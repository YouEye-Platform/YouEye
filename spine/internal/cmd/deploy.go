package cmd

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	hoststorage "github.com/youeye-platform/YouEye/spine/internal/storage"
	"github.com/youeye-platform/YouEye/spine/internal/util"
	"github.com/youeye-platform/YouEye/spine/internal/version"
)

// deployStorage* cache the storage decision resolved once at the top of
// runDeploy so installIncus() reuses it (avoids re-resolving after the pool
// already exists, which would classify differently). nil when `spine install
// incus` runs standalone — installIncus() then resolves on its own.
var (
	deployStorageDecision *hoststorage.StorageDecision
	deployStoragePlan     *hoststorage.Plan
	deployStoragePolicy   *hoststorage.Policy
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

var resumeDeployment bool

func init() {
	deployCmd.Flags().BoolVar(&resumeDeployment, "resume", false,
		"reconcile existing infrastructure and resume required finalisation without reinstalling containers")
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
	runtimeStatus, manifest, err := applianceRuntime()
	if err != nil {
		return err
	}
	isAppliance := runtimeStatus.Kind == "appliance-image"
	if isAppliance {
		if manifest == nil {
			return fmt.Errorf("appliance manifest is unavailable")
		}
		if err := verifyApplianceImagePrerequisites(*manifest); err != nil {
			return err
		}
		if err := verifyApplianceReleaseSet(*manifest, cfg); err != nil {
			return fmt.Errorf("appliance release set: %w", err)
		}
	}

	fmt.Println("========================================")
	fmt.Println("  YouEye Full Deployment")
	fmt.Println("========================================")
	fmt.Println("")
	if resumeDeployment {
		if isAppliance {
			decision, plan, policy, err := resolveStorageDecision()
			if err != nil {
				return err
			}
			if err := prepareApplianceStorage(decision); err != nil {
				return err
			}
			deployStorageDecision = &decision
			deployStoragePlan = &plan
			deployStoragePolicy = &policy
		}
		// Resume must reconcile the exact Control Panel release as well as the
		// infrastructure apps. In particular, a factory-reset reconstruction may
		// leave a complete container but no host-side installed provenance.
		if err := installControl(); err != nil {
			return fmt.Errorf("Control Panel reconciliation failed: %w", err)
		}
		return resumeExistingDeployment()
	}

	// Step 0: ensure Spine itself is up to date before deploying.
	// We never block the deploy on network failures — if the check or the
	// update itself fails we log a warning and continue with the current
	// binary. The SPINE_DEPLOY_UPDATED env var is used as a re-exec guard
	// so a fresh post-update binary doesn't loop forever.
	if !isAppliance && os.Getenv("SPINE_DEPLOY_UPDATED") != "1" {
		ensureSpineUpToDate(cfg)
	}

	// Stop the spine systemd service (if running from a previous deploy)
	// before starting a new detached API process. Without this, systemd's
	// Restart=always respawns the old API after pkill, causing two
	// concurrent `spine api serve` processes whose runHostIPCheck goroutines
	// race with the CP's infrastructure deployment (BUG: Pi-Hole "already running").
	// Stop old spine.service OR new youeye.service (handles migration)
	exec.Command("systemctl", "stop", "youeye").Run()
	if isAppliance {
		// Persistent /var/lib/incus must be mounted before the baked daemon is
		// reconciled. Stop runtime activity; do not disable or rewrite its unit.
		exec.Command("systemctl", "stop", "incus").Run()
	}
	if !isAppliance {
		exec.Command("systemctl", "disable", "youeye").Run()
		exec.Command("systemctl", "stop", "spine").Run()
		exec.Command("systemctl", "disable", "spine").Run()
	}

	// Kill any remaining API processes (fallback if service wasn't active)
	exec.Command("pkill", "-9", "-f", "youeye api serve").Run()
	exec.Command("pkill", "-9", "-f", "spine api serve").Run()

	// Resolve the storage decision and prepare dedicated-disk data storage
	// BEFORE createDataDirectories(): for a dedicated-disk deploy the
	// default/data dataset must be mounted at /var/lib/youeye so the data
	// directories land on ZFS, not shadowed on the root filesystem.
	emitFirstDeployProgress("storage", "Preparing persistent storage", 36)
	decision, plan, policy, err := resolveStorageDecision()
	if err != nil {
		return err
	}
	if decision.Hint != "" {
		fmt.Printf("  ℹ %s\n", decision.Hint)
	}
	if decision.Kind == hoststorage.DecisionFail {
		return fmt.Errorf("storage: %s", decision.Reason)
	}
	fmt.Printf("Storage plan: %s — %s\n", decision.Kind, decision.Reason)
	if err := prepareApplianceStorage(decision); err != nil {
		return err
	}
	// Cache the resolved decision so installIncus() reuses it instead of
	// re-resolving (which could differ once the pool exists).
	deployStorageDecision = &decision
	deployStoragePlan = &plan
	deployStoragePolicy = &policy

	// Create base data directories (now on ZFS when dedicated-disk-backed).
	createDataDirectories()

	// Step 1: Install Incus
	emitFirstDeployProgress("incus", "Starting the container runtime", 42)
	fmt.Println("[1/4] Installing Incus...")
	if err := installIncus(); err != nil {
		return fmt.Errorf("Incus installation failed: %w", err)
	}
	fmt.Println("")

	// Step 2: Start API server (as detached process)
	emitFirstDeployProgress("system_core", "Starting the System core", 48)
	fmt.Println("[2/4] Starting YouEye API server...")

	socketDir := "/var/run/youeye"
	os.MkdirAll(socketDir, 0755)

	apiCmd := exec.Command("youeye", "api", "serve")
	apiCmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true,
	}
	apiCmd.Stdout = nil
	apiCmd.Stderr = nil
	apiCmd.Stdin = nil
	if err := apiCmd.Start(); err != nil {
		fmt.Printf("Warning: could not start API server: %v\n", err)
	} else {
		// Start() leaves the API server as our child even though Setsid gives it
		// an independent session. Always Wait in the background so a SIGTERM'd
		// server is reaped instead of remaining a zombie until deploy exits.
		reapDetachedProcess(apiCmd)
		if err := waitForSocket(cfg.API.SocketPath, 5*time.Second); err != nil {
			fmt.Printf("Warning: API socket not ready: %v\n", err)
		}
	}
	fmt.Println("✓ API server started")
	fmt.Println("")

	// Ensure swap exists as a safety net for memory pressure
	if !isAppliance {
		ensureSwapFile()
	}

	// Step 3: Deploy Control Panel container
	emitFirstDeployProgress("server_interface", "Installing the Server interface", 55)
	fmt.Println("[3/4] Deploying Control Panel...")
	if err := installControl(); err != nil {
		return fmt.Errorf("Control Panel deployment failed: %w", err)
	}

	// Step 4: Deploy all infrastructure via Control Panel SSE endpoint
	fmt.Println("\n[4/4] Deploying infrastructure apps via Control Panel...")
	if err := deployInfrastructureViaCP(); err != nil {
		return fmt.Errorf("Infrastructure deployment failed: %w", err)
	}

	ip := util.GetPrimaryIP()
	if err := finalizeDeployment(ip); err != nil {
		return fmt.Errorf("deployment finalisation incomplete: %w", err)
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

func resumeExistingDeployment() error {
	hostIP := util.GetPrimaryIP()
	if err := requireContainerRunning("youeye-control"); err != nil {
		return fmt.Errorf("cannot resume without the existing Control Panel: %w", err)
	}
	secretBytes, err := os.ReadFile("/var/lib/youeye/control/.deploy_secret")
	if err != nil {
		return fmt.Errorf("cannot read deploy secret: %w", err)
	}
	client := newDeploymentJobClient(deploymentBaseURL, strings.TrimSpace(string(secretBytes)))
	if err := client.execute("reconcile", hostIP); err != nil {
		return fmt.Errorf("infrastructure reconciliation failed: %w", err)
	}
	if err := finalizeDeployment(hostIP); err != nil {
		return fmt.Errorf("deployment finalisation incomplete: %w", err)
	}

	fmt.Println("")
	fmt.Println("========================================")
	fmt.Println("  Deployment Resumed and Verified!")
	fmt.Println("========================================")
	fmt.Printf("Setup URL: https://%s\n", hostIP)
	return nil
}

// deployInfrastructureViaCP calls the Control Panel SSE endpoint to deploy
// all infrastructure apps (PostgreSQL, Caddy, Pi-Hole, UI).
func deployInfrastructureViaCP() error {
	hostIP := util.GetPrimaryIP()

	// Read deploy secret from host file (written during CP container creation)
	secretBytes, err := os.ReadFile("/var/lib/youeye/control/.deploy_secret")
	if err != nil {
		return fmt.Errorf("cannot read deploy secret: %w", err)
	}
	deploySecret := strings.TrimSpace(string(secretBytes))

	return newDeploymentJobClient(deploymentBaseURL, deploySecret).execute("deploy", hostIP)
}

type deploymentEvent struct {
	Step       int    `json:"step"`
	TotalSteps int    `json:"totalSteps"`
	Status     string `json:"status"`
	Message    string `json:"message"`
	Detail     string `json:"detail,omitempty"`
	Terminal   bool   `json:"terminal,omitempty"`
}

// provisionBridgeToken generates a shared bridge token and pushes it to both
// the Control Panel and UI containers. This token is used for server-to-server
// authentication between the UI and CP bridge API.
//
// The token is stored on the host at /var/lib/youeye/control/.bridge_token
// and pushed to /etc/youeye/ui-bridge-token in both containers.
// If a token already exists on the host, it is reused (idempotent).
func provisionBridgeToken() error {
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
		fmt.Println("  Using existing bridge token from Control Panel container")
	} else {
		token = util.GenerateBridgeToken()
		fmt.Println("  Generated new bridge token")
	}

	// Always persist the token on the host
	if err := os.MkdirAll("/var/lib/youeye/control", 0700); err != nil {
		return fmt.Errorf("create bridge token directory: %w", err)
	}
	if err := os.WriteFile(hostTokenPath, []byte(token), 0600); err != nil {
		return fmt.Errorf("persist bridge token on host: %w", err)
	}
	if err := os.Chmod(hostTokenPath, 0600); err != nil {
		return fmt.Errorf("restrict bridge token permissions: %w", err)
	}

	// Write token to a temp file for pushing to containers
	tmp, err := os.CreateTemp("/tmp", ".ye-bridge-token-*")
	if err != nil {
		return fmt.Errorf("create temporary bridge token: %w", err)
	}
	tmpFile := tmp.Name()
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		os.Remove(tmpFile)
		return fmt.Errorf("restrict temporary bridge token: %w", err)
	}
	if _, err := tmp.WriteString(token); err != nil {
		tmp.Close()
		os.Remove(tmpFile)
		return fmt.Errorf("write temporary bridge token: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpFile)
		return fmt.Errorf("close temporary bridge token: %w", err)
	}
	defer os.Remove(tmpFile)

	// Push token to both containers
	containers := []string{"youeye-control", "youeye-ui"}
	needCPRestart := false
	for _, ctr := range containers {
		if err := requireContainerRunning(ctr); err != nil {
			return err
		}

		// Ensure /etc/youeye directory exists inside container
		if out, err := exec.Command("incus", "exec", ctr, "--", "mkdir", "-p", "/etc/youeye").CombinedOutput(); err != nil {
			return fmt.Errorf("create token directory in %s: %w: %s", ctr, err, strings.TrimSpace(string(out)))
		}

		// Check if the container already has the correct token
		existingOut, _ := exec.Command("incus", "exec", ctr, "--", "cat", containerTokenPath).Output()
		if strings.TrimSpace(string(existingOut)) == token {
			fmt.Printf("  ✓ %s already has correct token\n", ctr)
			continue
		}

		// Push the token file
		target := ctr + containerTokenPath
		if err := util.RunCmdQuiet("incus", "file", "push", tmpFile, target); err != nil {
			return fmt.Errorf("push bridge token to %s: %w", ctr, err)
		}

		// Set restrictive permissions
		if out, err := exec.Command("incus", "exec", ctr, "--", "chmod", "600", containerTokenPath).CombinedOutput(); err != nil {
			return fmt.Errorf("restrict bridge token in %s: %w: %s", ctr, err, strings.TrimSpace(string(out)))
		}

		fmt.Printf("  ✓ Token pushed to %s\n", ctr)

		// If CP got a new/different token, it needs a restart to clear in-memory cache
		if ctr == "youeye-control" {
			needCPRestart = true
		}
	}

	// Restart CP if its token file changed (to clear the in-memory token cache)
	if needCPRestart {
		fmt.Println("  Restarting Control Panel to apply new token...")
		if out, err := exec.Command("incus", "exec", "youeye-control", "--",
			"systemctl", "restart", "youeye-control").CombinedOutput(); err != nil {
			return fmt.Errorf("restart Control Panel after bridge token update: %w: %s", err, strings.TrimSpace(string(out)))
		}
		if err := waitForContainerService("youeye-control", "youeye-control", 60*time.Second); err != nil {
			return err
		}
	}

	if err := verifyHostToken(hostTokenPath, token); err != nil {
		return fmt.Errorf("verify host bridge token: %w", err)
	}
	for _, ctr := range containers {
		if err := verifyContainerToken(ctr, containerTokenPath, token); err != nil {
			return fmt.Errorf("verify bridge token in %s: %w", ctr, err)
		}
	}

	fmt.Println("✓ Bridge token provisioned")
	return nil
}

// provisionCLIToken generates a CLI authentication token and pushes it to the
// Control Panel container. This token allows the `youeye` CLI tool to call
// CP API endpoints without a browser session.
//
// The token is stored on the host at /var/lib/youeye/config/cli-token (0600)
// and pushed to /etc/youeye/cli-token in the CP container.
func provisionCLIToken() error {
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
	if err := os.MkdirAll("/var/lib/youeye/config", 0700); err != nil {
		return fmt.Errorf("create CLI token directory: %w", err)
	}
	if err := os.WriteFile(hostTokenPath, []byte(token), 0600); err != nil {
		return fmt.Errorf("persist CLI token on host: %w", err)
	}
	if err := os.Chmod(hostTokenPath, 0600); err != nil {
		return fmt.Errorf("restrict CLI token permissions: %w", err)
	}

	// Push to CP container
	if err := requireContainerRunning("youeye-control"); err != nil {
		return err
	}

	if out, err := exec.Command("incus", "exec", "youeye-control", "--", "mkdir", "-p", "/etc/youeye").CombinedOutput(); err != nil {
		return fmt.Errorf("create CLI token directory in Control Panel: %w: %s", err, strings.TrimSpace(string(out)))
	}

	existingOut, _ := exec.Command("incus", "exec", "youeye-control", "--", "cat", containerTokenPath).Output()
	if strings.TrimSpace(string(existingOut)) == token {
		fmt.Println("  ✓ Control Panel already has correct CLI token")
	} else {
		tmp, err := os.CreateTemp("/tmp", ".ye-cli-token-*")
		if err != nil {
			return fmt.Errorf("create temporary CLI token: %w", err)
		}
		tmpFile := tmp.Name()
		if err := tmp.Chmod(0600); err != nil {
			tmp.Close()
			os.Remove(tmpFile)
			return fmt.Errorf("restrict temporary CLI token: %w", err)
		}
		if _, err := tmp.WriteString(token); err != nil {
			tmp.Close()
			os.Remove(tmpFile)
			return fmt.Errorf("write temporary CLI token: %w", err)
		}
		if err := tmp.Close(); err != nil {
			os.Remove(tmpFile)
			return fmt.Errorf("close temporary CLI token: %w", err)
		}
		defer os.Remove(tmpFile)

		if err := util.RunCmdQuiet("incus", "file", "push", tmpFile, "youeye-control"+containerTokenPath); err != nil {
			return fmt.Errorf("push CLI token to Control Panel: %w", err)
		}
		if out, err := exec.Command("incus", "exec", "youeye-control", "--", "chmod", "600", containerTokenPath).CombinedOutput(); err != nil {
			return fmt.Errorf("restrict CLI token in Control Panel: %w: %s", err, strings.TrimSpace(string(out)))
		}
		fmt.Println("  ✓ CLI token pushed to Control Panel")
	}

	if err := verifyHostToken(hostTokenPath, token); err != nil {
		return fmt.Errorf("verify host CLI token: %w", err)
	}
	if err := verifyContainerToken("youeye-control", containerTokenPath, token); err != nil {
		return fmt.Errorf("verify CLI token in Control Panel: %w", err)
	}

	fmt.Println("✓ CLI token provisioned")
	return nil
}

// enableSpineService creates and enables the Spine systemd service
func enableSpineService() error {
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
Description=YouEye Platform Management Service
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStartPre=/bin/mkdir -p /var/run/youeye
ExecStart=/usr/local/bin/youeye api serve
# Wait for socket to be ready before service is considered started
# This ensures dependent services (incus-startup) start after socket exists
ExecStartPost=/bin/bash -c 'for i in {1..50}; do [ -S /var/run/youeye/youeye.sock ] && exit 0; sleep 0.1; done; exit 1'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`
	// Remove old spine.service if it exists (migration)
	if err := os.Remove("/etc/systemd/system/spine.service"); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove legacy spine service: %w", err)
	}

	if err := os.WriteFile("/etc/systemd/system/youeye.service", []byte(serviceContent), 0644); err != nil {
		return fmt.Errorf("write youeye service: %w", err)
	}

	if err := configureIncusStartupDependency(); err != nil {
		return err
	}
	if err := stopDetachedAPIServer(); err != nil {
		return err
	}
	if out, err := exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
		return fmt.Errorf("reload systemd: %w: %s", err, strings.TrimSpace(string(out)))
	}
	if out, err := exec.Command("systemctl", "enable", "--now", "youeye").CombinedOutput(); err != nil {
		return fmt.Errorf("enable youeye service: %w: %s", err, strings.TrimSpace(string(out)))
	}
	if err := verifySystemdState("youeye.service", "is-enabled", "enabled"); err != nil {
		return err
	}
	if err := verifySystemdState("youeye.service", "is-active", "active"); err != nil {
		return err
	}
	fmt.Println("✓ YouEye service and Incus dependency enabled")
	return nil
}

// configureIncusStartupDependency creates a systemd override so incus-startup.service
// waits for spine.service before starting containers. This ensures the Spine socket
// exists before containers with spine-socket proxy devices try to start.
func configureIncusStartupDependency() error {
	overrideDir := "/etc/systemd/system/incus-startup.service.d"
	overrideFile := overrideDir + "/youeye-dependency.conf"

	// Remove old spine-dependency.conf if present (migration)
	if err := os.Remove(overrideDir + "/spine-dependency.conf"); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove legacy Incus dependency: %w", err)
	}

	// Create override directory
	if err := os.MkdirAll(overrideDir, 0755); err != nil {
		return fmt.Errorf("create Incus dependency directory: %w", err)
	}

	// Create override file that makes incus-startup wait for spine
	overrideContent := `[Unit]
# Wait for YouEye API socket before starting containers
# This ensures containers with youeye-socket proxy device can start successfully
After=youeye.service
Wants=youeye.service
`
	if err := os.WriteFile(overrideFile, []byte(overrideContent), 0644); err != nil {
		return fmt.Errorf("write Incus dependency: %w", err)
	}
	return nil
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
//
// The swapfile lives at /var/swapfile on the OS root filesystem — NOT under
// /var/lib/youeye, which is now a ZFS dataset on dedicated-disk deploys. Swap
// on ZFS is a documented deadlock hazard (OpenZFS), so swap must never sit on
// the ZFS data dataset.
func ensureSwapFile() {
	const swapPath = "/var/swapfile"
	const legacySwapPath = "/var/lib/youeye/swapfile"

	// Check if swap already exists
	out, _ := exec.Command("swapon", "--show", "--noheadings").Output()
	if len(strings.TrimSpace(string(out))) > 0 {
		// Swap is already active. If it's the legacy path on a NON-ZFS
		// filesystem, leave it working (migration: don't disturb a healthy
		// ext4-backed swapfile). We only ever refuse to CREATE new swap on ZFS.
		if strings.Contains(string(out), legacySwapPath) && fsTypeOf(legacySwapPath) == "zfs" {
			fmt.Printf("Warning: active swapfile %s is on ZFS (deadlock hazard). "+
				"Leaving it in place — recreate it on the OS filesystem manually if desired.\n", legacySwapPath)
		}
		return // swap already active
	}

	// Detect LXC environment — can't create swap inside a container
	if err := exec.Command("systemd-detect-virt", "-c").Run(); err == nil {
		fmt.Println("Running inside a container — skipping swap creation")
		return
	}

	// Never create swap on ZFS (deadlock hazard). /var/swapfile lives on the
	// filesystem backing /var — refuse if that is ZFS.
	if fsTypeOf("/var") == "zfs" {
		fmt.Println("Warning: /var is on ZFS — skipping swapfile creation (swap on ZFS deadlocks). " +
			"Provision swap on a non-ZFS filesystem if needed.")
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

// fsTypeOf returns the filesystem type backing a path (e.g. "ext4", "zfs"),
// or "" if it cannot be determined. Uses findmnt with -T (target file) so it
// resolves the mount that actually contains the path.
func fsTypeOf(path string) string {
	out, err := exec.Command("findmnt", "-n", "-o", "FSTYPE", "-T", path).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
