// Package incus provides Incus container manager installation and configuration.
package incus

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"git.potemk.in/potemsla/YouEye/spine/internal/storage"
	"git.potemk.in/potemsla/YouEye/spine/internal/util"
)

// StorageDriver tracks the initialized storage driver type
var StorageDriver string = "dir"

// InstallOptions configures Incus initialization and storage growth.
type InstallOptions struct {
	DesiredZFSSize string
	AutoGrowZFS    bool
}

// Install installs and initializes Incus with proper storage configuration.
func Install() error {
	return InstallWithOptions(InstallOptions{})
}

// InstallWithOptions installs and initializes Incus with proper storage configuration.
func InstallWithOptions(opts InstallOptions) error {
	fmt.Println("=== Installing Incus ===")

	// Install pamtester on HOST for PAM authentication (required by Spine API)
	if _, err := exec.LookPath("pamtester"); err != nil {
		fmt.Println("Installing pamtester for PAM authentication...")
		util.RunCmdQuiet("apt-get", "update")
		if err := util.RunCmdQuiet("apt-get", "install", "-y", "pamtester"); err != nil {
			fmt.Printf("Warning: could not install pamtester: %v\n", err)
		} else {
			fmt.Println("✓ pamtester installed")
		}
	}

	// Check if ZFS is available (works on VMs/bare metal, not in LXC containers)
	zfsAvailable := checkZFSAvailable()
	if zfsAvailable {
		fmt.Println("✓ ZFS support detected")
		if err := installZFS(); err != nil {
			fmt.Printf("Warning: ZFS installation issue: %v\n", err)
			zfsAvailable = false
		}
	} else {
		fmt.Println("ℹ  ZFS not available (common in LXC containers), using dir driver")
	}

	// Configure subuid/subgid for unprivileged containers (required for idmapped storage)
	ConfigureSubuidSubgid()

	// Always configure Zabbly repository first to ensure we get latest Incus with OCI support
	// This handles both fresh installs AND upgrades of existing Ubuntu LTS packages (6.0.0)
	zabblyConfigured := false
	if err := configureZabblyRepository(); err != nil {
		fmt.Printf("Warning: could not configure Zabbly repository: %v\n", err)
		fmt.Println("Will use system packages...")
	} else {
		zabblyConfigured = true
	}

	// Update package list
	if err := util.RunCmd("apt-get", "update"); err != nil {
		return fmt.Errorf("failed to update packages: %w", err)
	}

	// Check if already installed
	if _, err := exec.LookPath("incus"); err == nil {
		// Incus is installed - check if we need to upgrade (Ubuntu ships 6.0.0 LTS without OCI)
		if zabblyConfigured {
			fmt.Println("Upgrading Incus from Zabbly repository...")
			if err := util.RunCmd("apt-get", "install", "-y", "incus"); err != nil {
				fmt.Printf("Warning: could not upgrade Incus: %v\n", err)
			} else {
				fmt.Println("✓ Incus upgraded to latest version")
			}
		} else {
			fmt.Println("✓ Incus is already installed")
		}
	} else {
		fmt.Println("Installing Incus...")

		// Install Incus
		if err := util.RunCmd("apt-get", "install", "-y", "incus"); err != nil {
			return fmt.Errorf("failed to install Incus: %w", err)
		}
		fmt.Println("✓ Incus installed")
	}

	// Restart Incus service to ensure it picks up subuid/subgid mappings
	fmt.Println("Restarting Incus service to load subuid/subgid mappings...")
	util.RunCmdQuiet("systemctl", "restart", "incus")
	time.Sleep(2 * time.Second) // Give service time to fully start

	// Check if already initialized with a storage pool
	out, err := exec.Command("incus", "storage", "list", "--format", "csv").Output()
	if err == nil && len(strings.TrimSpace(string(out))) > 0 {
		// Check current driver
		if strings.Contains(string(out), ",zfs,") {
			StorageDriver = "zfs"
			fmt.Println("✓ Incus is already initialized with ZFS storage")
			if opts.AutoGrowZFS {
				if err := GrowDefaultManagedZFSLoopPool(opts.DesiredZFSSize); err != nil {
					fmt.Printf("Warning: could not grow Incus storage: %v\n", err)
				}
			}
			if err := ensureIncusBridgeReady(); err != nil {
				return err
			}
			if err := EnsureSystemBaseImage(); err != nil {
				return err
			}
			configureOCIRemote()
			if err := util.RunCmd("incus", "version"); err != nil {
				return fmt.Errorf("failed to verify Incus: %w", err)
			}
			fmt.Println("\n=== Incus Installation Complete ===")
			return nil
		} else if strings.Contains(string(out), ",dir,") {
			StorageDriver = "dir"
			fmt.Println("✓ Incus is already initialized with dir storage")
			if err := ensureIncusBridgeReady(); err != nil {
				return err
			}
			if err := EnsureSystemBaseImage(); err != nil {
				return err
			}
			configureOCIRemote()
			if err := util.RunCmd("incus", "version"); err != nil {
				return fmt.Errorf("failed to verify Incus: %w", err)
			}
			fmt.Println("\n=== Incus Installation Complete ===")
			return nil
		}

		// Reinitialize with preferred driver
		fmt.Println("Reinitializing Incus storage...")
		exec.Command("incus", "storage", "delete", "default", "--force").Run()
		exec.Command("incus", "profile", "device", "remove", "default", "root").Run()
		exec.Command("incus", "network", "delete", "incusbr0", "--force").Run()
	}

	// Initialize Incus with best available storage
	if err := initializeWithPreseed(zfsAvailable, opts); err != nil {
		return err
	}

	// Note: We don't set project restrictions anymore because:
	// - ZFS snapshots (incremental backups) are blocked by restricted=true
	// - On VMs (where ZFS works), we don't need LXC-specific protections
	// - On LXC (where dir driver is used), we may need privileged fallback

	fmt.Println("✓ Incus initialized")

	if err := ensureIncusBridgeReady(); err != nil {
		return err
	}
	if err := EnsureSystemBaseImage(); err != nil {
		return err
	}

	// Configure OCI remote for Docker Hub images
	configureOCIRemote()

	// Verify
	if err := util.RunCmd("incus", "version"); err != nil {
		return fmt.Errorf("failed to verify Incus: %w", err)
	}

	fmt.Println("\n=== Incus Installation Complete ===")
	return nil
}

