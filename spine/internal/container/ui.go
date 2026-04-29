package container

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"git.byka.wtf/potemsla/YouEye/spine/internal/config"
	"git.byka.wtf/potemsla/YouEye/spine/internal/incus"
	"git.byka.wtf/potemsla/YouEye/spine/internal/releases"
)

// DeployUIContainer creates and provisions the youeye-ui container.
// It installs Node.js and deploys the UI app but does NOT start the service.
// The Control Panel will start it after configuring SSO and Caddy.
func DeployUIContainer(cfg *config.Config) error {
	containerName := cfg.Deployment.UI.ContainerName
	image := cfg.Deployment.Container.Image // Same Debian 12 base
	nodeVersion := cfg.Deployment.UI.NodeVersion
	appDir := cfg.Deployment.UI.AppDir

	fmt.Printf("Deploying UI container: %s\n", containerName)

	// Check if container already exists
	containerAlreadyExists := false
	out, err := exec.Command("incus", "list", containerName, "--format", "csv", "-c", "s").Output()
	if err == nil && strings.TrimSpace(string(out)) != "" {
		fmt.Printf("UI container '%s' already exists (status: %s), skipping creation\n", containerName, strings.TrimSpace(string(out)))
		containerAlreadyExists = true
	}

	if !containerAlreadyExists {
		// Create container (init only, don't start yet — set static IP first)
		fmt.Printf("Creating container '%s' from %s...\n", containerName, image)
		if err := exec.Command("incus", "init", image, containerName).Run(); err != nil {
			return fmt.Errorf("failed to create UI container: %w", err)
		}

		// Set static IP before starting
		if err := incus.SetContainerStaticIP(containerName); err != nil {
			fmt.Printf("Warning: could not set static IP for %s: %v\n", containerName, err)
		}

		// Start the container
		if err := exec.Command("incus", "start", containerName).Run(); err != nil {
			return fmt.Errorf("failed to start UI container: %w", err)
		}

		// Wait for container to be running with network
		fmt.Println("Waiting for container to start...")
		if err := waitForUIContainer(containerName); err != nil {
			return fmt.Errorf("container failed to start: %w", err)
		}

		// Add socket proxies so UI container can talk to Spine API
		fmt.Println("Adding socket proxies...")
		if err := addUISocketProxies(containerName, cfg); err != nil {
			fmt.Printf("Warning: Failed to add socket proxies: %v\n", err)
		}

		// Block UI→CP traffic at the network level (one-way bridge enforcement)
		fmt.Println("Enforcing UI→CP egress block...")
		EnforceUIEgressBlock()

		// Install Node.js
		fmt.Printf("Installing Node.js %s...\n", nodeVersion)
		if err := installUINodeJS(containerName, nodeVersion); err != nil {
			return fmt.Errorf("failed to install Node.js: %w", err)
		}
	}

	// Always check if the app is deployed (handles partial deploys)
	appDeployed := false
	checkOut, checkErr := exec.Command("incus", "exec", containerName, "--", "test", "-f", appDir+"/server.js").Output()
	_ = checkOut
	if checkErr == nil {
		appDeployed = true
	}

	if !appDeployed {
		// Deploy the UI application
		fmt.Println("Deploying UI application...")
		if err := DeployUIApp(containerName, appDir, cfg); err != nil {
			return fmt.Errorf("failed to deploy UI app: %w", err)
		}
	} else {
		fmt.Println("UI application already deployed, skipping")
	}

	// Create systemd service (but don't enable/start it)
	fmt.Println("Creating systemd service...")
	if err := createUIService(containerName, appDir); err != nil {
		return fmt.Errorf("failed to create systemd service: %w", err)
	}

	// Create data directories on host
	os.MkdirAll("/var/lib/youeye/ui", 0700)

	// Mark as installed (not enabled)
	os.WriteFile("/var/lib/youeye/ui/.installed", []byte("true"), 0644)

	fmt.Println("✓ UI container deployed (service NOT started - enable via Control Panel)")
	return nil
}

// waitForUIContainer waits for the container to have network connectivity.
func waitForUIContainer(containerName string) error {
	for i := 0; i < 30; i++ {
		time.Sleep(2 * time.Second)
		out, err := exec.Command("incus", "list", containerName, "--format", "csv", "-c", "4").Output()
		if err == nil {
			ip := strings.TrimSpace(string(out))
			if ip != "" && !strings.Contains(ip, "fd42") {
				fmt.Printf("  Container has IP: %s\n", strings.Split(ip, " ")[0])
				return nil
			}
		}
	}
	return fmt.Errorf("timeout waiting for container network")
}

