package installer

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Engine messages (sent from install goroutine → TUI via channel)
// ---------------------------------------------------------------------------

// engineMsg carries a progress update from the background installer.
type engineMsg struct {
	StepName string  // current high-level step name
	LogLine  string  // single log line to display
	Percent  float64 // overall progress 0.0–1.0 (0 = no update)
	Done     bool
	Err      error
	ResultIP string // set on successful completion
}

// ---------------------------------------------------------------------------
// Engine entry point
// ---------------------------------------------------------------------------

// startEngine launches the provider for the configured mode in a background
// goroutine. The returned channel streams engineMsg updates until closed.
// Providers are registered in provider.go — add an installer by implementing
// Provider and registering it there.
func startEngine(config installConfig) <-chan engineMsg {
	ch := make(chan engineMsg, 200)
	go func() {
		defer close(ch)
		if p, ok := providerForMode(config.Mode); ok {
			p.Provision(config, ch)
			return
		}
		sendErr(ch, fmt.Errorf("no installer available for mode %q", config.Mode))
	}()
	return ch
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func send(ch chan<- engineMsg, step, log string, pct float64) {
	ch <- engineMsg{StepName: step, LogLine: log, Percent: pct}
}

func sendErr(ch chan<- engineMsg, err error) {
	ch <- engineMsg{Err: err, Done: true}
}

func sendDone(ch chan<- engineMsg, ip string) {
	ch <- engineMsg{Done: true, ResultIP: ip, Percent: 1.0}
}

// run executes a command and returns combined output.
func run(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// pctExec runs a command inside a Proxmox container.
func pctExec(ctid string, args ...string) (string, error) {
	fullArgs := append([]string{"exec", ctid, "--"}, args...)
	return run("pct", fullArgs...)
}

// streamCmd runs a command and sends each output line to the channel.
// It maps known Spine deploy output patterns to progress percentages.
// Stderr is merged into stdout to avoid pipe deadlocks (io.MultiReader
// reads sequentially, which blocks if stderr fills up before stdout EOF).
// Noisy lines (apt-get downloads, dpkg unpacking) are filtered out to
// prevent constant TUI re-renders that make games unplayable.
func streamCmd(ch chan<- engineMsg, stepName string, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	// Merge stderr into stdout so both streams flow through one pipe.
	// This avoids a deadlock where stderr fills its buffer while we're
	// still reading stdout via MultiReader.
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}
	cmd.Stderr = cmd.Stdout // merge stderr → stdout

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start: %w", err)
	}

	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		pct := parseDeployProgress(line)

		// Filter noisy lines to avoid flooding the TUI with re-renders
		if isNoisyLine(line) {
			if pct > 0 {
				ch <- engineMsg{StepName: stepName, Percent: pct}
			}
			continue
		}

		ch <- engineMsg{StepName: stepName, LogLine: line, Percent: pct}
	}

	return cmd.Wait()
}

// isNoisyLine returns true for verbose output lines that should not be
// displayed in the TUI log (apt-get downloads, dpkg details, etc.).
func isNoisyLine(line string) bool {
	if line == "" {
		return true
	}
	lower := strings.ToLower(line)
	switch {
	case strings.HasPrefix(lower, "get:"),
		strings.HasPrefix(lower, "hit:"),
		strings.HasPrefix(lower, "ign:"):
		return true
	case strings.Contains(lower, "reading database"),
		strings.Contains(lower, "reading package lists"),
		strings.Contains(lower, "building dependency tree"),
		strings.Contains(lower, "reading state information"):
		return true
	case strings.Contains(lower, "selecting previously"),
		strings.Contains(lower, "preparing to unpack"),
		strings.HasPrefix(lower, "unpacking "),
		strings.HasPrefix(lower, "setting up "),
		strings.Contains(lower, "processing triggers"):
		return true
	case strings.Contains(lower, "fetched "),
		strings.Contains(lower, "need to get"),
		strings.Contains(lower, "after this operation"),
		strings.Contains(lower, "the following new packages"),
		strings.Contains(lower, "the following additional"):
		return true
	case strings.Contains(lower, "is already the newest"),
		strings.Contains(lower, "newly installed"),
		strings.Contains(lower, "upgraded, "):
		return true
	}
	return false
}

