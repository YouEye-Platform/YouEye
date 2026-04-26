package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"git.byka.wtf/potemsla/YouEye/spine/internal/backup"
	"git.byka.wtf/potemsla/YouEye/spine/internal/config"
	"git.byka.wtf/potemsla/YouEye/spine/internal/releases"
	"git.byka.wtf/potemsla/YouEye/spine/internal/update"
	"git.byka.wtf/potemsla/YouEye/spine/internal/util"
	"gopkg.in/yaml.v3"
)

// authAttempt tracks authentication attempts for rate limiting
type authAttempt struct {
	attempts []time.Time
}

// authRateLimiter manages rate limiting for authentication
type authRateLimiter struct {
	mu            sync.Mutex
	attempts      map[string]*authAttempt
	maxAttempts   int
	windowMinutes int
}

func newAuthRateLimiter(cfg *config.Config) *authRateLimiter {
	return &authRateLimiter{
		attempts:      make(map[string]*authAttempt),
		maxAttempts:   cfg.API.Auth.MaxAttempts,
		windowMinutes: cfg.API.Auth.WindowMinutes,
	}
}

// checkRateLimit returns true if the request should be allowed, false if rate limited
func (l *authRateLimiter) checkRateLimit(username string) (bool, int) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	windowDuration := time.Duration(l.windowMinutes) * time.Minute
	cutoff := now.Add(-windowDuration)

	// Get or create attempt record
	record, exists := l.attempts[username]
	if !exists {
		record = &authAttempt{}
		l.attempts[username] = record
	}

	// Filter out old attempts
	validAttempts := make([]time.Time, 0, len(record.attempts))
	for _, t := range record.attempts {
		if t.After(cutoff) {
			validAttempts = append(validAttempts, t)
		}
	}
	record.attempts = validAttempts

	// Check if under limit
	remaining := l.maxAttempts - len(record.attempts)
	if remaining <= 0 {
		return false, 0
	}

	// Record this attempt
	record.attempts = append(record.attempts, now)
	return true, remaining - 1
}

// cleanup removes expired entries (called periodically)
func (l *authRateLimiter) cleanup() {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	windowDuration := time.Duration(l.windowMinutes) * time.Minute
	cutoff := now.Add(-windowDuration)

	for username, record := range l.attempts {
		// Remove entries with no recent attempts
		hasRecent := false
		for _, t := range record.attempts {
			if t.After(cutoff) {
				hasRecent = true
				break
			}
		}
		if !hasRecent {
			delete(l.attempts, username)
		}
	}
}

type Server struct {
	version     string
	socketPath  string
	mux         *http.ServeMux
	cfg         *config.Config
	authLimiter *authRateLimiter

	// Status cache — avoids shelling out on every request
	statusMu    sync.Mutex
	statusCache map[string]interface{}
	statusTime  time.Time

	// Updates cache
	updatesMu    sync.Mutex
	updatesCache map[string]interface{}
	updatesTime  time.Time
}

func NewServer(version string, cfg *config.Config) *Server {
	s := &Server{
		version:     version,
		socketPath:  cfg.API.SocketPath,
		mux:         http.NewServeMux(),
		cfg:         cfg,
		authLimiter: newAuthRateLimiter(cfg),
	}
	s.setupRoutes()
	return s
}

func (s *Server) setupRoutes() {
	s.mux.HandleFunc("/api/health", s.handleHealth)
	s.mux.HandleFunc("/api/version", s.handleVersion)
	s.mux.HandleFunc("/api/status", s.handleStatus)
	s.mux.HandleFunc("/api/updates/check", s.handleUpdatesCheck)
	s.mux.HandleFunc("/api/auth/verify", s.handleAuthVerify)
	s.mux.HandleFunc("/api/update/self", s.handleUpdateSelf)
	s.mux.HandleFunc("/api/update/incus", s.handleUpdateIncus)
	s.mux.HandleFunc("/api/update/system", s.handleUpdateSystem)
	s.mux.HandleFunc("/api/update/control", s.handleUpdateControl)
	s.mux.HandleFunc("/api/update/app/", s.handleUpdateApp)
	s.mux.HandleFunc("/api/postgres/credentials", s.handlePostgresCredentials)
	s.mux.HandleFunc("/api/pihole/credentials", s.handlePiholeCredentials)
	s.mux.HandleFunc("/api/authentik/credentials", s.handleAuthentikCredentials)
	s.mux.HandleFunc("/api/control/sso", s.handleControlSSO)
	s.mux.HandleFunc("/api/control/restart", s.handleControlRestart)
	s.mux.HandleFunc("/api/ui/sso", s.handleUISSO)
	// UI updates are handled by the Control Panel directly (lxd-updater), not Spine
	s.mux.HandleFunc("/api/config", s.handleYouEyeConfig)
	s.mux.HandleFunc("/api/update/status", s.handleUpdateStatus)
	s.mux.HandleFunc("/api/registry/digest", s.handleRegistryDigest)
	s.mux.HandleFunc("/api/backup/run", s.handleBackupRun)
	s.mux.HandleFunc("/api/backup/status", s.handleBackupStatus)
	s.mux.HandleFunc("/api/backup/volumes", s.handleBackupVolumes)
	s.mux.HandleFunc("/api/backup/storage-driver", s.handleStorageDriver)
	s.mux.HandleFunc("/api/backup/list", s.handleBackupList)
	s.mux.HandleFunc("/api/backup/config", s.handleBackupConfig)
	s.mux.HandleFunc("/api/backup/restore", s.handleBackupRestore)
	s.mux.HandleFunc("/api/backup/prune", s.handleBackupPrune)
}

func (s *Server) ListenAndServe() error {
	// Remove existing socket
	os.Remove(s.socketPath)

	// Create Unix socket listener
	listener, err := net.Listen("unix", s.socketPath)
	if err != nil {
		return fmt.Errorf("failed to create socket: %w", err)
	}
	defer listener.Close()

	// Set socket permissions (readable by all - access controlled by proxy device)
	if err := os.Chmod(s.socketPath, os.FileMode(s.cfg.API.SocketPermissions)); err != nil {
		fmt.Printf("Warning: could not set socket permissions: %v\n", err)
	}

	// Start rate limiter cleanup goroutine
	cleanupInterval := time.Duration(s.cfg.API.Auth.CleanupIntervalMinutes) * time.Minute
	go func() {
		ticker := time.NewTicker(cleanupInterval)
		defer ticker.Stop()
		for range ticker.C {
			s.authLimiter.cleanup()
		}
	}()

	// Start backup scheduler
	backup.StartScheduler("")

	fmt.Printf("API server listening on %s\n", s.socketPath)

	return http.Serve(listener, s.mux)
}

// Response helpers
func jsonResponse(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func errorResponse(w http.ResponseWriter, message string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}

// Handlers
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	jsonResponse(w, map[string]string{"status": "ok"})
}

func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	jsonResponse(w, map[string]string{
		"version": s.version,
		"service": "spine",
	})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	const cacheTTL = 30 * time.Second

	s.statusMu.Lock()
	if s.statusCache != nil && time.Since(s.statusTime) < cacheTTL {
		cached := s.statusCache
		s.statusMu.Unlock()
		jsonResponse(w, cached)
		return
	}
	s.statusMu.Unlock()

	// Parallel data collection
	var wg sync.WaitGroup
	var incusVer, osRel string
	var controlSt, uiSt map[string]interface{}

	wg.Add(4)
	go func() { defer wg.Done(); incusVer = getIncusVersion() }()
	go func() { defer wg.Done(); controlSt = getControlStatus() }()
	go func() { defer wg.Done(); uiSt = getUIStatus(s.cfg) }()
	go func() { defer wg.Done(); osRel = getOSRelease() }()
	wg.Wait()

	status := map[string]interface{}{
		"spine":         map[string]string{"version": s.version},
		"incus":         map[string]string{"version": incusVer},
		"control_panel": controlSt,
		"ui":            uiSt,
		"host":          map[string]string{"os": osRel},
	}

	s.statusMu.Lock()
	s.statusCache = status
	s.statusTime = time.Now()
	s.statusMu.Unlock()

	jsonResponse(w, status)
}

