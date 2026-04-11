package cmd

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"git.byka.wtf/potemsla/YouEye/spine/internal/config"
	"git.byka.wtf/potemsla/YouEye/spine/internal/version"
)

func runStatus() error {
	cfg := GetConfig()
	
	fmt.Println("========================================")
	fmt.Println("  YouEye Spine Status")
	fmt.Println("========================================")
	fmt.Println("")

	// Spine version
	fmt.Printf("Spine:           v%s", Version)
	if update, newVer := checkSpineUpdate(cfg); update {
		fmt.Printf(" → v%s available", newVer)
	} else {
		fmt.Print(" (latest)")
	}
	fmt.Println("")

	// Host system
	osRelease := getOSRelease()
	fmt.Printf("Host System:     %s", osRelease)
	upgrades := countUpgradablePackages()
	if upgrades > 0 {
		fmt.Printf(" - %d updates available", upgrades)
	}
	fmt.Println("")

	// Incus
	incusVer := getIncusVersion()
	fmt.Printf("Incus:           %s\n", incusVer)

	// Control Panel
	controlStatus := getControlPanelStatus(cfg)
	fmt.Printf("Control Panel:   %s\n", controlStatus)

	// Caddy
	caddyStatus := getAppStatus("youeye-caddy")
	fmt.Printf("Caddy:           %s\n", caddyStatus)

	// Pi-Hole
	piholeStatus := getAppStatus("youeye-pihole")
	fmt.Printf("Pi-Hole:         %s\n", piholeStatus)
	fmt.Println("")

	// Container count
	containers := getContainerCount()
	fmt.Printf("Containers:      %s\n", containers)

	// API server status
	apiStatus := "Not running"
	if _, err := os.Stat(cfg.API.SocketPath); err == nil {
		apiStatus = fmt.Sprintf("Running (Unix socket: %s)", cfg.API.SocketPath)
	}
	fmt.Printf("API Server:      %s\n", apiStatus)
	fmt.Println("")

	// Suggestions
	if update, _ := checkSpineUpdate(cfg); update {
		fmt.Println("Run 'spine update self' to update Spine.")
	}
	if upgrades > 0 {
		fmt.Println("Run 'spine update system' to update host OS.")
	}

	return nil
}

func checkSpineUpdate(cfg *config.Config) (bool, string) {
	client := &http.Client{Timeout: 10 * time.Second}
	apiURL := fmt.Sprintf("%s%s/repos/%s/%s/releases?limit=50",
		cfg.Releases.BaseURL,
		cfg.Releases.APIPath,
		cfg.Releases.Organization,
		cfg.Releases.Repositories.Spine)

	resp, err := client.Get(apiURL)
	if err != nil {
		return false, ""
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return false, ""
	}

	var rels []struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rels); err != nil || len(rels) == 0 {
		return false, ""
	}

	// Read release branch from youeye.yaml
	branch := ""
	if data, err := os.ReadFile("/var/lib/youeye/config/youeye.yaml"); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "release_branch:") {
				branch = strings.TrimSpace(strings.TrimPrefix(line, "release_branch:"))
				branch = strings.Trim(branch, "\"'")
				break
			}
		}
	}

	tagPrefix := cfg.Releases.Repositories.SpineTagPrefix

	// Find latest version matching our branch (sort by version numerically)
	latestVer := ""
	if branch != "" && branch != "main" {
		branchSuffix := branch + "-v"
		var branchVersions []string
		for _, r := range rels {
			stripped := r.TagName
			if tagPrefix != "" {
				if !strings.HasPrefix(stripped, tagPrefix+"-") {
					continue
				}
				stripped = strings.TrimPrefix(stripped, tagPrefix+"-")
			}
			if strings.HasPrefix(stripped, branchSuffix) {
				branchVersions = append(branchVersions, strings.TrimPrefix(stripped, branchSuffix))
			}
		}
		if len(branchVersions) > 0 {
			version.SortVersionsDesc(branchVersions)
			latestVer = branchVersions[0]
		}
	}
	// Fallback to main releases
	if latestVer == "" {
		var mainVersions []string
		for _, r := range rels {
			stripped := r.TagName
			if tagPrefix != "" {
				if !strings.HasPrefix(stripped, tagPrefix+"-") {
					continue
				}
				stripped = strings.TrimPrefix(stripped, tagPrefix+"-")
			}
			if len(stripped) >= 2 && stripped[0] == 'v' && stripped[1] >= '0' && stripped[1] <= '9' {
				mainVersions = append(mainVersions, strings.TrimPrefix(stripped, "v"))
			}
		}
		if len(mainVersions) > 0 {
			version.SortVersionsDesc(mainVersions)
			latestVer = mainVersions[0]
		}
	}

	if latestVer != "" && version.IsNewer(latestVer, Version) {
		return true, latestVer
	}
	return false, ""
}

func getOSRelease() string {
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return "Unknown"
	}
	
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), "\"")
		}
	}
	return "Linux"
}

func countUpgradablePackages() int {
	exec.Command("apt-get", "update", "-qq").Run()
	out, err := exec.Command("apt", "list", "--upgradable", "-qq").Output()
	if err != nil {
		return 0
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return 0
	}
	return len(lines)
}

func getIncusVersion() string {
	out, err := exec.Command("incus", "version").Output()
	if err != nil {
		return "Not installed"
	}
	// Parse "Client version: 6.0.4"
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "Client version:") {
			return strings.TrimSpace(strings.TrimPrefix(line, "Client version:"))
		}
	}
	return strings.TrimSpace(string(out))
}

func getControlPanelStatus(cfg *config.Config) string {
	containerName := cfg.Deployment.Container.Name
	appDir := cfg.Deployment.ControlPanel.AppDir
	
	// Check if container exists
	out, err := exec.Command("incus", "list", containerName, "--format", "csv", "-c", "s").Output()
	if err != nil {
		return "Not deployed"
	}

	status := strings.TrimSpace(string(out))
	if status == "" {
		return "Not deployed"
	}

	if strings.ToUpper(status) == "RUNNING" {
		// Try to get version
		verOut, err := exec.Command("incus", "exec", containerName, "--", 
			"cat", appDir+"/package.json").Output()
		if err == nil {
			var pkg struct {
				Version string `json:"version"`
			}
			if json.Unmarshal(verOut, &pkg) == nil && pkg.Version != "" {
				return fmt.Sprintf("Running (v%s)", pkg.Version)
			}
		}
		return "Running"
	}

	return status
}

func getContainerCount() string {
	out, err := exec.Command("incus", "list", "--format", "csv", "-c", "s").Output()
	if err != nil {
		return "0 running, 0 stopped"
	}

	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	running := 0
	stopped := 0
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if strings.ToUpper(strings.TrimSpace(line)) == "RUNNING" {
			running++
		} else {
			stopped++
		}
	}
	return fmt.Sprintf("%d running, %d stopped", running, stopped)
}

// getAppStatus returns a brief status for an app container via Incus CLI.
func getAppStatus(containerName string) string {
	out, err := exec.Command("incus", "list", containerName, "--format", "csv", "-c", "s").Output()
	if err != nil {
		return "not installed"
	}
	status := strings.TrimSpace(string(out))
	if status == "" {
		return "not installed"
	}
	return strings.ToLower(status)
}