// streamPctExec runs a command inside a container and streams output.
func streamPctExec(ch chan<- engineMsg, stepName string, ctid string, args ...string) error {
	fullArgs := append([]string{"exec", ctid, "--"}, args...)
	return streamCmd(ch, stepName, "pct", fullArgs...)
}

// parseDeployProgress maps known Spine deploy output to progress percentages.
// Container/VM creation is ~0-15%, Spine download ~15-20%, youeye deploy ~20-98%.
// The deploy itself has 4 major phases visible in output:
//
//	[1/4] Installing Incus         → 20-40%
//	[2/4] Starting API server      → 40-45%
//	[3/4] Deploying Control Panel  → 45-65%
//	[4/4] Infrastructure apps      → 65-95%
//	  - [1/4] PostgreSQL           → 68%
//	  - [2/4] Caddy                → 78%
//	  - [3/4] Pi-Hole              → 86%
//	  - [4/4] YouEye UI            → 91%
//	Bridge/CLI tokens              → 94%
//	Deployment Complete            → 97%
func parseDeployProgress(line string) float64 {
	lower := strings.ToLower(line)

	// Phase 1: Incus installation (20-40%)
	switch {
	case strings.Contains(lower, "checking for spine updates"),
		strings.Contains(lower, "checking for self-update"),
		strings.Contains(lower, "spine is up to date"):
		return 0.20
	case strings.Contains(lower, "creating youeye data"):
		return 0.21
	case strings.Contains(lower, "[1/4] installing incus"):
		return 0.22
	case strings.Contains(lower, "=== installing incus"):
		return 0.23
	case strings.Contains(lower, "zabbly") && strings.Contains(lower, "repository"):
		return 0.26
	case strings.Contains(lower, "installing incus..."):
		return 0.28
	case strings.Contains(lower, "incus installed"):
		return 0.34
	case strings.Contains(lower, "incus initialized"):
		return 0.36
	case strings.Contains(lower, "dhcp range"),
		strings.Contains(lower, "dns host-records"),
		strings.Contains(lower, "oci remote"):
		return 0.38
	case strings.Contains(lower, "incus installation complete"):
		return 0.40

	// Phase 2: API server (40-45%)
	case strings.Contains(lower, "[2/4]"),
		strings.Contains(lower, "starting youeye api"):
		return 0.42
	case strings.Contains(lower, "api server started"):
		return 0.45

	// Phase 3: Control Panel deployment (45-65%)
	case strings.Contains(lower, "[3/4]"),
		strings.Contains(lower, "deploying control panel"):
		return 0.46
	case strings.Contains(lower, "creating container") && strings.Contains(lower, "control"):
		return 0.48
	case strings.Contains(lower, "container") && strings.Contains(lower, "created"):
		return 0.50
	case strings.Contains(lower, "socket proxy"),
		strings.Contains(lower, "socket proxies"):
		return 0.52
	case strings.Contains(lower, "installing node"):
		return 0.54
	case strings.Contains(lower, "node.js installed"):
		return 0.56
	case strings.Contains(lower, "downloading") && strings.Contains(lower, "standalone"):
		return 0.58
	case strings.Contains(lower, "deploying to container"):
		return 0.60
	case strings.Contains(lower, "starting control panel"),
		strings.Contains(lower, "[7/7]"):
		return 0.62
	case strings.Contains(lower, "control panel") && strings.Contains(lower, "deployed successfully"):
		return 0.65

	// Phase 4: Infrastructure apps (65-95%)
	case strings.Contains(lower, "deploying infrastructure"):
		return 0.66
	case strings.Contains(lower, "[1/4]") && strings.Contains(lower, "postgres"):
		return 0.68
	case strings.Contains(lower, "[2/4]") && strings.Contains(lower, "caddy"):
		return 0.78
	case strings.Contains(lower, "[3/4]") && strings.Contains(lower, "pi-hole"),
		strings.Contains(lower, "[3/4]") && strings.Contains(lower, "pihole"):
		return 0.86
	case strings.Contains(lower, "[4/4]") && strings.Contains(lower, "ui"):
		return 0.91
	case strings.Contains(lower, "infrastructure deployment complete"):
		return 0.93

	// Finalization (94-97%)
	case strings.Contains(lower, "bridge token"):
		return 0.94
	case strings.Contains(lower, "cli token"):
		return 0.95
	case strings.Contains(lower, "deployment complete"):
		return 0.97
	case strings.Contains(lower, "setup url"):
		return 0.98
	}
	return 0
}