// handleUpdatesCheck checks for available updates from configured release source
func (s *Server) handleUpdatesCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	const cacheTTL = 60 * time.Second

	s.updatesMu.Lock()
	if s.updatesCache != nil && time.Since(s.updatesTime) < cacheTTL {
		cached := s.updatesCache
		s.updatesMu.Unlock()
		jsonResponse(w, cached)
		return
	}
	s.updatesMu.Unlock()

	// Parallel version + release checks
	var wg sync.WaitGroup
	var controlVer, uiVer string
	var spineLatestRel, controlLatestRel, uiLatestRel string

	wg.Add(5)
	go func() { defer wg.Done(); controlVer = s.getControlVersion() }()
	go func() { defer wg.Done(); uiVer = s.getUIVersion() }()
	go func() { defer wg.Done(); spineLatestRel = s.getLatestRelease(s.cfg.Releases.Repositories.Spine, s.cfg.Releases.Repositories.SpineTagPrefix) }()
	go func() { defer wg.Done(); controlLatestRel = s.getLatestRelease(s.cfg.Releases.Repositories.ControlPanel, s.cfg.Releases.Repositories.ControlPanelTagPrefix) }()
	go func() { defer wg.Done(); uiLatestRel = s.getLatestRelease(s.cfg.Releases.Repositories.UI, s.cfg.Releases.Repositories.UITagPrefix) }()
	wg.Wait()

	updates := map[string]interface{}{
		"checked_at": time.Now().UTC().Format(time.RFC3339),
		"spine": map[string]interface{}{
			"current":   s.version,
			"latest":    spineLatestRel,
			"available": false,
		},
		"control": map[string]interface{}{
			"current":   controlVer,
			"latest":    controlLatestRel,
			"available": false,
		},
		"ui": map[string]interface{}{
			"current":   uiVer,
			"latest":    uiLatestRel,
			"available": false,
		},
	}

	// Check if updates are available
	spineLatest := updates["spine"].(map[string]interface{})["latest"].(string)
	spineUpdate := updates["spine"].(map[string]interface{})
	if spineLatest != "" && spineLatest != s.version && spineLatest != "unknown" {
		spineUpdate["available"] = true
	}

	controlCurrent := updates["control"].(map[string]interface{})["current"].(string)
	controlLatest := updates["control"].(map[string]interface{})["latest"].(string)
	controlUpdate := updates["control"].(map[string]interface{})
	if controlLatest != "" && controlLatest != controlCurrent && controlLatest != "unknown" {
		controlUpdate["available"] = true
	}

	uiCurrent := updates["ui"].(map[string]interface{})["current"].(string)
	uiLatest := updates["ui"].(map[string]interface{})["latest"].(string)
	uiUpdate := updates["ui"].(map[string]interface{})
	if uiLatest != "" && uiLatest != uiCurrent && uiLatest != "unknown" {
		uiUpdate["available"] = true
	}

	// Single apt call for both incus upgrade check and system count
	aptOutput, _ := exec.Command("apt", "list", "--upgradeable").CombinedOutput()
	aptLines := string(aptOutput)
	incusUpgradeable := strings.Contains(aptLines, "incus/")
	upgradeableCount := 0
	for _, line := range strings.Split(strings.TrimSpace(aptLines), "\n") {
		if strings.Contains(line, "/") && !strings.HasPrefix(line, "Listing") {
			upgradeableCount++
		}
	}

	updates["incus"] = map[string]interface{}{
		"current":   getIncusVersion(),
		"available": incusUpgradeable,
	}
	updates["system"] = map[string]interface{}{
		"current":           getOSRelease(),
		"upgradeable_count": upgradeableCount,
		"available":         upgradeableCount > 0,
	}

	// OCI app updates — check each deployed container's image fingerprint
	// against the latest available from the registry
	type ociAppCheck struct {
		Name          string `json:"name"`
		DisplayName   string `json:"display_name"`
		ContainerName string `json:"container_name"`
		Status        string `json:"status"`
		ImageTag      string `json:"image_tag"`
		Available     bool   `json:"available"`
	}
	var appUpdates []ociAppCheck

	// Define the OCI apps we track
	ociApps := []struct {
		name, displayName, container, image string
	}{
		{"caddy", "Caddy", "youeye-caddy", "docker.io/library/caddy"},
		{"pihole", "Pi-Hole", "youeye-pihole", "docker.io/pihole/pihole:latest"},
		{"postgres", "PostgreSQL", "youeye-postgres", "docker.io/library/postgres:17-alpine"},
		{"authentik", "Authentik", "youeye-authentik", "ghcr.io/goauthentik/server:2025.12"},
	}

	for _, a := range ociApps {
		status := getAppContainerStatus(a.container)
		// Extract image tag from the image reference
		imageTag := a.image
		if idx := strings.LastIndex(a.image, ":"); idx > 0 {
			imageTag = a.image[idx+1:]
		} else {
			imageTag = "latest"
		}
		appUpdates = append(appUpdates, ociAppCheck{
			Name:          a.name,
			DisplayName:   a.displayName,
			ContainerName: a.container,
			Status:        status,
			ImageTag:      imageTag,
			Available:     false, // OCI updates require manual pull — we track status only
		})
	}
	updates["apps"] = appUpdates

	s.updatesMu.Lock()
	s.updatesCache = updates
	s.updatesTime = time.Now()
	s.updatesMu.Unlock()

	jsonResponse(w, updates)
}

// getPackageUpgradeAvailable checks if a specific apt package has an upgrade available.
func getPackageUpgradeAvailable(pkg string) bool {
	out, err := exec.Command("apt", "list", "--upgradeable").CombinedOutput()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), pkg+"/")
}

// getSystemUpgradeableCount returns the number of packages with available upgrades.
func getSystemUpgradeableCount() int {
	out, err := exec.Command("apt", "list", "--upgradeable").CombinedOutput()
	if err != nil {
		return 0
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	count := 0
	for _, line := range lines {
		if strings.Contains(line, "/") && !strings.HasPrefix(line, "Listing") {
			count++
		}
	}
	return count
}

// getAppContainerStatus returns the status of an Incus container.
func getAppContainerStatus(containerName string) string {
	out, err := exec.Command("incus", "list", containerName, "--format", "csv", "-c", "s").Output()
	if err != nil {
		return "not-installed"
	}
	status := strings.TrimSpace(string(out))
	if status == "" {
		return "not-installed"
	}
	return strings.ToLower(status)
}

func (s *Server) handleAuthVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errorResponse(w, "invalid request", http.StatusBadRequest)
		return
	}

	if req.Username == "" || req.Password == "" {
		errorResponse(w, "username and password required", http.StatusBadRequest)
		return
	}

	// Rate limiting check
	windowDuration := time.Duration(s.cfg.API.Auth.WindowMinutes) * time.Minute
	allowed, remaining := s.authLimiter.checkRateLimit(req.Username)
	if !allowed {
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", fmt.Sprintf("%d", time.Now().Add(windowDuration).Unix()))
		errorResponse(w, fmt.Sprintf("too many authentication attempts, please wait %d minutes", s.cfg.API.Auth.WindowMinutes), http.StatusTooManyRequests)
		return
	}

	// Authenticate using PAM
	authenticated := verifyPAM(req.Username, req.Password)
	
	// Get user groups if authenticated
	var groups []string
	if authenticated {
		groups = getUserGroups(req.Username)
	}

	// Set rate limit headers
	w.Header().Set("X-RateLimit-Remaining", fmt.Sprintf("%d", remaining))

	jsonResponse(w, map[string]interface{}{
		"authenticated": authenticated,
		"username":      req.Username,
		"groups":        groups,
	})
}

func (s *Server) handleUpdateSelf(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Write initial status before starting background update
	update.Start("spine", s.version)

	// Run update in background — the CLI now writes status to disk at each stage
	go func() {
		cmd := exec.Command("spine", "update", "self")
		cmd.Run()
	}()

	jsonResponse(w, map[string]string{
		"status":  "started",
		"message": "Spine update initiated",
	})
}

// handleUpdateStatus returns the current update status from the status file.
func (s *Server) handleUpdateStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	jsonResponse(w, update.ReadStatus())
}

func (s *Server) handleUpdateIncus(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Run update
	cmd := exec.Command("apt-get", "update")
	cmd.Run()
	cmd = exec.Command("apt-get", "install", "-y", "--only-upgrade", "incus")
	output, err := cmd.CombinedOutput()

	if err != nil {
		errorResponse(w, fmt.Sprintf("update failed: %s", string(output)), http.StatusInternalServerError)
		return
	}

	jsonResponse(w, map[string]string{
		"status":  "success",
		"message": "Incus updated",
		"output":  string(output),
	})
}

func (s *Server) handleUpdateSystem(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Run update
	exec.Command("apt-get", "update").Run()
	cmd := exec.Command("apt-get", "upgrade", "-y")
	output, err := cmd.CombinedOutput()

	if err != nil {
		errorResponse(w, fmt.Sprintf("update failed: %s", string(output)), http.StatusInternalServerError)
		return
	}

	// Check if reboot required
	rebootRequired := false
	if _, err := os.Stat("/var/run/reboot-required"); err == nil {
		rebootRequired = true
	}

	jsonResponse(w, map[string]interface{}{
		"status":          "success",
		"message":         "System updated",
		"reboot_required": rebootRequired,
	})
}