// configureOCIRemote sets up OCI remotes for Docker Hub and GitHub Container Registry.
func configureOCIRemote() {
	out, _ := exec.Command("incus", "remote", "list", "--format", "csv").Output()
	remoteList := string(out)

	// Docker Hub remote
	if strings.Contains(remoteList, "docker,") {
		fmt.Println("✓ Docker OCI remote already configured")
	} else {
		fmt.Println("Configuring Docker OCI remote...")
		if err := util.RunCmdQuiet("incus", "remote", "add", "docker", "https://docker.io", "--protocol=oci"); err != nil {
			fmt.Printf("Warning: could not add Docker remote: %v\n", err)
		} else {
			fmt.Println("✓ Docker OCI remote configured")
		}
	}

	// GitHub Container Registry remote (required for ghcr.io images like Authentik)
	if strings.Contains(remoteList, "ghcr,") {
		fmt.Println("✓ GHCR OCI remote already configured")
	} else {
		fmt.Println("Configuring GitHub Container Registry OCI remote...")
		if err := util.RunCmdQuiet("incus", "remote", "add", "ghcr", "https://ghcr.io", "--protocol=oci", "--public"); err != nil {
			fmt.Printf("Warning: could not add GHCR remote: %v\n", err)
		} else {
			fmt.Println("✓ GHCR OCI remote configured")
		}
	}
}

// checkZFSAvailable checks if ZFS can work in this environment.
func checkZFSAvailable() bool {
	// Check if /dev/zfs exists or can be created (not possible in LXC containers)
	if _, err := os.Stat("/dev/zfs"); err == nil {
		return true
	}

	// Try loading ZFS module (will fail in LXC)
	if err := exec.Command("modprobe", "zfs").Run(); err == nil {
		// Check again after modprobe
		if _, err := os.Stat("/dev/zfs"); err == nil {
			return true
		}
	}

	return false
}

// zpoolExists checks if a ZFS pool with the given name already exists.
func zpoolExists(name string) bool {
	err := exec.Command("zpool", "list", name).Run()
	return err == nil
}