// addUISocketProxies adds proxy devices for Spine API socket and Incus socket.
func addUISocketProxies(containerName string, cfg *config.Config) error {
	socketPath := cfg.API.SocketPath

	// Create the socket directory inside the container first —
	// Incus proxy devices with bind=container need the listen path to exist.
	if err := exec.Command("incus", "exec", containerName, "--",
		"mkdir", "-p", "/var/run/spine").Run(); err != nil {
		return fmt.Errorf("failed to create /var/run/spine in container: %w", err)
	}

	// Spine API socket proxy
	if err := exec.Command("incus", "config", "device", "add", containerName,
		"spine-socket", "proxy",
		"connect=unix:"+socketPath,
		"listen=unix:/var/run/spine/spine.sock",
		"bind=container",
		"uid=0", "gid=0", "mode=0666",
	).Run(); err != nil {
		return fmt.Errorf("failed to add spine socket proxy: %w", err)
	}

	// Incus socket proxy (for UI container to query Incus API)
	incusSocketPath := cfg.Paths.IncusSocket
	if err := exec.Command("incus", "exec", containerName, "--",
		"mkdir", "-p", "/var/lib/incus").Run(); err != nil {
		fmt.Printf("Warning: could not create /var/lib/incus in container: %v\n", err)
	}
	if err := exec.Command("incus", "config", "device", "add", containerName,
		"incus-socket", "proxy",
		"connect=unix:"+incusSocketPath,
		"listen=unix:/var/lib/incus/unix.socket",
		"bind=container",
		"uid=0", "gid=0", "mode=0666",
	).Run(); err != nil {
		fmt.Printf("Warning: failed to add incus socket proxy: %v\n", err)
	}

	return nil
}

// installUINodeJS installs Node.js in the UI container.
func installUINodeJS(containerName, nodeVersion string) error {
	commands := []string{
		"apt-get update -qq",
		"DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates gnupg",
		"mkdir -p /etc/apt/keyrings",
		"curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg",
		fmt.Sprintf("echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_%s nodistro main' > /etc/apt/sources.list.d/nodesource.list", nodeVersion),
		"apt-get update -qq",
		"DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs",
	}

	for _, cmd := range commands {
		if err := exec.Command("incus", "exec", containerName, "--", "bash", "-c", cmd).Run(); err != nil {
			return fmt.Errorf("command failed: %s: %w", cmd, err)
		}
	}

	return nil
}

// DeployUIApp downloads and installs the latest UI release.
func DeployUIApp(containerName, appDir string, cfg *config.Config) error {
	downloadURL, err := releases.GetAssetURLForBranch(cfg, cfg.Releases.Repositories.UI, "standalone.tar", cfg.Releases.Repositories.UITagPrefix)
	if err != nil {
		return fmt.Errorf("failed to get UI download URL: %w", err)
	}

	fmt.Printf("Downloading UI from %s...\n", downloadURL)

	tmpFile, err := os.CreateTemp("", "ui-deploy-*.tar")
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	defer os.Remove(tmpFile.Name())
	tmpFile.Close()

	if err := exec.Command("curl", "-sSL", "-o", tmpFile.Name(), downloadURL).Run(); err != nil {
		return fmt.Errorf("failed to download UI: %w", err)
	}

	info, err := os.Stat(tmpFile.Name())
	if err != nil || info.Size() < 1000 {
		return fmt.Errorf("downloaded file is too small or missing")
	}
	fmt.Printf("  Downloaded %d bytes\n", info.Size())

	exec.Command("incus", "exec", containerName, "--", "mkdir", "-p", appDir).Run()

	if err := exec.Command("incus", "file", "push", tmpFile.Name(), containerName+"/tmp/ui-standalone.tar").Run(); err != nil {
		return fmt.Errorf("failed to push tarball: %w", err)
	}

	if err := exec.Command("incus", "exec", containerName, "--",
		"tar", "-xf", "/tmp/ui-standalone.tar", "-C", appDir, "--no-same-owner").Run(); err != nil {
		return fmt.Errorf("failed to extract tarball: %w", err)
	}

	// The tarball contains a "standalone/" directory. Move its contents to appDir.
	if err := exec.Command("incus", "exec", containerName, "--",
		"bash", "-c", fmt.Sprintf("cp -a %s/standalone/. %s/ && rm -rf %s/standalone", appDir, appDir, appDir)).Run(); err != nil {
		return fmt.Errorf("failed to flatten standalone directory: %w", err)
	}

	// Next.js standalone builds don't include .next/static — copy from tarball root if present
	exec.Command("incus", "exec", containerName, "--",
		"bash", "-c", fmt.Sprintf("if [ -d %s/.next/static ]; then echo 'Static files already present'; else echo 'Warning: .next/static missing from standalone output'; fi", appDir)).Run()

	exec.Command("incus", "exec", containerName, "--",
		"bash", "-c", fmt.Sprintf("cd %s && npm install styled-jsx --silent 2>/dev/null || true", appDir)).Run()

	exec.Command("incus", "exec", containerName, "--", "rm", "-f", "/tmp/ui-standalone.tar").Run()

	return nil
}