func (s *Server) handleUpdateControl(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	containerName := s.cfg.Deployment.Container.Name
	port := s.cfg.Deployment.ControlPanel.Port
	appDir := s.cfg.Deployment.ControlPanel.AppDir

	// Get current and latest versions
	currentVersion := s.getControlVersion()
	latestVersion := s.getLatestRelease(s.cfg.Releases.Repositories.ControlPanel, s.cfg.Releases.Repositories.ControlPanelTagPrefix)

	if latestVersion == "" || latestVersion == "unknown" {
		errorResponse(w, "could not determine latest version", http.StatusInternalServerError)
		return
	}

	if currentVersion == latestVersion {
		jsonResponse(w, map[string]string{
			"status":  "up-to-date",
			"message": fmt.Sprintf("Control Panel is already at version %s", currentVersion),
		})
		return
	}

	update.Start("control", currentVersion)
	update.Emit("control", update.StatusDownloading, 10, "Creating snapshot...")

	// Create snapshot before update
	exec.Command("incus", "snapshot", "delete", containerName, "pre-update").Run()
	if err := exec.Command("incus", "snapshot", "create", containerName, "pre-update").Run(); err != nil {
		fmt.Printf("Warning: could not create snapshot: %v\n", err)
	}

	// Get download URL from release assets
	downloadURL, err := s.getAssetDownloadURL(s.cfg.Releases.Repositories.ControlPanel, "standalone.tar", s.cfg.Releases.Repositories.ControlPanelTagPrefix)
	if err != nil {
		errorResponse(w, fmt.Sprintf("failed to get download URL: %v", err), http.StatusInternalServerError)
		return
	}
	fmt.Printf("Downloading from %s...\n", downloadURL)

	update.Emit("control", update.StatusDownloading, 20, fmt.Sprintf("Downloading %s...", latestVersion))

	dlClient := releases.NewIPv4Client(10 * time.Minute)
	resp, err := dlClient.Get(downloadURL)
	if err != nil {
		update.Fail("control", currentVersion, fmt.Sprintf("download failed: %v", err))
		errorResponse(w, fmt.Sprintf("failed to download update: %v", err), http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		update.Fail("control", currentVersion, fmt.Sprintf("download returned status %d", resp.StatusCode))
		errorResponse(w, fmt.Sprintf("download failed with status: %d", resp.StatusCode), http.StatusInternalServerError)
		return
	}

	// Save to temp file on host
	tmpFile, err := os.CreateTemp("", "control-update-*.tar")
	if err != nil {
		update.Fail("control", currentVersion, fmt.Sprintf("temp file creation failed: %v", err))
		errorResponse(w, fmt.Sprintf("failed to create temp file: %v", err), http.StatusInternalServerError)
		return
	}
	defer os.Remove(tmpFile.Name())

	_, err = io.Copy(tmpFile, resp.Body)
	tmpFile.Close()
	if err != nil {
		errorResponse(w, fmt.Sprintf("failed to download: %v", err), http.StatusInternalServerError)
		return
	}

	update.Emit("control", update.StatusInstalling, 40, "Stopping Control Panel...")

	// Stop service
	exec.Command("incus", "exec", containerName, "--", "systemctl", "stop", "youeye-control").Run()

	// Clear old files and deploy new ones
	exec.Command("incus", "exec", containerName, "--", "rm", "-rf", appDir).Run()
	exec.Command("incus", "exec", containerName, "--", "mkdir", "-p", appDir).Run()

	update.Emit("control", update.StatusInstalling, 50, "Deploying new version...")

	// Push tarball to container
	if err := exec.Command("incus", "file", "push", tmpFile.Name(), containerName+"/tmp/update.tar").Run(); err != nil {
		// Rollback
		exec.Command("incus", "snapshot", "restore", containerName, "pre-update").Run()
		update.Fail("control", currentVersion, "failed to push update to container")
		errorResponse(w, fmt.Sprintf("failed to push update: %v", err), http.StatusInternalServerError)
		return
	}

	// Extract tarball
	if err := exec.Command("incus", "exec", containerName, "--",
		"tar", "-xf", "/tmp/update.tar", "-C", appDir, "--no-same-owner").Run(); err != nil {
		// Rollback
		exec.Command("incus", "snapshot", "restore", containerName, "pre-update").Run()
		update.Fail("control", currentVersion, "failed to extract update")
		errorResponse(w, fmt.Sprintf("failed to extract update: %v", err), http.StatusInternalServerError)
		return
	}

	// Install dependencies (styled-jsx fix)
	exec.Command("incus", "exec", containerName, "--",
		"bash", "-c", fmt.Sprintf("cd %s && npm install styled-jsx --silent 2>/dev/null || true", appDir)).Run()

	// Clean up
	exec.Command("incus", "exec", containerName, "--", "rm", "/tmp/update.tar").Run()

	update.Emit("control", update.StatusRestarting, 70, "Starting Control Panel...")

	// Start service
	exec.Command("incus", "exec", containerName, "--", "systemctl", "start", "youeye-control").Run()

	update.Emit("control", update.StatusVerifying, 80, "Checking health...")

	// Health check
	healthy := false
	healthURL := fmt.Sprintf("http://127.0.0.1:%d/api/auth/session", port)
	for i := 0; i < 15; i++ {
		time.Sleep(2 * time.Second)
		out, err := exec.Command("curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", healthURL).Output()
		if err == nil && (string(out) == "200" || string(out) == "401") {
			healthy = true
			break
		}
	}

	if !healthy {
		// Rollback
		exec.Command("incus", "exec", containerName, "--", "systemctl", "stop", "youeye-control").Run()
		exec.Command("incus", "snapshot", "restore", containerName, "pre-update").Run()
		exec.Command("incus", "exec", containerName, "--", "systemctl", "start", "youeye-control").Run()

		update.Fail("control", currentVersion, "health check failed, rolled back")
		errorResponse(w, "update failed, rolled back", http.StatusInternalServerError)
		return
	}

	update.Complete("control", currentVersion, latestVersion)

	jsonResponse(w, map[string]string{
		"status":      "success",
		"message":     fmt.Sprintf("Control Panel updated from %s to %s", currentVersion, latestVersion),
		"old_version": currentVersion,
		"new_version": latestVersion,
	})

	// Trigger infrastructure reconciliation asynchronously after responding.
	// This deploys any missing infrastructure containers (Pi-Hole, Caddy, etc.)
	// without touching existing ones. Run in a goroutine so the API response
	// returns immediately — reconciliation can take several minutes.
	go s.reconcileInfrastructure()
}

// reconcileInfrastructure calls the CP reconcile endpoint to deploy missing
// infrastructure containers. This is called asynchronously after a CP update.
func (s *Server) reconcileInfrastructure() {
	fmt.Println("[reconcile] Starting infrastructure reconciliation...")
	hostIP := util.GetPrimaryIP()

	// Read deploy secret
	secretBytes, err := os.ReadFile("/var/lib/youeye/control/.deploy_secret")
	if err != nil {
		fmt.Printf("[reconcile] Cannot read deploy secret: %v\n", err)
		return
	}
	deploySecret := strings.TrimSpace(string(secretBytes))

	body := fmt.Sprintf(`{"host_ip":"%s"}`, hostIP)
	req, err := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/api/deploy/infrastructure/reconcile", s.cfg.Deployment.ControlPanel.Port), strings.NewReader(body))
	if err != nil {
		fmt.Printf("[reconcile] Failed to create request: %v\n", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Deploy-Secret", deploySecret)

	client := &http.Client{Timeout: 30 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("[reconcile] Failed to connect to Control Panel: %v\n", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		bodyBytes := make([]byte, 1024)
		n, _ := resp.Body.Read(bodyBytes)
		fmt.Printf("[reconcile] Control Panel returned status %d: %s\n", resp.StatusCode, string(bodyBytes[:n]))
		return
	}

	// Read and log SSE stream
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		jsonStr := strings.TrimPrefix(line, "data: ")
		var event struct {
			Step       int    `json:"step"`
			TotalSteps int    `json:"totalSteps"`
			Status     string `json:"status"`
			Message    string `json:"message"`
		}
		if json.Unmarshal([]byte(jsonStr), &event) == nil {
			icon := "⏳"
			switch event.Status {
			case "success":
				icon = "✓"
			case "error":
				icon = "✗"
			case "skipped":
				icon = "→"
			}
			fmt.Printf("[reconcile]   %s [%d/%d] %s\n", icon, event.Step, event.TotalSteps, event.Message)
		}
	}

	if scanner.Err() != nil {
		fmt.Printf("[reconcile] Error reading stream: %v\n", scanner.Err())
	} else {
		fmt.Println("[reconcile] Infrastructure reconciliation complete")
	}
}

// handleUpdateApp handles updating an OCI app container by pulling the latest image
// and recreating the container with the same config.
// URL pattern: POST /api/update/app/{name}
func (s *Server) handleUpdateApp(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract app name from URL path
	appName := strings.TrimPrefix(r.URL.Path, "/api/update/app/")
	if appName == "" {
		errorResponse(w, "app name required", http.StatusBadRequest)
		return
	}

	// Map app names to container names and images
	appMap := map[string]struct {
		container string
		image     string
	}{
		"caddy":    {"youeye-caddy", "docker:caddy"},
		"pihole":   {"youeye-pihole", "docker:pihole/pihole:latest"},
		"postgres": {"youeye-postgres", "docker:postgres:17-alpine"},
	}

	appInfo, ok := appMap[appName]
	if !ok {
		errorResponse(w, fmt.Sprintf("unknown app: %s", appName), http.StatusBadRequest)
		return
	}

	containerName := appInfo.container

	// Check container exists
	out, err := exec.Command("incus", "list", containerName, "--format", "csv", "-c", "s").Output()
	if err != nil || strings.TrimSpace(string(out)) == "" {
		errorResponse(w, fmt.Sprintf("container %s not found", containerName), http.StatusNotFound)
		return
	}

	// Create snapshot before update
	exec.Command("incus", "snapshot", "delete", containerName, "pre-update").Run()
	exec.Command("incus", "snapshot", "create", containerName, "pre-update").Run()

	// Stop the container
	exec.Command("incus", "stop", containerName, "--force").Run()

	// Pull the latest image and rebuild the container
	// For simplicity, we use incus rebuild which preserves config + devices
	rebuildOut, err := exec.Command("incus", "rebuild", appInfo.image, containerName, "--force").CombinedOutput()
	if err != nil {
		// Rollback — restore snapshot
		exec.Command("incus", "snapshot", "restore", containerName, "pre-update").Run()
		exec.Command("incus", "start", containerName).Run()
		errorResponse(w, fmt.Sprintf("rebuild failed: %s", strings.TrimSpace(string(rebuildOut))), http.StatusInternalServerError)
		return
	}

	// Start the container
	startOut, err := exec.Command("incus", "start", containerName).CombinedOutput()
	if err != nil {
		exec.Command("incus", "snapshot", "restore", containerName, "pre-update").Run()
		exec.Command("incus", "start", containerName).Run()
		errorResponse(w, fmt.Sprintf("start failed after rebuild: %s", strings.TrimSpace(string(startOut))), http.StatusInternalServerError)
		return
	}

	// Wait for container to be running
	running := false
	for i := 0; i < 30; i++ {
		time.Sleep(2 * time.Second)
		checkOut, checkErr := exec.Command("incus", "list", containerName, "--format", "csv", "-c", "s").Output()
		if checkErr == nil && strings.Contains(strings.ToLower(string(checkOut)), "running") {
			running = true
			break
		}
	}

	if !running {
		exec.Command("incus", "snapshot", "restore", containerName, "pre-update").Run()
		exec.Command("incus", "start", containerName).Run()
		errorResponse(w, "container did not start after update", http.StatusInternalServerError)
		return
	}

	jsonResponse(w, map[string]string{
		"status":  "success",
		"message": fmt.Sprintf("%s updated to latest image", appName),
	})
}

// handlePostgresCredentials returns PostgreSQL connection credentials.
// Reads the password from the file saved during deployment.
func (s *Server) handlePostgresCredentials(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	passwordFile := "/var/lib/youeye/postgres/.pg_password"
	passwordBytes, err := os.ReadFile(passwordFile)
	if err != nil {
		errorResponse(w, "PostgreSQL not deployed or password not found", http.StatusNotFound)
		return
	}

	password := strings.TrimSpace(string(passwordBytes))
	if password == "" {
		errorResponse(w, "PostgreSQL password is empty", http.StatusInternalServerError)
		return
	}

	// Get container IP dynamically
	containerIP := ""
	out, err := exec.Command("incus", "list", "youeye-postgres", "--format", "csv", "-c", "4").Output()
	if err == nil {
		// Parse IP from output (format: "10.x.x.x (eth0)")
		ipLine := strings.TrimSpace(string(out))
		if idx := strings.Index(ipLine, " "); idx > 0 {
			containerIP = ipLine[:idx]
		} else if ipLine != "" {
			containerIP = ipLine
		}
	}

	if containerIP == "" {
		containerIP = "youeye-postgres" // Fallback to container name
	}

	jsonResponse(w, map[string]string{
		"host":     containerIP,
		"port":     "5432",
		"user":     "youeye",
		"password": password,
		"database": "youeye",
	})
}

// Helper functions
func verifyPAM(username, password string) bool {
	// Authenticate against HOST system PAM (not container)
	// This uses the real Linux system users/passwords
	cmd := exec.Command("pamtester", "login", username, "authenticate")
	cmd.Stdin = strings.NewReader(password + "\n")
	err := cmd.Run()
	return err == nil
}

func getUserGroups(username string) []string {
	out, err := exec.Command("id", "-Gn", username).Output()
	if err != nil {
		return []string{}
	}
	return strings.Fields(strings.TrimSpace(string(out)))
}

func getIncusVersion() string {
	out, err := exec.Command("incus", "version").Output()
	if err != nil {
		return "not installed"
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "Client version:") {
			return strings.TrimSpace(strings.TrimPrefix(line, "Client version:"))
		}
	}
	return "unknown"
}

func getControlStatus() map[string]interface{} {
	out, err := exec.Command("incus", "list", "youeye-control", "--format", "csv", "-c", "s").Output()
	if err != nil {
		return map[string]interface{}{
			"status": "not deployed",
		}
	}

	status := strings.TrimSpace(string(out))
	if status == "" {
		return map[string]interface{}{
			"status": "not deployed",
		}
	}

	result := map[string]interface{}{
		"status": strings.ToLower(status),
	}

	// Try to get version
	if strings.ToUpper(status) == "RUNNING" {
		verOut, err := exec.Command("incus", "exec", "youeye-control", "--",
			"cat", "/opt/app/package.json").Output()
		if err == nil {
			var pkg struct {
				Version string `json:"version"`
			}
			if json.Unmarshal(verOut, &pkg) == nil && pkg.Version != "" {
				result["version"] = pkg.Version
			}
		}
	}

	return result
}

func getOSRelease() string {
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return "unknown"
	}

	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), "\"")
		}
	}
	return "Linux"
}