// initializeWithPreseed initializes Incus using preseed configuration.
func initializeWithPreseed(zfsAvailable bool, opts InstallOptions) error {
	driver := "dir"
	driverConfig := ""
	if zfsAvailable {
		driver = "zfs"
		// Check if a ZFS pool named "default" already exists (e.g. from a previous install)
		// If so, tell Incus to reuse it via source: instead of creating a new loop-backed pool
		if zpoolExists("default") {
			fmt.Println("Found existing ZFS pool 'default', reusing it...")
			driverConfig = "\n    source: default"
		} else if strings.TrimSpace(opts.DesiredZFSSize) != "" {
			driverConfig = "\n    size: " + strings.TrimSpace(opts.DesiredZFSSize)
		} else {
			driverConfig = ""
		}
		fmt.Println("Initializing Incus with ZFS storage...")
	} else {
		fmt.Println("Initializing Incus with dir storage...")
	}

	preseed := fmt.Sprintf(`config:
  core.https_address: '[::]:8443'
networks:
- config:
    ipv4.address: auto
    ipv6.address: none
    dns.domain: youeye
  description: ""
  name: incusbr0
  type: ""
  project: default
storage_pools:
- config:%s
  description: ""
  name: default
  driver: %s
profiles:
- config: {}
  description: Default Incus profile
  devices:
    eth0:
      name: eth0
      network: incusbr0
      type: nic
    root:
      path: /
      pool: default
      type: disk
  name: default
projects: []
cluster: null
`, driverConfig, driver)

	cmd := exec.Command("incus", "admin", "init", "--preseed")
	cmd.Stdin = strings.NewReader(preseed)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		// Fallback to manual setup if preseed fails
		return initializeManually(err, zfsAvailable, opts)
	}

	StorageDriver = driver
	return nil
}