// createUIService creates a systemd service for the UI (disabled by default).
func createUIService(containerName, appDir string) error {
	serviceContent := fmt.Sprintf(`[Unit]
Description=YouEye UI
After=network.target

[Service]
Type=simple
EnvironmentFile=-/etc/youeye-ui.env
WorkingDirectory=%s
ExecStart=/usr/bin/node %s/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=HOSTNAME=0.0.0.0
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
`, appDir, appDir)

	// Write service file to temp on host then push
	tmpFile, err := os.CreateTemp("", "youeye-ui-*.service")
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	defer os.Remove(tmpFile.Name())
	tmpFile.WriteString(serviceContent)
	tmpFile.Close()

	if err := exec.Command("incus", "file", "push", tmpFile.Name(),
		containerName+"/etc/systemd/system/youeye-ui.service").Run(); err != nil {
		return fmt.Errorf("failed to push service file: %w", err)
	}

	// Daemon-reload but do NOT enable or start
	exec.Command("incus", "exec", containerName, "--", "systemctl", "daemon-reload").Run()

	// Create empty env file placeholder
	envContent := "# YouEye UI Environment - configured by Control Panel\n# This file is populated when UI is enabled via Control Panel\n"
	tmpEnv, _ := os.CreateTemp("", "youeye-ui-env-*")
	tmpEnv.WriteString(envContent)
	tmpEnv.Close()
	defer os.Remove(tmpEnv.Name())

	exec.Command("incus", "file", "push", tmpEnv.Name(),
		containerName+"/etc/youeye-ui.env").Run()

	return nil
}

// EnforceUIEgressBlock creates (if needed) and applies a network ACL that
// prevents the UI container from initiating connections to the CP container.
// CP→UI traffic is unaffected. This enforces the one-way bridge: CP pushes
// to UI, UI never calls CP. Browser-side iframes bypass this entirely since
// they go through Caddy, not container-to-container networking.
//
// Idempotent — safe to call on every deploy/update.
func EnforceUIEgressBlock() {
	cpIP, err := incus.GetSystemContainerIP("youeye-control")
	if err != nil {
		fmt.Printf("  Warning: could not resolve CP IP for egress block: %v\n", err)
		return
	}

	aclName := "ye-ui-egress-block"

	// Create ACL if it doesn't exist (idempotent — Incus returns error if exists)
	createErr := exec.Command("incus", "network", "acl", "create", aclName,
		"--description", "Block UI container from reaching CP container").Run()
	if createErr == nil {
		fmt.Printf("  Created network ACL: %s\n", aclName)
		// Add the egress reject rule
		if err := exec.Command("incus", "network", "acl", "rule", "add", aclName,
			"egress", "action=reject",
			fmt.Sprintf("destination=%s/32", cpIP),
			"description=Block UI from reaching CP",
		).Run(); err != nil {
			fmt.Printf("  Warning: could not add egress rule to %s: %v\n", aclName, err)
			return
		}
	}

	// Apply ACL to UI container's eth0 (idempotent — set overwrites)
	if err := exec.Command("incus", "config", "device", "set",
		"youeye-ui", "eth0", "security.acls", aclName).Run(); err != nil {
		fmt.Printf("  Warning: could not apply ACL to youeye-ui: %v\n", err)
		return
	}

	fmt.Printf("  ✓ UI→CP egress block enforced (ACL: %s, blocked: %s)\n", aclName, cpIP)
}