// getHostIP discovers the primary IPv4 address.
func getHostIP() string {
	out, err := run("ip", "-4", "route", "get", "1.1.1.1")
	if err != nil {
		return "localhost"
	}
	fields := strings.Fields(out)
	for i, f := range fields {
		if f == "src" && i+1 < len(fields) {
			return fields[i+1]
		}
	}
	return "localhost"
}

// ---------------------------------------------------------------------------
// Spine release resolution
// ---------------------------------------------------------------------------

func findLatestSpineTag() (string, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	req, err := http.NewRequest("GET", "https://api.github.com/repos/YouEye-Platform/YouEye/releases?per_page=50", nil)
	if err != nil {
		return "", fmt.Errorf("creating request: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "youeye-spine")
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("querying releases: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("releases API returned %d", resp.StatusCode)
	}

	var releases []struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name string `json:"name"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return "", fmt.Errorf("parsing releases: %w", err)
	}

	// Priority 1: stable main-branch spine release (spine-vX.Y.Z, 3-digit)
	for _, r := range releases {
		if strings.HasPrefix(r.TagName, "spine-v") && !strings.Contains(r.TagName, "-v") {
			// This would be "spine-vX.Y.Z" with no branch prefix
			ver := strings.TrimPrefix(r.TagName, "spine-v")
			if len(strings.Split(ver, ".")) == 3 && hasAsset(r.Assets, "spine-linux-amd64") {
				return r.TagName, nil
			}
		}
	}

	// Priority 2: any spine release with the binary asset (newest first)
	for _, r := range releases {
		if strings.Contains(r.TagName, "spine-") && strings.Contains(r.TagName, "-v") {
			if hasAsset(r.Assets, "spine-linux-amd64") {
				return r.TagName, nil
			}
		}
	}

	return "", fmt.Errorf("no spine release found on GitHub")
}

func hasAsset(assets []struct {
	Name string `json:"name"`
}, name string) bool {
	for _, a := range assets {
		if a.Name == name {
			return true
		}
	}
	return false
}

func spineDownloadURL(tag string) string {
	return fmt.Sprintf("https://github.com/youeye-platform/YouEye/releases/download/%s/spine-linux-amd64", tag)
}

func spineInstallCommand(config installConfig) (string, error) {
	scriptURL, err := rawFileURL(config.CoreRepoURL, config.ReleaseChannel, "spine/install.sh")
	if err != nil {
		return "", err
	}
	return fmt.Sprintf(
		"curl -fsSL %s | RELEASE_REPO_URL=%s BRANCH=%s sh",
		shellQuote(scriptURL),
		shellQuote(config.CoreRepoURL),
		shellQuote(config.ReleaseChannel),
	), nil
}

func seedMarketSourceLocal(config installConfig) error {
	legacy, multi, err := marketSourceJSON(config.MarketRepoURL)
	if err != nil {
		return err
	}
	if err := os.MkdirAll("/var/lib/youeye", 0o755); err != nil {
		return err
	}
	if err := os.WriteFile("/var/lib/youeye/market-source.json", legacy, 0o644); err != nil {
		return err
	}
	if err := os.WriteFile("/var/lib/youeye/market-sources.json", multi, 0o644); err != nil {
		return err
	}
	return nil
}

// ---------------------------------------------------------------------------
// LXC Installation
// ---------------------------------------------------------------------------

func installLXC(config installConfig, ch chan<- engineMsg) {
	ctid := config.ContainerID

	// -- Template --
	send(ch, "Checking OS template", "Looking for Debian 13 template...", 0.02)

	templateStorage := config.TemplateStorage
	if templateStorage == "" {
		templateStorage = "local"
	}

	// Find exact template name
	templateRef := ""
	if out, _ := run("pveam", "list", templateStorage); strings.Contains(out, "debian-13") {
		for _, line := range strings.Split(out, "\n") {
			if strings.Contains(line, "debian-13") {
				fields := strings.Fields(line)
				if len(fields) >= 1 {
					templateRef = fields[0] // e.g. "local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst"
					break
				}
			}
		}
	}

	if templateRef == "" {
		send(ch, "Downloading OS template", "Template not cached, downloading...", 0.03)
		if _, err := run("pveam", "update"); err != nil {
			send(ch, "Downloading OS template", "Warning: pveam update failed, trying download anyway", 0.04)
		}
		// Try current Debian 13 template names
		templateNames := []string{
			"debian-13-standard_13.1-2_amd64.tar.zst",
			"debian-13-standard_13.0-1_amd64.tar.zst",
		}
		downloaded := false
		for _, name := range templateNames {
			send(ch, "Downloading OS template", fmt.Sprintf("Trying %s...", name), 0.05)
			if _, err := run("pveam", "download", templateStorage, name); err == nil {
				templateRef = fmt.Sprintf("%s:vztmpl/%s", templateStorage, name)
				downloaded = true
				break
			}
		}
		if !downloaded {
			sendErr(ch, fmt.Errorf("could not download Debian 13 template — check network/storage"))
			return
		}
	}
	send(ch, "Checking OS template", fmt.Sprintf("Using %s", templateRef), 0.08)

	// -- Create container --
	send(ch, "Creating container", fmt.Sprintf("pct create %s ...", ctid), 0.10)

	args := []string{
		"create", ctid, templateRef,
		"-hostname", config.Hostname,
		"-cores", strconv.Itoa(config.CPUCores),
		"-memory", strconv.Itoa(config.RAMMB),
		"-rootfs", fmt.Sprintf("%s:%d", config.StoragePool, config.DiskGB),
		"-onboot", "1",
		"-tags", strings.ReplaceAll(config.Tags, " ", ""),
	}

	// Privilege level
	if config.ContainerType == "Unprivileged" {
		args = append(args, "-unprivileged", "1")
	} else {
		args = append(args, "-unprivileged", "0")
	}

	// Features
	var features []string
	if config.FeatNesting {
		features = append(features, "nesting=1")
	}
	if config.FeatFUSE {
		features = append(features, "fuse=1")
	}
	if config.FeatKeyctl {
		features = append(features, "keyctl=1")
	}
	if len(features) > 0 {
		args = append(args, "-features", strings.Join(features, ","))
	}

	// Network
	netCfg := fmt.Sprintf("name=eth0,bridge=%s", config.NetworkBridge)
	if config.IPMode == "Static" && config.StaticIP != "" {
		netCfg += fmt.Sprintf(",ip=%s", config.StaticIP)
		if config.Gateway != "" {
			netCfg += fmt.Sprintf(",gw=%s", config.Gateway)
		}
	} else {
		netCfg += ",ip=dhcp"
	}
	args = append(args, "-net0", netCfg)

	if out, err := run("pct", args...); err != nil {
		sendErr(ch, fmt.Errorf("pct create failed: %s\n%s", err, out))
		return
	}
	send(ch, "Creating container", "Container created", 0.15)

	// -- Start --
	send(ch, "Starting container", fmt.Sprintf("pct start %s", ctid), 0.17)
	if out, err := run("pct", "start", ctid); err != nil {
		sendErr(ch, fmt.Errorf("pct start failed: %s\n%s", err, out))
		return
	}

	// -- Set root password immediately (before deploy, so it works even if deploy fails) --
	if config.RootPassword != "" {
		send(ch, "Starting container", "Setting root password...", 0.18)
		pctExec(ctid, "bash", "-c", fmt.Sprintf("echo 'root:%s' | chpasswd", config.RootPassword))
	}

	// -- Wait for network --
	send(ch, "Waiting for network", "Polling for IP...", 0.20)
	var containerIP string
	for i := 0; i < 60; i++ {
		out, err := pctExec(ctid, "ip", "-4", "-o", "addr", "show", "dev", "eth0")
		if err == nil {
			containerIP = extractIPFromAddr(out)
			if containerIP != "" {
				break
			}
		}
		time.Sleep(time.Second)
		if i%5 == 4 {
			send(ch, "Waiting for network", fmt.Sprintf("Still waiting... (%ds)", i+1), 0.20)
		}
	}
	if containerIP == "" {
		sendErr(ch, fmt.Errorf("timeout: container did not get an IP after 60s"))
		return
	}
	send(ch, "Waiting for network", fmt.Sprintf("Container IP: %s", containerIP), 0.25)

	// -- Prerequisites --
	send(ch, "Installing prerequisites", "Running apt-get update...", 0.27)
	pctExec(ctid, "apt-get", "update", "-qq")
	send(ch, "Installing prerequisites", "Installing curl, ca-certificates...", 0.29)
	if out, err := pctExec(ctid, "apt-get", "install", "-y", "-qq", "curl", "ca-certificates"); err != nil {
		sendErr(ch, fmt.Errorf("installing prerequisites: %s\n%s", err, out))
		return
	}
	send(ch, "Installing prerequisites", "Done", 0.32)

	// -- Download Spine --
	send(ch, "Downloading Spine", "Resolving latest release...", 0.34)
	tag, err := findLatestSpineTag()
	if err != nil {
		sendErr(ch, fmt.Errorf("finding Spine release: %w", err))
		return
	}
	dlURL := spineDownloadURL(tag)
	send(ch, "Downloading Spine", fmt.Sprintf("Downloading %s...", tag), 0.36)
	// Install to /usr/bin so it's in pct exec's default PATH (/sbin:/bin:/usr/sbin:/usr/bin)
	// /usr/local/bin is NOT in pct exec's PATH on most PVE versions
	if out, err := pctExec(ctid, "curl", "-fsSL", dlURL, "-o", "/usr/bin/youeye"); err != nil {
		sendErr(ch, fmt.Errorf("downloading Spine binary: %s\n%s", err, out))
		return
	}
	pctExec(ctid, "chmod", "+x", "/usr/bin/youeye")
	pctExec(ctid, "ln", "-sf", "/usr/bin/youeye", "/usr/bin/spine")
	send(ch, "Downloading Spine", "Spine installed", 0.40)

	// -- Deploy --
	send(ch, "Deploying YouEye", "Running youeye deploy (this takes a few minutes)...", 0.42)
	if err := streamPctExec(ch, "Deploying YouEye", ctid, "/usr/bin/youeye", "deploy"); err != nil {
		sendErr(ch, fmt.Errorf("youeye deploy failed: %w", err))
		return
	}
	send(ch, "Deploying YouEye", "Deployment complete", 0.95)

	// -- Post-creation --
	if config.SSHEnabled {
		send(ch, "Finalizing", "Enabling SSH...", 0.97)
		pctExec(ctid, "systemctl", "enable", "--now", "ssh")
	}
	if config.Timezone != "" {
		send(ch, "Finalizing", "Setting timezone...", 0.98)
		pctExec(ctid, "timedatectl", "set-timezone", config.Timezone)
	}

	// Re-read IP in case it changed
	if out, err := pctExec(ctid, "ip", "-4", "-o", "addr", "show", "dev", "eth0"); err == nil {
		if ip := extractIPFromAddr(out); ip != "" {
			containerIP = ip
		}
	}

	sendDone(ch, containerIP)
}

// ---------------------------------------------------------------------------
// Bare Linux Installation
// ---------------------------------------------------------------------------

func installHost(config installConfig, ch chan<- engineMsg) {
	// -- Prerequisites --
	send(ch, "Checking prerequisites", "Verifying root...", 0.02)
	if os.Getuid() != 0 {
		sendErr(ch, fmt.Errorf("must be run as root (current UID: %d)", os.Getuid()))
		return
	}

	send(ch, "Checking prerequisites", "Checking OS...", 0.04)
	osData, _ := os.ReadFile("/etc/os-release")
	osStr := string(osData)
	if !strings.Contains(osStr, "ID=debian") && !strings.Contains(osStr, "ID=ubuntu") {
		sendErr(ch, fmt.Errorf("unsupported OS — requires Debian or Ubuntu"))
		return
	}

	send(ch, "Checking prerequisites", "Checking architecture...", 0.06)
	arch, _ := run("dpkg", "--print-architecture")
	if arch != "amd64" {
		sendErr(ch, fmt.Errorf("unsupported architecture: %s (need amd64)", arch))
		return
	}

	send(ch, "Checking prerequisites", "Checking systemd...", 0.07)
	if _, err := run("systemctl", "--version"); err != nil {
		sendErr(ch, fmt.Errorf("systemd not found — required for YouEye"))
		return
	}
	send(ch, "Checking prerequisites", "All checks passed", 0.10)

	// Install Spine from the configured core repository/channel. The public
	// default is GitHub/main; custom repos only come from flags or Advanced.
	send(ch, "Installing Spine", "Installing system core from configured source...", 0.16)
	installCmd, err := spineInstallCommand(config)
	if err != nil {
		sendErr(ch, fmt.Errorf("building Spine install command: %w", err))
		return
	}
	if err := streamCmd(ch, "Installing Spine", "bash", "-lc", installCmd); err != nil {
		sendErr(ch, fmt.Errorf("installing Spine: %w", err))
		return
	}

	send(ch, "Configuring Market", "Saving Market source...", 0.20)
	if err := seedMarketSourceLocal(config); err != nil {
		sendErr(ch, fmt.Errorf("saving Market source: %w", err))
		return
	}

	// -- Deploy --
	send(ch, "Deploying YouEye", "Running youeye deploy (this takes a few minutes)...", 0.22)
	if err := streamCmd(ch, "Deploying YouEye", "youeye", "deploy"); err != nil {
		sendErr(ch, fmt.Errorf("youeye deploy failed: %w", err))
		return
	}

	// -- Host IP --
	send(ch, "Finalizing", "Detecting host IP...", 0.96)
	hostIP := getHostIP()

	sendDone(ch, hostIP)
}

// ---------------------------------------------------------------------------
// SSH key helpers
// ---------------------------------------------------------------------------

// findHostSSHKey looks for an existing SSH private key on the Proxmox host.
// Returns (privateKeyPath, publicKeyContent) or ("", "") if none found.
func findHostSSHKey() (string, string) {
	candidates := []string{
		"/root/.ssh/id_ed25519",
		"/root/.ssh/id_rsa",
		"/root/.ssh/id_ecdsa",
	}
	for _, priv := range candidates {
		pub := priv + ".pub"
		if _, err := os.Stat(priv); err != nil {
			continue
		}
		data, err := os.ReadFile(pub)
		if err != nil {
			continue
		}
		content := strings.TrimSpace(string(data))
		if content != "" {
			return priv, content
		}
	}
	return "", ""
}

// ---------------------------------------------------------------------------
// IP parsing helpers
// ---------------------------------------------------------------------------

// extractIPFromAddr parses "2: eth0 inet 10.0.0.50/24 ..." style output.
func extractIPFromAddr(out string) string {
	for _, field := range strings.Fields(out) {
		if strings.Contains(field, ".") && strings.Contains(field, "/") {
			return strings.Split(field, "/")[0]
		}
	}
	return ""
}

// parseVMIP extracts IPv4 from qm agent network-get-interfaces JSON.
func parseVMIP(out string) string {
	// qm agent output can be raw JSON or wrapped
	type netIface struct {
		Name        string `json:"name"`
		IPAddresses []struct {
			IPAddress string `json:"ip-address"`
			IPType    string `json:"ip-address-type"`
		} `json:"ip-addresses"`
	}

	// Try parsing as array directly
	var ifaces []netIface
	if err := json.Unmarshal([]byte(out), &ifaces); err != nil {
		// Try unwrapping from {"return": [...]}
		var wrapper struct {
			Return []netIface `json:"return"`
		}
		if err := json.Unmarshal([]byte(out), &wrapper); err != nil {
			// Try {"result": [...]}
			var wrapper2 struct {
				Result []netIface `json:"result"`
			}
			if err := json.Unmarshal([]byte(out), &wrapper2); err != nil {
				return ""
			}
			ifaces = wrapper2.Result
		} else {
			ifaces = wrapper.Return
		}
	}

	for _, iface := range ifaces {
		if iface.Name == "lo" {
			continue
		}
		for _, addr := range iface.IPAddresses {
			if addr.IPType == "ipv4" && !strings.HasPrefix(addr.IPAddress, "127.") {
				return addr.IPAddress
			}
		}
	}
	return ""
}