// initializeManually performs manual Incus initialization when preseed fails.
func initializeManually(preseedErr error, zfsAvailable bool, opts InstallOptions) error {
	fmt.Println("\n⚠️  Preseed init failed, trying manual setup...")
	util.LogDebug(fmt.Sprintf("Preseed error: %v", preseedErr))

	driver := "dir"
	if zfsAvailable {
		driver = "zfs"
	}

	// Clean up any partial state from failed preseed
	util.LogSubStep("Cleaning up partial initialization state...")

	util.LogDebug("Removing profile device 'root'...")
	out, _ := util.RunCmdCapture("incus", "profile", "device", "remove", "default", "root")
	if len(out) > 0 {
		util.LogDebug(strings.TrimSpace(out))
	}

	util.LogDebug("Removing profile device 'eth0'...")
	out, _ = util.RunCmdCapture("incus", "profile", "device", "remove", "default", "eth0")
	if len(out) > 0 {
		util.LogDebug(strings.TrimSpace(out))
	}

	util.LogDebug("Deleting storage pool 'default'...")
	out, _ = util.RunCmdCapture("incus", "storage", "delete", "default")
	if len(out) > 0 {
		util.LogDebug(strings.TrimSpace(out))
	}

	util.LogDebug("Deleting network 'incusbr0'...")
	out, _ = util.RunCmdCapture("incus", "network", "delete", "incusbr0")
	if len(out) > 0 {
		util.LogDebug(strings.TrimSpace(out))
	}

	// Check if storage pool exists
	storageOut, _ := exec.Command("incus", "storage", "list", "--format", "csv").Output()
	storageExists := strings.Contains(string(storageOut), "default")
	util.LogDebug(fmt.Sprintf("Storage pools: %s", strings.TrimSpace(string(storageOut))))

	// Create storage pool with appropriate driver (try ZFS first, fall back to dir)
	util.LogSubStep(fmt.Sprintf("Creating storage pool with %s driver...", driver))
	if !storageExists {
		var createArgs []string
		if driver == "zfs" {
			// Check if a ZFS pool named "default" already exists
			if zpoolExists("default") {
				util.LogDebug("Found existing ZFS pool 'default', reusing via source=default")
				createArgs = []string{"storage", "create", "default", "zfs", "source=default"}
			} else if strings.TrimSpace(opts.DesiredZFSSize) != "" {
				createArgs = []string{"storage", "create", "default", "zfs", "size=" + strings.TrimSpace(opts.DesiredZFSSize)}
			} else {
				createArgs = []string{"storage", "create", "default", "zfs"}
			}
		} else {
			createArgs = []string{"storage", "create", "default", "dir"}
		}
		if out, err := util.RunCmdCapture("incus", createArgs...); err != nil {
			if driver == "zfs" {
				// ZFS pool creation failed (common in LXC even with /dev/zfs passthrough)
				// Fall back to dir driver
				util.LogDebug(fmt.Sprintf("ZFS pool creation failed: %s", strings.TrimSpace(out)))
				util.LogSubStep("ZFS pool creation failed, falling back to dir driver...")
				driver = "dir"
				createArgs = []string{"storage", "create", "default", "dir"}
				if out2, err2 := util.RunCmdCapture("incus", createArgs...); err2 != nil {
					util.LogError(fmt.Sprintf("Failed to create storage pool with dir: %s", strings.TrimSpace(out2)))
					return fmt.Errorf("failed to create storage pool: %w", err2)
				}
				util.LogSuccess("Storage pool 'default' created with dir (ZFS fallback)")
			} else {
				util.LogError(fmt.Sprintf("Failed to create storage pool: %s", strings.TrimSpace(out)))
				return fmt.Errorf("failed to create storage pool: %w", err)
			}
		} else {
			util.LogSuccess(fmt.Sprintf("Storage pool 'default' created with %s", driver))
		}
	} else {
		util.LogDebug("Storage pool 'default' already exists, using existing")
	}

	StorageDriver = driver

	// Create network
	util.LogSubStep("Creating network...")

	util.LogDebug("Deleting any existing Incus network definition...")
	out, _ = util.RunCmdCapture("incus", "network", "delete", "incusbr0")
	if len(out) > 0 {
		util.LogDebug(strings.TrimSpace(out))
	}

	util.LogDebug("Deleting any existing Linux bridge interface...")
	out, _ = util.RunCmdCapture("ip", "link", "delete", "incusbr0")
	if len(out) > 0 {
		util.LogDebug(strings.TrimSpace(out))
	}

	util.LogDebug("Killing any lingering dnsmasq processes...")
	out, _ = util.RunCmdCapture("pkill", "-9", "dnsmasq")
	if len(out) > 0 {
		util.LogDebug(strings.TrimSpace(out))
	}
	time.Sleep(1 * time.Second)

	if out, err := util.RunCmdCapture("incus", "network", "create", "incusbr0", "ipv4.address=auto", "ipv6.address=none", "dns.domain=youeye"); err != nil {
		util.LogError(fmt.Sprintf("Failed to create network: %s", strings.TrimSpace(out)))
		return fmt.Errorf("failed to create network: %w", err)
	}
	util.LogSuccess("Network 'incusbr0' created (dns.domain=youeye)")

	// Configure default profile
	util.LogSubStep("Configuring default profile...")

	util.LogDebug("Removing existing profile devices...")
	util.RunCmdQuiet("incus", "profile", "device", "remove", "default", "root")
	util.RunCmdQuiet("incus", "profile", "device", "remove", "default", "eth0")

	util.LogDebug("Adding root disk device to profile...")
	if out, err := util.RunCmdCapture("incus", "profile", "device", "add", "default", "root", "disk", "path=/", "pool=default"); err != nil {
		util.LogError(fmt.Sprintf("Failed to add root device: %s", strings.TrimSpace(out)))
		return fmt.Errorf("failed to add root device to profile: %w", err)
	}
	util.LogSuccess("Root disk device added")

	util.LogDebug("Adding network device to profile...")
	if out, err := util.RunCmdCapture("incus", "profile", "device", "add", "default", "eth0", "nic", "network=incusbr0", "name=eth0"); err != nil {
		util.LogError(fmt.Sprintf("Failed to add network device: %s", strings.TrimSpace(out)))
		return fmt.Errorf("failed to add network to profile: %w", err)
	}
	util.LogSuccess("Network device added")

	// Restrict DHCP range for static system IPs
	if err := ConfigureSystemDHCP(); err != nil {
		fmt.Printf("Warning: could not configure static IP DHCP range: %v\n", err)
	}
	if err := ConfigureSystemDNS(); err != nil {
		fmt.Printf("Warning: could not configure system DNS records: %v\n", err)
	}

	return nil
}