// getLatestRelease fetches the latest release version for a repo using the shared
// releases package, respecting the configured release branch.
func (s *Server) getLatestRelease(repo, tagPrefix string) string {
	return releases.GetLatestVersionForBranch(s.cfg, repo, releases.ReadReleaseBranch(), tagPrefix)
}

// getAssetDownloadURL gets the download URL for a specific asset from a release,
// filtered by the configured release branch (with fallback to main).
func (s *Server) getAssetDownloadURL(repo, assetName, tagPrefix string) (string, error) {
	return releases.GetAssetURLForBranch(s.cfg, repo, assetName, tagPrefix)
}

// getControlVersion gets the current Control Panel version from container
func (s *Server) getControlVersion() string {
	containerName := s.cfg.Deployment.Container.Name
	appDir := s.cfg.Deployment.ControlPanel.AppDir

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

// downloadFile downloads a file from URL to local path
func downloadFile(url, filepath string) error {
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("download failed with status: %d", resp.StatusCode)
	}

	out, err := os.Create(filepath)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, resp.Body)
	return err
}

// handlePiholeCredentials handles GET/POST for Pi-Hole web interface credentials.
// GET: reads the password from the file saved during deployment.
// POST: updates the stored password file (called by Control Panel after pihole setpassword).
func (s *Server) handlePiholeCredentials(w http.ResponseWriter, r *http.Request) {
	passwordFile := "/var/lib/youeye/pihole/.web_password"

	switch r.Method {
	case "GET":
		passwordBytes, err := os.ReadFile(passwordFile)
		if err != nil {
			// Migration: try to read from container config for pre-0.1.21 deployments
			password := s.migratePiholePassword(passwordFile)
			if password != "" {
				jsonResponse(w, map[string]string{"password": password})
				return
			}
			errorResponse(w, "Pi-Hole not deployed or password not found", http.StatusNotFound)
			return
		}

		password := strings.TrimSpace(string(passwordBytes))
		if password == "" {
			errorResponse(w, "Pi-Hole password is empty", http.StatusInternalServerError)
			return
		}

		jsonResponse(w, map[string]string{
			"password": password,
		})

	case "POST":
		var req struct {
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			errorResponse(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if req.Password == "" {
			errorResponse(w, "password is required", http.StatusBadRequest)
			return
		}

		// Ensure directory exists
		if err := os.MkdirAll("/var/lib/youeye/pihole", 0700); err != nil {
			errorResponse(w, "failed to create directory", http.StatusInternalServerError)
			return
		}

		if err := os.WriteFile(passwordFile, []byte(req.Password), 0600); err != nil {
			errorResponse(w, "failed to save password", http.StatusInternalServerError)
			return
		}

		jsonResponse(w, map[string]string{
			"status": "updated",
		})

	default:
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// migratePiholePassword reads the WEBPASSWORD from the Pi-Hole container environment
// and saves it to the password file. This handles pre-0.1.21 deployments where the
// password file doesn't exist because Pi-Hole was deployed with a hardcoded password.
func (s *Server) migratePiholePassword(passwordFile string) string {
	out, err := exec.Command("incus", "config", "get", "youeye-pihole", "environment.WEBPASSWORD").Output()
	if err != nil {
		return ""
	}
	password := strings.TrimSpace(string(out))
	if password == "" {
		return ""
	}

	// Save to file for future API calls
	os.MkdirAll("/var/lib/youeye/pihole", 0700)
	if err := os.WriteFile(passwordFile, []byte(password), 0600); err != nil {
		fmt.Printf("Warning: could not save migrated pihole password: %v\n", err)
	}
	return password
}

// unused but keeping for reference
var _ = runtime.GOARCH

// handleControlSSO manages SSO environment variables for the Control Panel container.
// GET: Check if SSO is configured
// POST: Write SSO env vars, create systemd drop-in, daemon-reload, restart (delayed)
// DELETE: Remove SSO config, daemon-reload, restart (delayed)
func (s *Server) handleControlSSO(w http.ResponseWriter, r *http.Request) {
	containerName := s.cfg.Deployment.Container.Name

	switch r.Method {
	case "GET":
		out, err := exec.Command("incus", "exec", containerName, "--",
			"cat", "/etc/youeye-sso.env").CombinedOutput()
		if err != nil {
			jsonResponse(w, map[string]interface{}{
				"configured": false,
			})
			return
		}
		envVars := map[string]string{}
		for _, line := range strings.Split(string(out), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			parts := strings.SplitN(line, "=", 2)
			if len(parts) == 2 {
				envVars[parts[0]] = parts[1]
			}
		}
		jsonResponse(w, map[string]interface{}{
			"configured":             true,
			"authentik_url":          envVars["AUTHENTIK_URL"],
			"authentik_client_id":    envVars["AUTHENTIK_CLIENT_ID"],
			"authentik_internal_url": envVars["AUTHENTIK_INTERNAL_URL"],
		})

	case "POST":
		var req struct {
			AuthentikURL string `json:"authentik_url"`
			ClientID     string `json:"client_id"`
			ClientSecret string `json:"client_secret"`
			InternalURL  string `json:"internal_url"`
			ControlURL   string `json:"control_url"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			errorResponse(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if req.AuthentikURL == "" || req.ClientSecret == "" {
			errorResponse(w, "authentik_url and client_secret are required", http.StatusBadRequest)
			return
		}
		if req.ClientID == "" {
			req.ClientID = "youeye-control"
		}

		// Write env file content
		envContent := fmt.Sprintf(
			"AUTHENTIK_URL=%s\nAUTHENTIK_CLIENT_ID=%s\nAUTHENTIK_CLIENT_SECRET=%s\nAUTHENTIK_INTERNAL_URL=%s\nCONTROL_EXTERNAL_URL=%s\n",
			req.AuthentikURL, req.ClientID, req.ClientSecret, req.InternalURL, req.ControlURL,
		)

		// Save on host for persistence across container rebuilds
		hostDir := "/var/lib/youeye/control"
		os.MkdirAll(hostDir, 0700)
		hostFile := hostDir + "/.sso_env"
		if err := os.WriteFile(hostFile, []byte(envContent), 0600); err != nil {
			errorResponse(w, "failed to write env file on host", http.StatusInternalServerError)
			return
		}

		// Push env file into container
		if err := exec.Command("incus", "file", "push", hostFile,
			containerName+"/etc/youeye-sso.env").Run(); err != nil {
			errorResponse(w, "failed to push env file to container", http.StatusInternalServerError)
			return
		}

		// Create systemd drop-in directory
		exec.Command("incus", "exec", containerName, "--",
			"mkdir", "-p", "/etc/systemd/system/youeye-control.service.d").Run()

		// Write drop-in file that loads the env file
		dropinContent := "[Service]\nEnvironmentFile=/etc/youeye-sso.env\n"
		tmpDropin, _ := os.CreateTemp("", "sso-dropin-*.conf")
		tmpDropin.WriteString(dropinContent)
		tmpDropin.Close()
		defer os.Remove(tmpDropin.Name())

		if err := exec.Command("incus", "file", "push", tmpDropin.Name(),
			containerName+"/etc/systemd/system/youeye-control.service.d/sso.conf").Run(); err != nil {
			errorResponse(w, "failed to create systemd drop-in", http.StatusInternalServerError)
			return
		}

		// Daemon-reload
		exec.Command("incus", "exec", containerName, "--", "systemctl", "daemon-reload").Run()

		// Return success before restart
		jsonResponse(w, map[string]string{
			"status":  "configured",
			"message": "SSO environment configured, restarting Control Panel...",
		})

		// Restart CP after a short delay so the response can be sent
		go func() {
			time.Sleep(2 * time.Second)
			exec.Command("incus", "exec", containerName, "--", "systemctl", "restart", "youeye-control").Run()
		}()

	case "DELETE":
		// Remove SSO configuration
		exec.Command("incus", "exec", containerName, "--",
			"rm", "-f", "/etc/youeye-sso.env").Run()
		exec.Command("incus", "exec", containerName, "--",
			"rm", "-f", "/etc/systemd/system/youeye-control.service.d/sso.conf").Run()
		exec.Command("incus", "exec", containerName, "--",
			"systemctl", "daemon-reload").Run()
		os.Remove("/var/lib/youeye/control/.sso_env")

		jsonResponse(w, map[string]string{
			"status":  "removed",
			"message": "SSO configuration removed, restarting Control Panel...",
		})

		go func() {
			time.Sleep(2 * time.Second)
			exec.Command("incus", "exec", containerName, "--", "systemctl", "restart", "youeye-control").Run()
		}()

	default:
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleControlRestart restarts the Control Panel container service after a delay.
// POST /api/control/restart?delay=5 (delay in seconds, default 2, max 30)
func (s *Server) handleControlRestart(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	containerName := s.cfg.Deployment.Container.Name
	delay := 2
	if d := r.URL.Query().Get("delay"); d != "" {
		var parsed int
		if _, err := fmt.Sscanf(d, "%d", &parsed); err == nil && parsed > 0 && parsed <= 30 {
			delay = parsed
		}
	}

	jsonResponse(w, map[string]string{
		"status":  "scheduled",
		"message": fmt.Sprintf("Control Panel will restart in %d seconds", delay),
	})

	go func() {
		time.Sleep(time.Duration(delay) * time.Second)
		exec.Command("incus", "exec", containerName, "--", "systemctl", "restart", "youeye-control").Run()
	}()
}

// handleAuthentikCredentials returns Authentik credentials from host files.
func (s *Server) handleAuthentikCredentials(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	authentikDir := "/var/lib/youeye/authentik"
	readFile := func(name string) string {
		data, err := os.ReadFile(authentikDir + "/" + name)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(data))
	}

	dbPassword := readFile(".db_password")
	secretKey := readFile(".secret_key")
	bootstrapToken := readFile(".bootstrap_token")
	bootstrapPassword := readFile(".bootstrap_password")

	if dbPassword == "" && secretKey == "" {
		errorResponse(w, "Authentik not deployed or credentials not found", http.StatusNotFound)
		return
	}

	// Get Authentik container IP (use exact name match with regex anchor)
	containerIP := ""
	out, err := exec.Command("incus", "list", "^youeye-authentik$", "--format", "csv", "-c", "4").Output()
	if err == nil {
		ipLine := strings.TrimSpace(string(out))
		if idx := strings.Index(ipLine, " "); idx > 0 {
			containerIP = ipLine[:idx]
		} else if ipLine != "" {
			containerIP = ipLine
		}
	}

	jsonResponse(w, map[string]string{
		"db_password":        dbPassword,
		"secret_key":         secretKey,
		"bootstrap_token":    bootstrapToken,
		"bootstrap_password": bootstrapPassword,
		"internal_url":       fmt.Sprintf("http://%s:9000", containerIP),
	})
}

// getUIStatus returns the status of the UI container and service.
func getUIStatus(cfg *config.Config) map[string]interface{} {
	containerName := cfg.Deployment.UI.ContainerName

	out, err := exec.Command("incus", "list", "^"+containerName+"$", "--format", "csv", "-c", "s").Output()
	if err != nil || strings.TrimSpace(string(out)) == "" {
		return map[string]interface{}{
			"status":    "not-installed",
			"installed": false,
			"enabled":   false,
		}
	}

	containerStatus := strings.ToLower(strings.TrimSpace(string(out)))
	result := map[string]interface{}{
		"status":    containerStatus,
		"installed": true,
		"enabled":   false,
	}

	if containerStatus == "running" {
		// Parallel checks inside the running container
		var wg sync.WaitGroup
		var serviceActive bool
		var version, ip string
		var ssoConfigured bool

		wg.Add(4)
		go func() {
			defer wg.Done()
			svcOut, err := exec.Command("incus", "exec", containerName, "--",
				"systemctl", "is-active", "youeye-ui").Output()
			serviceActive = err == nil && strings.TrimSpace(string(svcOut)) == "active"
		}()
		go func() {
			defer wg.Done()
			verOut, err := exec.Command("incus", "exec", containerName, "--",
				"cat", cfg.Deployment.UI.AppDir+"/package.json").Output()
			if err == nil {
				var pkg struct {
					Version string `json:"version"`
				}
				if json.Unmarshal(verOut, &pkg) == nil && pkg.Version != "" {
					version = pkg.Version
				}
			}
		}()
		go func() {
			defer wg.Done()
			ipOut, err := exec.Command("incus", "list", "^"+containerName+"$", "--format", "csv", "-c", "4").Output()
			if err == nil {
				ipLine := strings.TrimSpace(string(ipOut))
				if idx := strings.Index(ipLine, " "); idx > 0 {
					ip = ipLine[:idx]
				} else if ipLine != "" {
					ip = ipLine
				}
			}
		}()
		go func() {
			defer wg.Done()
			envOut, err := exec.Command("incus", "exec", containerName, "--",
				"cat", "/etc/youeye-ui.env").CombinedOutput()
			ssoConfigured = err == nil && strings.Contains(string(envOut), "AUTHENTIK_CLIENT_ID")
		}()
		wg.Wait()

		if serviceActive {
			result["enabled"] = true
			result["status"] = "running"
		} else {
			result["status"] = "installed"
		}
		if version != "" {
			result["version"] = version
		}
		if ip != "" {
			result["ip"] = ip
		}
		if ssoConfigured {
			result["sso_configured"] = true
		}
	}

	return result
}

// getUIVersion gets the current UI version from container.
func (s *Server) getUIVersion() string {
	containerName := s.cfg.Deployment.UI.ContainerName
	appDir := s.cfg.Deployment.UI.AppDir

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

// handleUISSO manages SSO environment variables for the UI container.
// GET: Check if UI SSO is configured
// POST: Write SSO env vars, create systemd drop-in, daemon-reload, enable + start service
// DELETE: Stop service, remove SSO config
func (s *Server) handleUISSO(w http.ResponseWriter, r *http.Request) {
	containerName := s.cfg.Deployment.UI.ContainerName

	// Verify UI container exists
	out, err := exec.Command("incus", "list", "^"+containerName+"$", "--format", "csv", "-c", "s").Output()
	if err != nil || strings.TrimSpace(string(out)) == "" {
		errorResponse(w, "UI container not found. Run 'spine deploy' first.", http.StatusNotFound)
		return
	}

	switch r.Method {
	case "GET":
		envOut, err := exec.Command("incus", "exec", containerName, "--",
			"cat", "/etc/youeye-ui.env").CombinedOutput()
		if err != nil {
			jsonResponse(w, map[string]interface{}{
				"configured": false,
			})
			return
		}

		envVars := map[string]string{}
		for _, line := range strings.Split(string(envOut), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			parts := strings.SplitN(line, "=", 2)
			if len(parts) == 2 {
				envVars[parts[0]] = parts[1]
			}
		}

		// Check if it has real SSO config (not just placeholder)
		configured := envVars["AUTHENTIK_CLIENT_ID"] != ""

		serviceOut, _ := exec.Command("incus", "exec", containerName, "--",
			"systemctl", "is-active", "youeye-ui").Output()
		serviceActive := strings.TrimSpace(string(serviceOut)) == "active"

		jsonResponse(w, map[string]interface{}{
			"configured":     configured,
			"service_active": serviceActive,
			"client_id":      envVars["AUTHENTIK_CLIENT_ID"],
			"domain":         envVars["UI_EXTERNAL_URL"],
		})

	case "POST":
		var req struct {
			AuthentikURL      string `json:"authentik_url"`
			AuthentikInternal string `json:"authentik_internal_url"`
			ClientID          string `json:"client_id"`
			ClientSecret      string `json:"client_secret"`
			JWTSecret         string `json:"jwt_secret"`
			DatabaseURL       string `json:"database_url"`
			Domain            string `json:"domain"`
			BaseURL           string `json:"base_url"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			errorResponse(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if req.ClientID == "" || req.ClientSecret == "" || req.DatabaseURL == "" {
			errorResponse(w, "client_id, client_secret, and database_url are required", http.StatusBadRequest)
			return
		}

		// Build env file content
		envContent := fmt.Sprintf(`# YouEye UI Environment - configured by Control Panel
AUTHENTIK_URL=%s
AUTHENTIK_INTERNAL_URL=%s
AUTHENTIK_CLIENT_ID=%s
AUTHENTIK_CLIENT_SECRET=%s
JWT_SECRET=%s
DATABASE_URL=%s
UI_EXTERNAL_URL=%s
SECURE_COOKIES=false
NODE_ENV=production
PORT=3000
HOSTNAME=0.0.0.0
`,
			req.AuthentikURL,
			req.AuthentikInternal,
			req.ClientID,
			req.ClientSecret,
			req.JWTSecret,
			req.DatabaseURL,
			req.BaseURL,
		)

		// Save on host for persistence
		hostDir := "/var/lib/youeye/ui"
		os.MkdirAll(hostDir, 0700)
		hostFile := hostDir + "/.env"
		if err := os.WriteFile(hostFile, []byte(envContent), 0600); err != nil {
			errorResponse(w, "failed to write env file on host", http.StatusInternalServerError)
			return
		}

		// Push env file into container
		if err := exec.Command("incus", "file", "push", hostFile,
			containerName+"/etc/youeye-ui.env").Run(); err != nil {
			errorResponse(w, "failed to push env file to container", http.StatusInternalServerError)
			return
		}

		// Create database if it doesn't exist
		postgresContainer := "youeye-postgres"
		createDBOut, createDBErr := exec.Command("incus", "exec", postgresContainer, "--",
			"psql", "-U", "youeye", "-tc",
			"SELECT 1 FROM pg_database WHERE datname = 'youeye_ui'").CombinedOutput()
		if createDBErr != nil || !strings.Contains(string(createDBOut), "1") {
			fmt.Println("Creating youeye_ui database...")
			if out, err := exec.Command("incus", "exec", postgresContainer, "--",
				"psql", "-U", "youeye", "-c", "CREATE DATABASE youeye_ui OWNER youeye").CombinedOutput(); err != nil {
				fmt.Printf("Warning: failed to create youeye_ui database: %s %v\n", string(out), err)
			}
		}

		// Initialize database schema (CREATE TABLE IF NOT EXISTS)
		schemaSQL := `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  authentik_id TEXT UNIQUE,
  username TEXT UNIQUE,
  name TEXT,
  email TEXT UNIQUE,
  image TEXT,
  is_admin BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS widgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT,
  widget_type TEXT NOT NULL,
  position_x REAL NOT NULL DEFAULT 50,
  position_y REAL NOT NULL DEFAULT 50,
  width REAL NOT NULL DEFAULT 30,
  height REAL NOT NULL DEFAULT 10,
  settings JSONB DEFAULT '{}',
  "order" INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT,
  container_url TEXT,
  subdomain TEXT,
  icon TEXT,
  enabled BOOLEAN DEFAULT TRUE,
  status TEXT DEFAULT 'unknown',
  manifest JSONB DEFAULT '{}',
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS user_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  settings JSONB DEFAULT '{}',
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value JSONB,
  updated_at TIMESTAMP DEFAULT NOW()
);`
		// Write schema SQL to temp file, push to postgres container, execute
		schemaTmp := "/tmp/ye-ui-schema.sql"
		if err := os.WriteFile(schemaTmp, []byte(schemaSQL), 0644); err == nil {
			postgresContainer := "youeye-postgres"
			exec.Command("incus", "file", "push", schemaTmp, postgresContainer+"/tmp/ye-ui-schema.sql").Run()
			exec.Command("incus", "exec", postgresContainer, "--",
				"psql", "-U", "youeye", "-d", "youeye_ui", "-f", "/tmp/ye-ui-schema.sql").Run()
			os.Remove(schemaTmp)
		}

		// Enable and start the service
		exec.Command("incus", "exec", containerName, "--", "systemctl", "daemon-reload").Run()
		exec.Command("incus", "exec", containerName, "--", "systemctl", "enable", "youeye-ui").Run()

		// Restart service so new EnvironmentFile is picked up
		if err := exec.Command("incus", "exec", containerName, "--",
			"systemctl", "restart", "youeye-ui").Run(); err != nil {
			errorResponse(w, "failed to start UI service", http.StatusInternalServerError)
			return
		}

		// Health check — max 10 iterations x 2s = 20s
		healthy := false
		port := s.cfg.Deployment.UI.Port
		for i := 0; i < 10; i++ {
			time.Sleep(2 * time.Second)
			healthOut, err := exec.Command("incus", "exec", containerName, "--",
				"curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
				fmt.Sprintf("http://localhost:%d/api/health", port)).Output()
			if err == nil && string(healthOut) == "200" {
				healthy = true
				break
			}
		}

		if !healthy {
			// Don't stop the service — it might just need more time
			jsonResponse(w, map[string]string{
				"status":  "configured",
				"message": "UI SSO configured and service started (health check pending)",
				"warning": "health check did not pass yet — service may still be starting",
			})
			return
		}

		jsonResponse(w, map[string]string{
			"status":  "configured",
			"message": "UI SSO configured and service is running",
		})

	case "DELETE":
		// Stop and disable service
		exec.Command("incus", "exec", containerName, "--", "systemctl", "stop", "youeye-ui").Run()
		exec.Command("incus", "exec", containerName, "--", "systemctl", "disable", "youeye-ui").Run()

		// Write back placeholder env file
		placeholderContent := "# YouEye UI Environment - configured by Control Panel\n# This file is populated when UI is enabled via Control Panel\n"
		tmpFile, _ := os.CreateTemp("", "youeye-ui-env-*")
		tmpFile.WriteString(placeholderContent)
		tmpFile.Close()
		defer os.Remove(tmpFile.Name())

		exec.Command("incus", "file", "push", tmpFile.Name(),
			containerName+"/etc/youeye-ui.env").Run()

		// Remove host copy
		os.Remove("/var/lib/youeye/ui/.env")

		jsonResponse(w, map[string]string{
			"status":  "disabled",
			"message": "UI service stopped and SSO configuration removed",
		})

	default:
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// YouEyeConfig represents the site-level configuration stored in youeye.yaml
type YouEyeConfig struct {
	SiteName       string            `yaml:"site_name" json:"site_name"`
	Domain         string            `yaml:"domain" json:"domain"`
	Subdomains     map[string]string `yaml:"subdomains" json:"subdomains"`
	SetupCompleted bool              `yaml:"setup_completed" json:"setup_completed"`
	ReleaseBranch  string            `yaml:"release_branch,omitempty" json:"release_branch"`
	Language       string            `yaml:"language,omitempty" json:"language"`
}

var youeyeConfigPath = "/var/lib/youeye/config/youeye.yaml"

// loadYouEyeConfig reads the youeye.yaml config file
func loadYouEyeConfig() (*YouEyeConfig, error) {
	cfg := &YouEyeConfig{
		SiteName: "YouEye",
		Subdomains: map[string]string{
			"control": "control",
			"auth":    "auth",
			"dns":     "dns",
		},
	}

	data, err := os.ReadFile(youeyeConfigPath)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil // Return defaults if file doesn't exist
		}
		return nil, fmt.Errorf("failed to read config: %w", err)
	}

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("failed to parse config: %w", err)
	}

	return cfg, nil
}

// saveYouEyeConfig writes the youeye.yaml config file
func saveYouEyeConfig(cfg *YouEyeConfig) error {
	if err := os.MkdirAll("/var/lib/youeye/config", 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	header := "# YouEye Configuration\n# Managed by Spine API - do not edit manually unless you know what you're doing\n\n"
	if err := os.WriteFile(youeyeConfigPath, []byte(header+string(data)), 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	return nil
}

// handleYouEyeConfig handles GET/PUT/PATCH for the site-level youeye.yaml config
func (s *Server) handleYouEyeConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		cfg, err := loadYouEyeConfig()
		if err != nil {
			errorResponse(w, err.Error(), http.StatusInternalServerError)
			return
		}
		jsonResponse(w, cfg)

	case "PUT":
		var newCfg YouEyeConfig
		if err := json.NewDecoder(r.Body).Decode(&newCfg); err != nil {
			errorResponse(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if newCfg.SiteName == "" {
			newCfg.SiteName = "YouEye"
		}
		if newCfg.Subdomains == nil {
			newCfg.Subdomains = map[string]string{
				"control": "control",
				"auth":    "auth",
				"dns":     "dns",
			}
		}
		if err := saveYouEyeConfig(&newCfg); err != nil {
			errorResponse(w, err.Error(), http.StatusInternalServerError)
			return
		}
		jsonResponse(w, map[string]interface{}{
			"status": "saved",
			"config": newCfg,
		})

	case "PATCH":
		existing, err := loadYouEyeConfig()
		if err != nil {
			errorResponse(w, err.Error(), http.StatusInternalServerError)
			return
		}

		var patch map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
			errorResponse(w, "invalid request body", http.StatusBadRequest)
			return
		}

		if v, ok := patch["site_name"].(string); ok && v != "" {
			existing.SiteName = v
		}
		if v, ok := patch["domain"].(string); ok {
			existing.Domain = v
		}
		if v, ok := patch["setup_completed"].(bool); ok {
			existing.SetupCompleted = v
		}
		if v, ok := patch["subdomains"].(map[string]interface{}); ok {
			for key, val := range v {
				if s, ok := val.(string); ok {
					existing.Subdomains[key] = s
				}
			}
		}
		if v, ok := patch["release_branch"].(string); ok {
			existing.ReleaseBranch = v
		}
		if v, ok := patch["language"].(string); ok {
			existing.Language = v
		}

		if err := saveYouEyeConfig(existing); err != nil {
			errorResponse(w, err.Error(), http.StatusInternalServerError)
			return
		}
		jsonResponse(w, map[string]interface{}{
			"status": "updated",
			"config": existing,
		})

	default:
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleRegistryDigest fetches the manifest digest for an OCI image tag from
// Docker Hub or GHCR using anonymous authentication. The Control Panel container
// has no outbound internet access, so it calls this endpoint on Spine (which
// runs on the host with full connectivity).
//
// GET /api/registry/digest?image=docker.io/library/caddy&tag=latest
// Returns: { "digest": "sha256:abc...", "image": "docker.io/library/caddy", "tag": "latest" }
func (s *Server) handleRegistryDigest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	image := r.URL.Query().Get("image")
	tag := r.URL.Query().Get("tag")
	if image == "" {
		errorResponse(w, "image parameter is required", http.StatusBadRequest)
		return
	}
	if tag == "" {
		tag = "latest"
	}

	// Strip tag from image if accidentally included (e.g. "docker.io/library/caddy:latest")
	if idx := strings.LastIndex(image, ":"); idx > strings.LastIndex(image, "/") {
		tag = image[idx+1:]
		image = image[:idx]
	}

	registry, namespace := parseImageRef(image)

	// Get anonymous pull token
	token, err := getRegistryToken(registry, namespace)
	if err != nil {
		errorResponse(w, fmt.Sprintf("failed to get registry token: %v", err), http.StatusBadGateway)
		return
	}

	// HEAD the manifest to get digest
	digest, err := getManifestDigest(registry, namespace, tag, token)
	if err != nil {
		errorResponse(w, fmt.Sprintf("failed to get manifest digest: %v", err), http.StatusBadGateway)
		return
	}

	jsonResponse(w, map[string]string{
		"digest": digest,
		"image":  image,
		"tag":    tag,
	})
}

// parseImageRef splits an image reference into registry host and namespace/name.
//
//	"postgres"                      → ("docker.io", "library/postgres")
//	"pihole/pihole"                 → ("docker.io", "pihole/pihole")
//	"docker.io/library/caddy"       → ("docker.io", "library/caddy")
//	"ghcr.io/goauthentik/server"    → ("ghcr.io",   "goauthentik/server")
func parseImageRef(image string) (registry, namespace string) {
	parts := strings.SplitN(image, "/", 2)
	if len(parts) < 2 {
		// Single name like "postgres" → Docker Hub official
		return "docker.io", "library/" + image
	}
	// If the first part contains a dot or colon, it's a registry host.
	// Otherwise it's a Docker Hub namespace (e.g. "pihole/pihole").
	if strings.ContainsAny(parts[0], ".:") {
		return parts[0], parts[1]
	}
	return "docker.io", image
}

// getRegistryToken obtains an anonymous bearer token for pulling from the given registry.
func getRegistryToken(registry, namespace string) (string, error) {
	var tokenURL string

	switch registry {
	case "docker.io", "registry-1.docker.io":
		tokenURL = fmt.Sprintf(
			"https://auth.docker.io/token?service=registry.docker.io&scope=repository:%s:pull",
			url.QueryEscape(namespace),
		)
	case "ghcr.io":
		tokenURL = fmt.Sprintf(
			"https://ghcr.io/token?scope=repository:%s:pull",
			url.QueryEscape(namespace),
		)
	default:
		tokenURL = fmt.Sprintf(
			"https://%s/token?scope=repository:%s:pull",
			registry, url.QueryEscape(namespace),
		)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, tokenURL, nil)
	if err != nil {
		return "", fmt.Errorf("create token request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch token: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("token endpoint returned %d: %s", resp.StatusCode, string(body))
	}

	var tokenResp struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return "", fmt.Errorf("decode token response: %w", err)
	}

	token := tokenResp.Token
	if token == "" {
		token = tokenResp.AccessToken
	}
	return token, nil
}

// getManifestDigest sends a HEAD request to the registry manifest endpoint and
// returns the Docker-Content-Digest header value.
func getManifestDigest(registry, namespace, tag, token string) (string, error) {
	registryHost := registry
	if registry == "docker.io" {
		registryHost = "registry-1.docker.io"
	}

	manifestURL := fmt.Sprintf("https://%s/v2/%s/manifests/%s", registryHost, namespace, tag)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodHead, manifestURL, nil)
	if err != nil {
		return "", fmt.Errorf("create manifest request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", strings.Join([]string{
		"application/vnd.docker.distribution.manifest.v2+json",
		"application/vnd.oci.image.manifest.v1+json",
		"application/vnd.docker.distribution.manifest.list.v2+json",
		"application/vnd.oci.image.index.v1+json",
	}, ", "))

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("head manifest: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("manifest HEAD returned %d: %s", resp.StatusCode, string(body))
	}

	digest := resp.Header.Get("Docker-Content-Digest")
	if digest == "" {
		return "", fmt.Errorf("no Docker-Content-Digest header in response")
	}

	return digest, nil
}

// handleBackupRun starts a backup operation in the background.
// POST /api/backup/run
func (s *Server) handleBackupRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var cfg backup.BackupConfig
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		errorResponse(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if cfg.TargetPath == "" {
		errorResponse(w, "target_path is required", http.StatusBadRequest)
		return
	}
	if cfg.Passphrase == "" {
		errorResponse(w, "passphrase is required", http.StatusBadRequest)
		return
	}
	if cfg.StagingDir == "" {
		errorResponse(w, "staging_dir is required", http.StatusBadRequest)
		return
	}

	backupID, err := backup.Run(cfg)
	if err != nil {
		errorResponse(w, fmt.Sprintf("Failed to start backup: %v", err), http.StatusInternalServerError)
		return
	}

	jsonResponse(w, map[string]string{
		"status":    "started",
		"backup_id": backupID,
	})
}

// handleBackupStatus returns the current backup status from the status file.
// GET /api/backup/status
func (s *Server) handleBackupStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	jsonResponse(w, backup.ReadStatus())
}

// handleBackupVolumes runs a live volume backup (freeze/snapshot instead of stop).
// POST /api/backup/volumes
func (s *Server) handleBackupVolumes(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var cfg backup.BackupConfig
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		errorResponse(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if cfg.TargetPath == "" {
		errorResponse(w, "target_path is required", http.StatusBadRequest)
		return
	}
	if cfg.Passphrase == "" {
		errorResponse(w, "passphrase is required", http.StatusBadRequest)
		return
	}
	if cfg.StagingDir == "" {
		errorResponse(w, "staging_dir is required", http.StatusBadRequest)
		return
	}

	// Force live mode for this endpoint
	cfg.Mode = "live"

	backupID, err := backup.Run(cfg)
	if err != nil {
		errorResponse(w, fmt.Sprintf("Failed to start live backup: %v", err), http.StatusInternalServerError)
		return
	}

	jsonResponse(w, map[string]string{
		"status":    "started",
		"backup_id": backupID,
		"mode":      "live",
	})
}

// handleStorageDriver returns the detected Incus storage driver.
// GET /api/backup/storage-driver
func (s *Server) handleStorageDriver(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	driver := backup.DetectStorageDriver()
	jsonResponse(w, map[string]string{
		"driver": driver,
	})
}

// handleBackupList returns backup entries from the index.
// GET /api/backup/list?type=core&app_id=immich&target_path=/mnt/backup
func (s *Server) handleBackupList(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	targetPath := r.URL.Query().Get("target_path")
	if targetPath == "" {
		errorResponse(w, "target_path query param required", http.StatusBadRequest)
		return
	}

	backupType := r.URL.Query().Get("type")
	appID := r.URL.Query().Get("app_id")

	entries, err := backup.ListEntries(targetPath, backupType, appID)
	if err != nil {
		errorResponse(w, fmt.Sprintf("Failed to list backups: %v", err), http.StatusInternalServerError)
		return
	}

	jsonResponse(w, map[string]interface{}{
		"entries": entries,
		"type":    backupType,
		"app_id":  appID,
	})
}

// handleBackupConfig handles GET/POST for backup schedule configuration.
// GET /api/backup/config — read current backup schedule
// POST /api/backup/config — update backup schedule
func (s *Server) handleBackupConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		cfg, err := backup.ReadBackupConfig()
		if err != nil {
			errorResponse(w, fmt.Sprintf("Failed to read backup config: %v", err), http.StatusInternalServerError)
			return
		}
		if cfg == nil {
			jsonResponse(w, map[string]interface{}{
				"enabled": false,
			})
			return
		}
		jsonResponse(w, cfg)

	case "POST":
		var cfg backup.ScheduleConfig
		if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
			errorResponse(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if err := backup.SaveBackupConfig(&cfg); err != nil {
			errorResponse(w, fmt.Sprintf("Failed to save backup config: %v", err), http.StatusInternalServerError)
			return
		}
		jsonResponse(w, map[string]string{
			"status": "saved",
		})

	default:
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleBackupRestore decrypts and extracts a backup archive.
// POST /api/backup/restore
func (s *Server) handleBackupRestore(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var cfg backup.RestoreConfig
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		errorResponse(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if cfg.ArchivePath == "" {
		errorResponse(w, "archive_path is required", http.StatusBadRequest)
		return
	}
	if cfg.Passphrase == "" {
		errorResponse(w, "passphrase is required", http.StatusBadRequest)
		return
	}
	if cfg.StagingDir == "" {
		errorResponse(w, "staging_dir is required", http.StatusBadRequest)
		return
	}

	result, err := backup.RestoreArchive(cfg)
	if err != nil {
		errorResponse(w, fmt.Sprintf("Restore failed: %v", err), http.StatusInternalServerError)
		return
	}

	jsonResponse(w, result)
}

// handleBackupPrune runs retention cleanup for backup entries.
// POST /api/backup/prune
func (s *Server) handleBackupPrune(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		TargetPath string `json:"target_path"`
		BackupType string `json:"backup_type"`
		AppID      string `json:"app_id"`
		Retention  int    `json:"retention"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errorResponse(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.TargetPath == "" {
		errorResponse(w, "target_path is required", http.StatusBadRequest)
		return
	}
	if req.Retention <= 0 {
		errorResponse(w, "retention must be > 0", http.StatusBadRequest)
		return
	}

	if err := backup.PruneEntries(req.TargetPath, req.BackupType, req.AppID, req.Retention); err != nil {
		errorResponse(w, fmt.Sprintf("Prune failed: %v", err), http.StatusInternalServerError)
		return
	}

	jsonResponse(w, map[string]string{
		"status": "pruned",
	})
}