// GrowDefaultManagedZFSLoopPool grows Incus' default managed loop-backed ZFS
// pool when it is below the requested size. It never shrinks a pool and ignores
// non-loop pools that may be backed by a real disk or an operator-created zpool.
func GrowDefaultManagedZFSLoopPool(targetSize string) error {
	targetSize = strings.TrimSpace(targetSize)
	if targetSize == "" {
		return nil
	}

	out, err := util.RunCmdCapture("incus", "storage", "show", "default")
	if err != nil {
		return nil
	}
	info := parseStorageShow(out)
	if info.driver != "zfs" {
		return nil
	}
	if !managedLoopSource(info.source) {
		return nil
	}

	targetBytes := storage.ParseSizeBytes(targetSize)
	currentBytes := storage.ParseSizeBytes(info.size)
	if targetBytes <= 0 || currentBytes <= 0 || targetBytes <= currentBytes {
		return nil
	}

	fmt.Printf("Growing Incus storage pool from %s to %s...\n", info.size, targetSize)
	if err := util.RunCmd("incus", "storage", "set", "default", "size="+targetSize); err != nil {
		return err
	}
	poolName := info.poolName
	if poolName == "" {
		poolName = "default"
	}
	util.RunCmdQuiet("zpool", "set", "autoexpand=on", poolName)
	if info.source != "" {
		util.RunCmdQuiet("zpool", "online", "-e", poolName, info.source)
	}
	fmt.Println("✓ Incus storage pool grown")
	return nil
}

type storageShowInfo struct {
	driver   string
	source   string
	size     string
	poolName string
}

func parseStorageShow(out string) storageShowInfo {
	var info storageShowInfo
	inConfig := false
	for _, line := range strings.Split(out, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if trimmed == "config:" {
			inConfig = true
			continue
		}
		if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
			inConfig = false
		}
		key, value, ok := strings.Cut(trimmed, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), "\"'")
		switch {
		case key == "driver":
			info.driver = value
		case inConfig && key == "source":
			info.source = value
		case inConfig && key == "size":
			info.size = value
		case inConfig && key == "zfs.pool_name":
			info.poolName = value
		}
	}
	return info
}

func managedLoopSource(source string) bool {
	source = strings.TrimSpace(source)
	if source == "" {
		return false
	}
	if strings.HasPrefix(source, "/var/lib/incus/disks/") {
		return true
	}
	if info, err := os.Stat(source); err == nil {
		return info.Mode().IsRegular()
	}
	return false
}

// ensureIncusBridgeReady normalizes the managed bridge after init/reuse. Fresh
// deploy depends on DHCPv4 working before the Control Panel container can
// install Node.js, so stale dnsmasq processes or accidental IPv6-only bridge
// state must be repaired before any system containers are created.
func ensureIncusBridgeReady() error {
	if err := setIncusBridgeIPv4Only(); err != nil {
		return err
	}
	if err := ConfigureSystemDHCP(); err != nil {
		return fmt.Errorf("failed to configure static IP DHCP range: %w", err)
	}
	if err := ConfigureSystemDNS(); err != nil {
		return fmt.Errorf("failed to configure system DNS records: %w", err)
	}
	if err := restartIncusIfDnsmasqStale(); err != nil {
		return err
	}
	return nil
}

func setIncusBridgeIPv4Only() error {
	if err := exec.Command("incus", "network", "set", "incusbr0", "ipv6.address", "none").Run(); err != nil {
		return fmt.Errorf("failed to disable IPv6 on incusbr0: %w", err)
	}
	// ipv6.nat can remain unset on some Incus versions; setting false is best effort.
	exec.Command("incus", "network", "set", "incusbr0", "ipv6.nat", "false").Run()
	return nil
}

func restartIncusIfDnsmasqStale() error {
	gateway, err := exec.Command("incus", "network", "get", "incusbr0", "ipv4.address").Output()
	if err != nil {
		return fmt.Errorf("failed to read incusbr0 IPv4 address: %w", err)
	}
	expected := strings.Split(strings.TrimSpace(string(gateway)), "/")[0]
	out, _ := exec.Command("pgrep", "-a", "-u", "incus", "dnsmasq").Output()

	if !incusBridgeDnsmasqStale(string(out), expected) {
		return nil
	}

	fmt.Println("Restarting Incus to clear stale incusbr0 dnsmasq processes...")
	if err := util.RunCmdQuiet("systemctl", "restart", "incus"); err != nil {
		return fmt.Errorf("failed to restart Incus after stale dnsmasq detection: %w", err)
	}
	time.Sleep(2 * time.Second)

	out, _ = exec.Command("pgrep", "-a", "-u", "incus", "dnsmasq").Output()
	stale := staleIncusBridgeDnsmasqPIDs(string(out), expected)
	if len(stale) > 0 {
		fmt.Printf("Killing %d stale incusbr0 dnsmasq process(es)...\n", len(stale))
		for _, pid := range stale {
			if err := exec.Command("kill", "-TERM", pid).Run(); err != nil {
				return fmt.Errorf("failed to terminate stale incusbr0 dnsmasq process %s: %w", pid, err)
			}
		}
		time.Sleep(1 * time.Second)

		out, _ = exec.Command("pgrep", "-a", "-u", "incus", "dnsmasq").Output()
		stale = staleIncusBridgeDnsmasqPIDs(string(out), expected)
		for _, pid := range stale {
			if err := exec.Command("kill", "-KILL", pid).Run(); err != nil {
				return fmt.Errorf("failed to kill stale incusbr0 dnsmasq process %s: %w", pid, err)
			}
		}
		time.Sleep(500 * time.Millisecond)
		out, _ = exec.Command("pgrep", "-a", "-u", "incus", "dnsmasq").Output()
	}

	active := activeIncusBridgeDnsmasqCount(string(out), expected)
	if remaining := staleIncusBridgeDnsmasqPIDs(string(out), expected); len(remaining) > 0 {
		return fmt.Errorf("stale incusbr0 dnsmasq still active after cleanup: %s", strings.Join(remaining, ", "))
	}
	if active != 1 {
		return fmt.Errorf("expected exactly one current incusbr0 dnsmasq process, found %d", active)
	}
	fmt.Println("✓ Incus dnsmasq state is clean")
	return nil
}

func incusBridgeDnsmasqStale(processList, expectedIPv4 string) bool {
	if len(staleIncusBridgeDnsmasqPIDs(processList, expectedIPv4)) > 0 {
		return true
	}
	return activeIncusBridgeDnsmasqCount(processList, expectedIPv4) > 1
}

func staleIncusBridgeDnsmasqPIDs(processList, expectedIPv4 string) []string {
	var pids []string
	for _, line := range strings.Split(strings.TrimSpace(processList), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if !strings.Contains(line, "--interface=incusbr0") {
			continue
		}
		if strings.Contains(line, "--listen-address="+expectedIPv4) {
			continue
		}
		pids = append(pids, fields[0])
	}
	return pids
}

func activeIncusBridgeDnsmasqCount(processList, expectedIPv4 string) int {
	active := 0
	for _, line := range strings.Split(strings.TrimSpace(processList), "\n") {
		if strings.Contains(line, "--interface=incusbr0") && strings.Contains(line, "--listen-address="+expectedIPv4) {
			active++
		}
	}
	return active
}

// configureZabblyRepository sets up the official Zabbly repository for latest Incus packages.
// Zabbly (maintained by Incus core team) provides stable and LTS channels.
// We use the stable channel for latest features including full OCI support.
func configureZabblyRepository() error {
	fmt.Println("Configuring Zabbly repository for Incus...")

	// Check if already configured
	if _, err := os.Stat("/etc/apt/sources.list.d/zabbly-incus-stable.list"); err == nil {
		fmt.Println("✓ Zabbly repository already configured")
		return nil
	}

	// Ensure keyrings directory exists
	if err := os.MkdirAll("/etc/apt/keyrings", 0755); err != nil {
		return fmt.Errorf("failed to create keyrings directory: %w", err)
	}

	// Ensure gpg is available (not installed by default on fresh Debian 13)
	if _, err := exec.LookPath("gpg"); err != nil {
		fmt.Println("Installing gnupg (required for GPG key import)...")
		if err := util.RunCmdQuiet("apt-get", "update", "-qq"); err != nil {
			return fmt.Errorf("failed to update packages for gnupg install: %w", err)
		}
		if err := util.RunCmdQuiet("apt-get", "install", "-y", "gnupg"); err != nil {
			return fmt.Errorf("failed to install gnupg: %w", err)
		}
		fmt.Println("✓ gnupg installed")
	}

	// Download and install GPG key
	fmt.Println("Downloading Zabbly GPG key...")
	gpgCmd := exec.Command("sh", "-c", "curl -fsSL https://pkgs.zabbly.com/key.asc | gpg --yes --dearmor -o /etc/apt/keyrings/zabbly.gpg")
	if out, err := gpgCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to install GPG key: %w (output: %s)", err, string(out))
	}
	fmt.Println("✓ GPG key installed")

	// Detect distribution codename
	codename := getDistroCodename()
	fmt.Printf("Detected distribution: %s\n", codename)

	// Create repository file for stable channel (latest with OCI support)
	repoLine := fmt.Sprintf("deb [signed-by=/etc/apt/keyrings/zabbly.gpg] https://pkgs.zabbly.com/incus/stable %s main\n", codename)
	if err := os.WriteFile("/etc/apt/sources.list.d/zabbly-incus-stable.list", []byte(repoLine), 0644); err != nil {
		return fmt.Errorf("failed to create repository file: %w", err)
	}
	fmt.Println("✓ Zabbly stable repository configured")

	return nil
}

// getDistroCodename returns the distribution codename (e.g., "bookworm", "jammy").
// Falls back to "bookworm" (Debian 12) if detection fails.
func getDistroCodename() string {
	// Read /etc/os-release
	content, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return "bookworm"
	}

	// Parse VERSION_CODENAME
	for _, line := range strings.Split(string(content), "\n") {
		if strings.HasPrefix(line, "VERSION_CODENAME=") {
			codename := strings.TrimPrefix(line, "VERSION_CODENAME=")
			codename = strings.Trim(codename, "\"")
			if codename != "" {
				return codename
			}
		}
	}

	return "bookworm"
}

// ConfigureSubuidSubgid ensures root has subuid/subgid mappings for unprivileged containers.
func ConfigureSubuidSubgid() {
	fmt.Println("Configuring subuid/subgid for unprivileged containers...")

	subuidContent, _ := os.ReadFile("/etc/subuid")
	subgidContent, _ := os.ReadFile("/etc/subgid")

	rootMapping := "root:1000000:1000000000"

	if !strings.Contains(string(subuidContent), "root:") {
		f, err := os.OpenFile("/etc/subuid", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err == nil {
			f.WriteString(rootMapping + "\n")
			f.Close()
			util.LogSuccess("Added root mapping to /etc/subuid")
		} else {
			util.LogDebug(fmt.Sprintf("Could not write /etc/subuid: %v", err))
		}
	} else {
		util.LogDebug("root already has subuid mapping")
	}

	if !strings.Contains(string(subgidContent), "root:") {
		f, err := os.OpenFile("/etc/subgid", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err == nil {
			f.WriteString(rootMapping + "\n")
			f.Close()
			util.LogSuccess("Added root mapping to /etc/subgid")
		} else {
			util.LogDebug(fmt.Sprintf("Could not write /etc/subgid: %v", err))
		}
	} else {
		util.LogDebug("root already has subgid mapping")
	}
}

// capZFSARC bounds the ZFS ARC to 2 GiB, persistently (modprobe.d) and live.
// Uncapped, the ARC grows toward all RAM and counts against MemAvailable,
// starving containers (observed on bykapc). Safe to re-run.
func capZFSARC() {
	const max = "2147483648" // 2 GiB
	util.RunCmdQuiet("bash", "-c", "printf 'options zfs zfs_arc_max="+max+"\\n' > /etc/modprobe.d/zfs.conf")
	util.RunCmdQuiet("bash", "-c", "echo "+max+" > /sys/module/zfs/parameters/zfs_arc_max 2>/dev/null || true")
	util.RunCmdQuiet("update-initramfs", "-u")
}

// installZFS installs ZFS utilities required for ZFS storage driver.
func installZFS() error {
	// Always (re)assert the ARC cap, even if ZFS is already installed.
	capZFSARC()

	// Check if zfs command is already available
	if _, err := exec.LookPath("zfs"); err == nil {
		fmt.Println("✓ ZFS is already installed")
		return nil
	}

	fmt.Println("Installing ZFS utilities...")

	// Update package list if not recently updated
	util.RunCmdQuiet("apt-get", "update")

	// Install zfsutils-linux
	if err := util.RunCmd("apt-get", "install", "-y", "zfsutils-linux"); err != nil {
		return fmt.Errorf("failed to install ZFS: %w", err)
	}

	// Load ZFS kernel module
	util.RunCmdQuiet("modprobe", "zfs")

	fmt.Println("✓ ZFS installed")
	return nil
}
