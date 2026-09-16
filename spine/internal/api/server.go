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
	"path/filepath"

	"strings"
	"sync"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/backup"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/container"
	"github.com/youeye-platform/YouEye/spine/internal/developmentaccess"
	"github.com/youeye-platform/YouEye/spine/internal/networkstatus"
	"github.com/youeye-platform/YouEye/spine/internal/releases"
	"github.com/youeye-platform/YouEye/spine/internal/remoteaccess"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
	"github.com/youeye-platform/YouEye/spine/internal/update"
	"github.com/youeye-platform/YouEye/spine/internal/util"
	"github.com/youeye-platform/YouEye/spine/internal/version"
	"golang.org/x/sys/unix"
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
	version           string
	socketPath        string
	mux               *http.ServeMux
	cfg               *config.Config
	authLimiter       *authRateLimiter
	runtimeDetect     func() (appliance.RuntimeStatus, *appliance.Manifest, error)
	systemUpdate      systemUpdateService
	remoteAccess      remoteAccessService
	developmentAccess developmentAccessService
	networkStatus     networkStatusService
	releaseHTTP       *http.Client

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
		version:           version,
		socketPath:        cfg.API.SocketPath,
		mux:               http.NewServeMux(),
		cfg:               cfg,
		authLimiter:       newAuthRateLimiter(cfg),
		runtimeDetect:     appliance.Detect,
		systemUpdate:      systemupdate.NewDefault(),
		remoteAccess:      remoteaccess.NewDefault(),
		developmentAccess: developmentaccess.NewDefault(),
		networkStatus:     networkstatus.NewDefault(),
		releaseHTTP:       systemupdate.ReleaseHTTPClient(),
	}
	s.setupRoutes()
	return s
}

type socketOwnership struct {
	file *os.File
}

func acquireSocketOwnership(socketPath string) (*socketOwnership, error) {
	lockPath := socketPath + ".lock"
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("open API socket ownership lock: %w", err)
	}
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		file.Close()
		return nil, fmt.Errorf("API socket ownership is already held for %s", socketPath)
	}
	return &socketOwnership{file: file}, nil
}

func (o *socketOwnership) Close() error {
	if o == nil || o.file == nil {
		return nil
	}
	_ = unix.Flock(int(o.file.Fd()), unix.LOCK_UN)
	return o.file.Close()
}

func prepareSocketPath(socketPath string) error {
	ownership, err := acquireSocketOwnership(socketPath)
	if err != nil {
		return err
	}
	defer ownership.Close()
	return prepareSocketPathOwned(socketPath)
}

func prepareSocketPathOwned(socketPath string) error {
	before, err := os.Lstat(socketPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect API socket: %w", err)
	}
	if before.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("refusing to remove non-socket API path %s", socketPath)
	}
	conn, err := net.DialTimeout("unix", socketPath, 100*time.Millisecond)
	if err == nil {
		conn.Close()
		return fmt.Errorf("API socket is already served at %s", socketPath)
	}
	after, err := os.Lstat(socketPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("reinspect stale API socket: %w", err)
	}
	if after.Mode()&os.ModeSocket == 0 || !os.SameFile(before, after) {
		return fmt.Errorf("API socket path changed during stale-socket verification")
	}
	if err := os.Remove(socketPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove stale API socket: %w", err)
	}
	return nil
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
	s.mux.HandleFunc("/api/control/sso", s.handleControlSSO)
	s.mux.HandleFunc("/api/control/restart", s.handleControlRestart)
	s.mux.HandleFunc("/api/ui/sso", s.handleUISSO)
	// UI updates are handled by the Control Panel directly (lxd-updater), not Spine
	s.mux.HandleFunc("/api/config", s.handleYouEyeConfig)
	s.mux.HandleFunc("/api/update/status", s.handleUpdateStatus)
	s.mux.HandleFunc("/api/appliance/system-update/status", s.handleSystemUpdateStatus)
	s.mux.HandleFunc("/api/appliance/system-update/check", s.handleSystemUpdateCheck)
	s.mux.HandleFunc("/api/appliance/system-update/stage", s.handleSystemUpdateStage)
	s.mux.HandleFunc("/api/appliance/system-update/activate", s.handleSystemUpdateActivate)
	s.mux.HandleFunc("/api/appliance/remote-access/keys", s.handleRemoteAccessKeys)
	s.mux.HandleFunc("/api/appliance/remote-access/keys/", s.handleRemoteAccessKey)
	s.mux.HandleFunc("/api/appliance/development-access", s.handleDevelopmentAccess)
	s.mux.HandleFunc("/api/appliance/network", s.handleNetworkStatus)
	s.mux.HandleFunc("/api/registry/digest", s.handleRegistryDigest)
	s.mux.HandleFunc("/api/backup/run", s.handleBackupRun)
	s.mux.HandleFunc("/api/backup/status", s.handleBackupStatus)
	s.mux.HandleFunc("/api/backup/storage-driver", s.handleStorageDriver)
	s.mux.HandleFunc("/api/backup/config", s.handleBackupConfig)
	s.mux.HandleFunc("/api/backup/restore", s.handleBackupRestore)
	s.mux.HandleFunc("/api/backup/apply-volumes", s.handleBackupApplyVolumes)
	s.mux.HandleFunc("/api/backup/incus/prepare", s.handleBackupIncusPrepare)
	s.mux.HandleFunc("/api/backup/incus/import-instance", s.handleBackupIncusImportInstance)
	s.mux.HandleFunc("/api/backup/media", s.handleBackupMedia)
	s.mux.HandleFunc("/api/backup/media/prepare", s.handleBackupMediaPrepare)
	s.mux.HandleFunc("/api/backup/media/eject", s.handleBackupMediaEject)
	s.mux.HandleFunc("/api/backup/repository/store", s.handleBackupRepositoryStore)
	s.mux.HandleFunc("/api/backup/repository/import", s.handleBackupRepositoryImport)
	s.mux.HandleFunc("/api/backup/repository/catalog", s.handleBackupRepositoryCatalog)
	s.mux.HandleFunc("/api/backup/recovery-key", s.handleBackupRecoveryKey)
	s.mux.HandleFunc("/api/metrics", s.handleMetrics)
}

func (s *Server) ListenAndServe() error {
	ownership, err := acquireSocketOwnership(s.socketPath)
	if err != nil {
		return err
	}
	defer ownership.Close()
	if err := prepareSocketPathOwned(s.socketPath); err != nil {
		return err
	}

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

	fmt.Printf("API server listening on %s\n", s.socketPath)

	return http.Serve(listener, s.mux)
}

// Response helpers
func jsonResponse(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func jsonStatusResponse(w http.ResponseWriter, data interface{}, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func errorResponse(w http.ResponseWriter, message string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func (s *Server) runtimeCapabilityGuard(w http.ResponseWriter, action string) bool {
	status, _, detectErr := s.runtimeDetect()
	if detectErr != nil {
		jsonStatusResponse(w, map[string]interface{}{
			"code": "appliance_recovery_required", "message": "sealed appliance marker is invalid; boot recovery",
			"runtime": status,
		}, http.StatusServiceUnavailable)
		return false
	}
	if err := appliance.RequireCapability(status, action); err != nil {
		if capabilityErr, ok := err.(*appliance.CapabilityError); ok {
			jsonStatusResponse(w, capabilityErr, http.StatusConflict)
		} else {
			errorResponse(w, err.Error(), http.StatusConflict)
		}
		return false
	}
	return true
}

// Handlers
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	status, _, err := s.runtimeDetect()
	if err != nil {
		jsonStatusResponse(w, map[string]interface{}{"status": "recovery-required", "code": "appliance_recovery_required", "runtime": status}, http.StatusServiceUnavailable)
		return
	}
	jsonResponse(w, map[string]interface{}{"status": "ok", "runtime": status.Kind})
}

func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	jsonResponse(w, map[string]string{
		"version": s.version,
		"service": "youeye",
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

	runtimeStatus, manifest, runtimeErr := s.runtimeDetect()
	status := map[string]interface{}{
		"spine":         map[string]string{"version": s.version},
		"incus":         map[string]string{"version": incusVer},
		"control_panel": controlSt,
		"ui":            uiSt,
		"host":          map[string]string{"os": osRel},
		"runtime":       runtimeStatus,
	}
	if runtimeStatus.Kind == appliance.RuntimeApplianceImage && manifest != nil {
		persistent, err := appliance.InspectPersistentStatus(*manifest)
		status["persistent_state"] = persistent
		if err != nil {
			status["runtime_warning"] = persistent.ErrorCode
		}
	}
	if runtimeErr != nil {
		status["runtime_warning"] = "appliance_recovery_required"
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

	runtimeStatus, _, runtimeErr := s.runtimeDetect()
	if runtimeErr != nil {
		jsonStatusResponse(w, map[string]interface{}{"code": "appliance_recovery_required", "runtime": runtimeStatus}, http.StatusServiceUnavailable)
		return
	}

	// Parallel version + release checks
	var wg sync.WaitGroup
	var controlVer, uiVer string
	var spineLatestRel, controlLatestRel, uiLatestRel string

	wg.Add(4)
	go func() { defer wg.Done(); controlVer = s.getControlVersion() }()
	go func() { defer wg.Done(); uiVer = s.getUIVersion() }()
	if runtimeStatus.Capabilities.SpineUpdate {
		wg.Add(1)
		go func() {
			defer wg.Done()
			spineLatestRel = s.getLatestRelease(s.cfg.Releases.Repositories.Spine, s.cfg.Releases.Repositories.SpineTagPrefix)
		}()
	}
	go func() {
		defer wg.Done()
		controlLatestRel = s.getLatestRelease(s.cfg.Releases.Repositories.ControlPanel, s.cfg.Releases.Repositories.ControlPanelTagPrefix)
	}()
	go func() {
		defer wg.Done()
		uiLatestRel = s.getLatestRelease(s.cfg.Releases.Repositories.UI, s.cfg.Releases.Repositories.UITagPrefix)
	}()
	wg.Wait()

	updates := map[string]interface{}{
		"checked_at": time.Now().UTC().Format(time.RFC3339),
		"runtime":    runtimeStatus,
		"spine": map[string]interface{}{
			"current":   s.version,
			"latest":    spineLatestRel,
			"available": false,
			"supported": runtimeStatus.Capabilities.SpineUpdate,
		},
		"control": map[string]interface{}{
			"current":   controlVer,
			"latest":    controlLatestRel,
			"available": false,
			"supported": runtimeStatus.Capabilities.ControlUpdate,
		},
		"ui": map[string]interface{}{
			"current":   uiVer,
			"latest":    uiLatestRel,
			"available": false,
			"supported": runtimeStatus.Capabilities.UIUpdate,
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

	// Channel-aware enrichment (keeps the legacy current/latest/available keys
	// above for old Control Panels). Each entry gains channel + installed +
	// candidate detail and switch_pending.
	if runtimeStatus.Capabilities.SpineUpdate {
		s.resolveComponentUpdate(channels.ComponentSpine, s.cfg.Releases.Repositories.Spine, s.cfg.Releases.Repositories.SpineTagPrefix, s.version).merge(spineUpdate)
	} else {
		spineUpdate["managed_by"] = "system-image"
	}
	s.resolveComponentUpdate(channels.ComponentControl, s.cfg.Releases.Repositories.ControlPanel, s.cfg.Releases.Repositories.ControlPanelTagPrefix, controlVer).merge(controlUpdate)
	s.resolveComponentUpdate(channels.ComponentUI, s.cfg.Releases.Repositories.UI, s.cfg.Releases.Repositories.UITagPrefix, uiVer).merge(uiUpdate)

	// Single apt call for both incus upgrade check and system count
	aptLines := ""
	if runtimeStatus.Capabilities.IncusUpdate || runtimeStatus.Capabilities.SystemUpdate {
		aptOutput, _ := exec.Command("apt", "list", "--upgradeable").CombinedOutput()
		aptLines = string(aptOutput)
	}
	incusUpgradeable := strings.Contains(aptLines, "incus/")
	upgradeableCount := 0
	for _, line := range strings.Split(strings.TrimSpace(aptLines), "\n") {
		if strings.Contains(line, "/") && !strings.HasPrefix(line, "Listing") {
			upgradeableCount++
		}
	}

	updates["incus"] = map[string]interface{}{
		"current":    getIncusVersion(),
		"available":  incusUpgradeable,
		"supported":  runtimeStatus.Capabilities.IncusUpdate,
		"managed_by": map[bool]string{true: "package-manager", false: "system-image"}[runtimeStatus.Capabilities.IncusUpdate],
	}
	if runtimeStatus.Kind == appliance.RuntimeApplianceImage {
		imageStatus, imageErr := s.systemUpdate.Status()
		system := map[string]interface{}{
			"current": runtimeStatus.ImageVersion, "available": imageStatus.State == systemupdate.PhaseAvailable,
			"supported": runtimeStatus.Capabilities.ImageUpdate, "managed_by": "system-image", "transaction": imageStatus,
		}
		if imageErr != nil {
			system["error"] = imageErr.Error()
		}
		updates["system"] = system
	} else {
		updates["system"] = map[string]interface{}{
			"current": getOSRelease(), "upgradeable_count": upgradeableCount,
			"available": upgradeableCount > 0, "supported": runtimeStatus.Capabilities.SystemUpdate,
			"managed_by": "package-manager",
		}
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
	}

	for _, a := range ociApps {
		status := getAppContainerStatus(a.container)
		// Extract image tag from the image reference
		imageTag := "latest"
		if idx := strings.LastIndex(a.image, ":"); idx > strings.LastIndex(a.image, "/") {
			imageTag = a.image[idx+1:]
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
	if !s.runtimeCapabilityGuard(w, appliance.ActionSpineUpdate) {
		return
	}

	confirmSwitch := readConfirmSwitch(r)

	// If resolution shows a channel switch and the caller did not confirm, refuse
	// with 409 so the Control Panel can prompt.
	if switchErr := s.channelSwitchGuard(channels.ComponentSpine, s.cfg.Releases.Repositories.Spine, s.cfg.Releases.Repositories.SpineTagPrefix, s.version, confirmSwitch); switchErr != nil {
		errorResponse(w, switchErr.Error(), http.StatusConflict)
		return
	}

	// Write initial status before starting background update
	update.Start("spine", s.version)

	// Run update in background — the CLI now writes status to disk at each stage.
	// -y is passed so the CLI does not block on its own confirmation prompt; the
	// switch guard above already enforced explicit confirmation.
	go func() {
		cmd := exec.Command("youeye", "update", "self", "-y")
		cmd.Run()
	}()

	jsonResponse(w, map[string]string{
		"status":  "started",
		"message": "Spine update initiated",
	})
}

// readConfirmSwitch parses an optional {"confirm_switch": true} body.
func readConfirmSwitch(r *http.Request) bool {
	if r.Body == nil {
		return false
	}
	var body struct {
		ConfirmSwitch bool `json:"confirm_switch"`
	}
	// Ignore decode errors — an empty/absent body means "not confirmed".
	_ = json.NewDecoder(r.Body).Decode(&body)
	return body.ConfirmSwitch
}

// channelSwitchGuard returns a descriptive error when the resolved candidate for
// a component is a channel switch (different branch than installed) and the
// caller has not confirmed it. Returns nil when it is a normal same-branch
// update, when the candidate is newer on the new branch (surfaced as an update),
// or when confirmSwitch is true.
func (s *Server) channelSwitchGuard(component, repo, tagPrefix, currentVersion string, confirmSwitch bool) error {
	if confirmSwitch {
		return nil
	}
	cand, err := releases.ResolveComponent(s.cfg, component, repo, tagPrefix)
	if err != nil {
		return nil // resolution failure is handled by the update path itself
	}
	installedBranch := ""
	if prov, ok := update.GetProvenance(component); ok {
		installedBranch = prov.Branch
	}
	if installedBranch == "" || installedBranch == cand.Branch {
		return nil // same branch — normal update rules apply
	}
	if version.IsNewer(cand.Version, currentVersion) {
		return nil // newer on the new branch — surfaces as a normal update
	}
	return fmt.Errorf("channel switch requires confirmation: %s %s → %s %s (set confirm_switch=true)",
		installedBranch, version.FormatVersion(currentVersion),
		cand.Branch, version.FormatVersion(cand.Version))
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
	if !s.runtimeCapabilityGuard(w, appliance.ActionIncusUpdate) {
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
	if !s.runtimeCapabilityGuard(w, appliance.ActionSystemUpdate) {
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
	if !s.runtimeCapabilityGuard(w, appliance.ActionControlUpdate) {
		return
	}

	confirmSwitch := readConfirmSwitch(r)

	containerName := s.cfg.Deployment.Container.Name
	port := s.cfg.Deployment.ControlPanel.Port
	appDir := s.cfg.Deployment.ControlPanel.AppDir

	// Get current and latest versions
	currentVersion := s.getControlVersion()

	// Refuse an unconfirmed channel switch before doing any work.
	if switchErr := s.channelSwitchGuard(channels.ComponentControl, s.cfg.Releases.Repositories.ControlPanel, s.cfg.Releases.Repositories.ControlPanelTagPrefix, currentVersion, confirmSwitch); switchErr != nil {
		errorResponse(w, switchErr.Error(), http.StatusConflict)
		return
	}

	// Resolve the candidate through the control channel (may differ from
	// getLatestRelease when a per-component source/branch is set).
	cpCand, cpErr := releases.ResolveComponent(s.cfg, channels.ComponentControl, s.cfg.Releases.Repositories.ControlPanel, s.cfg.Releases.Repositories.ControlPanelTagPrefix)
	latestVersion := ""
	if cpErr == nil {
		latestVersion = cpCand.Version
	} else {
		latestVersion = s.getLatestRelease(s.cfg.Releases.Repositories.ControlPanel, s.cfg.Releases.Repositories.ControlPanelTagPrefix)
	}

	if latestVersion == "" || latestVersion == "unknown" {
		errorResponse(w, "could not determine latest version", http.StatusInternalServerError)
		return
	}

	if currentVersion == latestVersion {
		if err := s.ensureControlIdentityService(containerName, appDir); err != nil {
			errorResponse(w, fmt.Sprintf("Control Panel is up to date, but identity provider service repair failed: %v", err), http.StatusInternalServerError)
			return
		}
		update.NoOp("control", currentVersion)
		jsonResponse(w, map[string]string{
			"status":  "up-to-date",
			"message": fmt.Sprintf("Control Panel is already at version %s", currentVersion),
		})
		return
	}

	update.Start("control", currentVersion)
	update.Emit("control", update.StatusDownloading, 10, "Creating snapshot...")

	// A verified rollback point is mandatory before any service or file mutation.
	if err := prepareIncusSnapshot(containerName, "pre-update", runIncusCommand); err != nil {
		update.Fail("control", currentVersion, err.Error())
		errorResponse(w, err.Error(), http.StatusConflict)
		return
	}

	// Get download URL from the resolved candidate (honors the control channel
	// source), falling back to the default-channel asset resolver.
	var downloadURL string
	if cpErr == nil {
		downloadURL = releases.BuildCandidateDownloadURL(s.cfg, cpCand, s.cfg.Releases.Repositories.ControlPanel, "standalone.tar")
	} else {
		url, err := s.getAssetDownloadURL(s.cfg.Releases.Repositories.ControlPanel, "standalone.tar", s.cfg.Releases.Repositories.ControlPanelTagPrefix)
		if err != nil {
			errorResponse(w, fmt.Sprintf("failed to get download URL: %v", err), http.StatusInternalServerError)
			return
		}
		downloadURL = url
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
	closeErr := tmpFile.Close()
	if err != nil {
		update.Fail("control", currentVersion, fmt.Sprintf("download failed: %v", err))
		errorResponse(w, fmt.Sprintf("failed to download: %v", err), http.StatusInternalServerError)
		return
	}
	if closeErr != nil {
		update.Fail("control", currentVersion, fmt.Sprintf("download close failed: %v", closeErr))
		errorResponse(w, fmt.Sprintf("failed to finish download: %v", closeErr), http.StatusInternalServerError)
		return
	}
	if cpErr == nil {
		if err := releases.VerifySignedReleaseArtifact(dlClient, downloadURL, tmpFile.Name(), cpCand.ArtifactSHA256); err != nil {
			update.Fail("control", currentVersion, err.Error())
			errorResponse(w, err.Error(), http.StatusConflict)
			return
		}
	}

	update.Emit("control", update.StatusInstalling, 40, "Stopping Control Panel...")

	// Stop service
	exec.Command("incus", "exec", containerName, "--", "systemctl", "stop", "youeye-id").Run()
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
	if out, err := exec.Command("incus", "exec", containerName, "--",
		"bash", "-c", fmt.Sprintf("cd %s && pnpm install styled-jsx --silent 2>/dev/null || true", appDir)).CombinedOutput(); err != nil {
		fmt.Printf("[update] Warning: styled-jsx install issue: %s (%v)\n", strings.TrimSpace(string(out)), err)
	}

	// Clean up
	exec.Command("incus", "exec", containerName, "--", "rm", "/tmp/update.tar").Run()

	update.Emit("control", update.StatusRestarting, 70, "Starting Control Panel...")

	if err := s.ensureControlIdentityService(containerName, appDir); err != nil {
		exec.Command("incus", "exec", containerName, "--", "systemctl", "stop", "youeye-control").Run()
		exec.Command("incus", "snapshot", "restore", containerName, "pre-update").Run()
		exec.Command("incus", "exec", containerName, "--", "systemctl", "start", "youeye-control").Run()
		update.Fail("control", currentVersion, fmt.Sprintf("failed to ensure identity provider service: %v", err))
		errorResponse(w, fmt.Sprintf("failed to ensure identity provider service: %v", err), http.StatusInternalServerError)
		return
	}

	// Start service
	exec.Command("incus", "exec", containerName, "--", "systemctl", "start", "youeye-control").Run()
	exec.Command("incus", "exec", containerName, "--", "systemctl", "start", "youeye-id").Run()

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
		exec.Command("incus", "exec", containerName, "--", "systemctl", "stop", "youeye-id").Run()
		exec.Command("incus", "exec", containerName, "--", "systemctl", "stop", "youeye-control").Run()
		exec.Command("incus", "snapshot", "restore", containerName, "pre-update").Run()
		exec.Command("incus", "exec", containerName, "--", "systemctl", "start", "youeye-control").Run()
		exec.Command("incus", "exec", containerName, "--", "systemctl", "start", "youeye-id").Run()

		update.Fail("control", currentVersion, "health check failed, rolled back")
		errorResponse(w, "update failed, rolled back", http.StatusInternalServerError)
		return
	}

	update.Complete("control", currentVersion, latestVersion)
	if out, err := runIncusCommand("snapshot", "delete", containerName, "pre-update"); err != nil {
		fmt.Printf("Warning: Control Panel updated but rollback snapshot cleanup failed: %v: %s\n", err, strings.TrimSpace(string(out)))
	}

	// Record channel provenance for the installed release.
	if cpErr == nil {
		if err := update.WriteProvenance(channels.ComponentControl, update.ProvenanceEntry{
			Version:        latestVersion,
			Tag:            cpCand.Tag,
			Branch:         cpCand.Branch,
			Source:         cpCand.Source,
			ArtifactSHA256: cpCand.ArtifactSHA256,
		}); err != nil {
			fmt.Printf("Warning: could not record provenance: %v\n", err)
		}
	}

	jsonResponse(w, map[string]string{
		"status":      "success",
		"message":     fmt.Sprintf("Control Panel updated from %s to %s", version.FormatVersion(currentVersion), version.FormatVersion(latestVersion)),
		"old_version": currentVersion,
		"new_version": latestVersion,
	})

	// Trigger infrastructure reconciliation asynchronously after responding.
	// This deploys any missing infrastructure containers (Pi-Hole, Caddy, etc.)
	// without touching existing ones. Run in a goroutine so the API response
	// returns immediately — reconciliation can take several minutes.
	go s.reconcileInfrastructure()
}

func (s *Server) ensureControlIdentityService(containerName, appDir string) error {
	identityServiceScript := fmt.Sprintf(`set -e
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
	out, err := exec.Command("incus", "exec", containerName, "--", "bash", "-c", identityServiceScript).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	if err := container.EnsureControlSocketReadiness(containerName); err != nil {
		return err
	}
	return nil
}

// reconcileInfrastructure calls the CP reconcile endpoint to deploy missing
// infrastructure containers. This is called asynchronously after a CP update.
func (s *Server) reconcileInfrastructure() {
	fmt.Println("[reconcile] Starting infrastructure reconciliation...")
	hostIP := util.GetPrimaryIP()

	if err := container.RepairControlPanelPortProxy(s.cfg.Deployment.Container.Name, s.cfg.Deployment.ControlPanel.Port); err != nil {
		fmt.Printf("[reconcile] Control Panel localhost proxy repair failed: %v\n", err)
	} else {
		fmt.Println("[reconcile] Control Panel raw proxy verified localhost-only")
	}
	if err := container.EnforceUIEgressBlock(); err != nil {
		fmt.Printf("[reconcile] UI→CP ACL repair failed: %v\n", err)
	} else {
		fmt.Println("[reconcile] UI→CP ACL verified")
	}

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
	if !s.runtimeCapabilityGuard(w, appliance.ActionAppUpdate) {
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

	// Refuse mutation unless the rollback snapshot is known-good.
	if err := prepareIncusSnapshot(containerName, "pre-update", runIncusCommand); err != nil {
		errorResponse(w, err.Error(), http.StatusConflict)
		return
	}

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
	if out, err := runIncusCommand("snapshot", "delete", containerName, "pre-update"); err != nil {
		fmt.Printf("Warning: %s updated but rollback snapshot cleanup failed: %v: %s\n", appName, err, strings.TrimSpace(string(out)))
	}

	jsonResponse(w, map[string]string{
		"status":  "success",
		"message": fmt.Sprintf("%s updated to latest image", appName),
	})
}

type incusCommandRunner func(args ...string) ([]byte, error)

func runIncusCommand(args ...string) ([]byte, error) {
	return exec.Command("incus", args...).CombinedOutput()
}

func prepareIncusSnapshot(containerName, snapshotName string, run incusCommandRunner) error {
	out, err := run("snapshot", "list", containerName, "--format", "csv", "-c", "n")
	if err != nil {
		return fmt.Errorf("inspect rollback snapshots before update: %w: %s", err, strings.TrimSpace(string(out)))
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.TrimSpace(line) != snapshotName {
			continue
		}
		deleteOut, deleteErr := run("snapshot", "delete", containerName, snapshotName)
		if deleteErr != nil {
			return fmt.Errorf("remove stale rollback snapshot before update: %w: %s", deleteErr, strings.TrimSpace(string(deleteOut)))
		}
		break
	}
	createOut, createErr := run("snapshot", "create", containerName, snapshotName)
	if createErr != nil {
		return fmt.Errorf("create rollback snapshot before update: %w: %s", createErr, strings.TrimSpace(string(createOut)))
	}
	return nil
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

func readPackageVersionFromContainer(containerName string, appDirs ...string) string {
	seen := map[string]bool{}
	for _, appDir := range appDirs {
		appDir = strings.TrimSpace(appDir)
		if appDir == "" || seen[appDir] {
			continue
		}
		seen[appDir] = true
		out, err := exec.Command("incus", "exec", containerName, "--",
			"cat", appDir+"/package.json").Output()
		if err != nil {
			continue
		}
		var pkg struct {
			Version string `json:"version"`
		}
		if json.Unmarshal(out, &pkg) == nil && pkg.Version != "" {
			return pkg.Version
		}
	}
	return "unknown"
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

func getInstanceIPv4(instanceName string) (string, error) {
	out, err := exec.Command("incus", "list", "^"+instanceName+"$", "--format", "csv", "-c", "4").Output()
	if err != nil {
		return "", err
	}
	ipLine := strings.TrimSpace(string(out))
	if idx := strings.Index(ipLine, " "); idx > 0 {
		ipLine = ipLine[:idx]
	}
	if ipLine == "" {
		return "", fmt.Errorf("%s has no IPv4 address", instanceName)
	}
	return ipLine, nil
}

func ensureUIIdentityProxy(uiContainerName string) error {
	controlIP, err := getInstanceIPv4("youeye-control")
	if err != nil {
		return fmt.Errorf("resolve youeye-control IP: %w", err)
	}

	exec.Command("incus", "config", "device", "remove", uiContainerName, "identity-proxy").Run()
	out, err := exec.Command(
		"incus", "config", "device", "add", uiContainerName, "identity-proxy", "proxy",
		"bind=instance",
		"listen=tcp:0.0.0.0:3002",
		"connect=tcp:"+controlIP+":3001",
	).CombinedOutput()
	if err != nil {
		return fmt.Errorf("add identity-proxy: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// handleControlSSO manages SSO environment variables for the Control Panel container.
// GET: Check if SSO is configured
// POST: Write SSO env vars, create systemd drop-in, daemon-reload, restart (delayed)
//
//	unless restart=false is requested by a transaction that will schedule
//	its own restart after durable completion.
//
// DELETE: Remove SSO config, daemon-reload, restart (delayed)
func controlSSORestartRequested(r *http.Request) bool {
	return !strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("restart")), "false")
}

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
			"configured":            true,
			"identity_url":          envVars["IDENTITY_URL"],
			"client_id":             envVars["IDENTITY_CLIENT_ID"],
			"identity_internal_url": envVars["IDENTITY_INTERNAL_URL"],
		})

	case "POST":
		var req struct {
			IdentityURL         string `json:"identity_url"`
			ClientID            string `json:"client_id"`
			ClientSecret        string `json:"client_secret"`
			InternalURL         string `json:"internal_url"`
			IdentityInternalURL string `json:"identity_internal_url"`
			ControlURL          string `json:"control_url"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			errorResponse(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if req.IdentityURL == "" || req.ClientSecret == "" {
			errorResponse(w, "identity_url and client_secret are required", http.StatusBadRequest)
			return
		}
		if req.InternalURL == "" {
			req.InternalURL = req.IdentityInternalURL
		}
		if req.IdentityInternalURL == "" {
			req.IdentityInternalURL = req.InternalURL
		}
		if req.ClientID == "" {
			req.ClientID = "youeye-control"
		}

		// Write env file content
		envContent := fmt.Sprintf(
			"IDENTITY_URL=%s\nIDENTITY_CLIENT_ID=%s\nIDENTITY_CLIENT_SECRET=%s\nIDENTITY_INTERNAL_URL=%s\nCONTROL_EXTERNAL_URL=%s\n",
			req.IdentityURL, req.ClientID, req.ClientSecret, req.IdentityInternalURL,
			req.ControlURL,
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

		restart := controlSSORestartRequested(r)
		message := "SSO environment configured"
		if restart {
			message += ", restarting Control Panel..."
		}
		jsonResponse(w, map[string]string{
			"status":  "configured",
			"message": message,
		})

		if restart {
			// Restart CP after a short delay so the response can be sent.
			go func() {
				time.Sleep(2 * time.Second)
				exec.Command("incus", "exec", containerName, "--", "systemctl", "restart", "youeye-control").Run()
			}()
		}

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
			serviceDir := getServiceWorkingDir(containerName, "youeye-ui", cfg.Deployment.UI.AppDir)
			version = readPackageVersionFromContainer(containerName, serviceDir, "/opt/youeye-ui", cfg.Deployment.UI.AppDir, "/opt/app")
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
			ssoConfigured = err == nil && strings.Contains(string(envOut), "IDENTITY_CLIENT_ID")
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
	serviceDir := getServiceWorkingDir(containerName, "youeye-ui", s.cfg.Deployment.UI.AppDir)
	return readPackageVersionFromContainer(containerName, serviceDir, "/opt/youeye-ui", s.cfg.Deployment.UI.AppDir, "/opt/app")
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
		configured := envVars["IDENTITY_CLIENT_ID"] != ""

		serviceOut, _ := exec.Command("incus", "exec", containerName, "--",
			"systemctl", "is-active", "youeye-ui").Output()
		serviceActive := strings.TrimSpace(string(serviceOut)) == "active"

		jsonResponse(w, map[string]interface{}{
			"configured":     configured,
			"service_active": serviceActive,
			"client_id":      envVars["IDENTITY_CLIENT_ID"],
			"domain":         envVars["UI_EXTERNAL_URL"],
		})

	case "POST":
		var req struct {
			IdentityURL      string `json:"identity_url"`
			IdentityInternal string `json:"identity_internal_url"`
			ClientID         string `json:"client_id"`
			ClientSecret     string `json:"client_secret"`
			JWTSecret        string `json:"jwt_secret"`
			DatabaseURL      string `json:"database_url"`
			Domain           string `json:"domain"`
			BaseURL          string `json:"base_url"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			errorResponse(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if req.ClientID == "" || req.ClientSecret == "" || req.DatabaseURL == "" {
			errorResponse(w, "client_id, client_secret, and database_url are required", http.StatusBadRequest)
			return
		}
		if req.IdentityURL == "" || req.IdentityInternal == "" {
			errorResponse(w, "identity_url and identity_internal_url are required", http.StatusBadRequest)
			return
		}

		if err := ensureUIIdentityProxy(containerName); err != nil {
			errorResponse(w, "failed to configure UI identity proxy: "+err.Error(), http.StatusInternalServerError)
			return
		}

		// Build env file content
		envContent := fmt.Sprintf(`# YouEye UI Environment - configured by Control Panel
IDENTITY_URL=%s
IDENTITY_INTERNAL_URL=%s
IDENTITY_CLIENT_ID=%s
IDENTITY_CLIENT_SECRET=%s
JWT_SECRET=%s
DATABASE_URL=%s
UI_EXTERNAL_URL=%s
SECURE_COOKIES=false
NODE_ENV=production
PORT=3000
HOSTNAME=0.0.0.0
`,
			req.IdentityURL,
			req.IdentityInternal,
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
  identity_id TEXT UNIQUE,
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
	ReleaseSource  *ReleaseSource    `yaml:"-" json:"release_source,omitempty"`
	// ReleaseChannels is populated on GET only (effective + raw override view).
	// It is never written back through this struct — channels.Save is the single
	// writer for the release_channels block.
	ReleaseChannels *channelsView `yaml:"-" json:"release_channels,omitempty"`
	// Extra holds arbitrary key-value pairs that the Control Panel needs
	// to persist (e.g. tls_acme_account_key, tls_cert_pem). Spine doesn't
	// interpret these — it just stores and returns them.
	Extra map[string]string `yaml:"extra,omitempty" json:"extra,omitempty"`
	// Foreign holds top-level yaml blocks Spine doesn't model (e.g. the CP's
	// nested identity config). They round-trip through GET/PATCH and survive
	// every save. A nil value marks the key for deletion on save.
	Foreign map[string]interface{} `yaml:"-" json:"-"`
}

// structOwnedConfigKeys are the top-level youeye.yaml keys produced by the
// YouEyeConfig struct marshal. Anything else in the file is foreign and is
// preserved verbatim across saves (release_channels, identity, …).
var structOwnedConfigKeys = map[string]bool{
	"site_name": true, "domain": true, "subdomains": true,
	"setup_completed": true, "release_branch": true, "language": true,
	"extra": true,
}

type ReleaseSource struct {
	RepoURL      string `json:"repo_url"`
	Provider     string `json:"provider"`
	BaseURL      string `json:"base_url"`
	APIPath      string `json:"api_path"`
	Organization string `json:"organization"`
	Repository   string `json:"repository"`
}

var youeyeConfigPath = "/var/lib/youeye/config/youeye.yaml"
var youeyeConfigMu sync.Mutex

func (s *Server) releaseSource() *ReleaseSource {
	repo := s.cfg.CoreReleaseRepo()
	return &ReleaseSource{
		RepoURL:      repo.RepoURL,
		Provider:     repo.Provider,
		BaseURL:      repo.BaseURL,
		APIPath:      repo.APIPath,
		Organization: repo.Organization,
		Repository:   repo.Repository,
	}
}

// attachChannels populates the release_channels view on a config response.
// A load failure is non-fatal — the rest of the config still returns.
func (s *Server) attachChannels(cfg *YouEyeConfig) {
	chCfg, err := channels.Load()
	if err != nil {
		return
	}
	view := s.buildChannelsView(chCfg)
	cfg.ReleaseChannels = &view
}

func releaseRepoURLFromPatch(patch map[string]interface{}) (string, bool, error) {
	if raw, ok := patch["release_source"]; ok {
		source, ok := raw.(map[string]interface{})
		if !ok {
			return "", false, fmt.Errorf("release_source must be an object")
		}
		if repoURL, ok := source["repo_url"].(string); ok {
			return repoURL, true, nil
		}
	}
	if repoURL, ok := patch["repo_url"].(string); ok {
		return repoURL, true, nil
	}
	return "", false, nil
}

func (s *Server) clearUpdatesCache() {
	s.updatesMu.Lock()
	defer s.updatesMu.Unlock()
	s.updatesCache = nil
	s.updatesTime = time.Time{}
}

func (s *Server) applyReleaseRepoURL(rawURL string) error {
	repo, err := config.ParseReleaseRepoURL(rawURL)
	if err != nil {
		return err
	}
	if err := config.WriteCoreRepoURL("", repo.RepoURL); err != nil {
		return err
	}

	s.cfg.Releases.RepoURL = repo.RepoURL
	s.cfg.Releases.Provider = repo.Provider
	s.cfg.Releases.BaseURL = repo.BaseURL
	s.cfg.Releases.APIPath = repo.APIPath
	s.cfg.Releases.Organization = repo.Organization
	s.cfg.Releases.Repositories.Spine = repo.Repository
	s.cfg.Releases.Repositories.ControlPanel = repo.Repository
	s.cfg.Releases.Repositories.UI = repo.Repository
	if s.cfg.Releases.Repositories.SpineTagPrefix == "" {
		s.cfg.Releases.Repositories.SpineTagPrefix = "spine"
	}
	if s.cfg.Releases.Repositories.ControlPanelTagPrefix == "" {
		s.cfg.Releases.Repositories.ControlPanelTagPrefix = "cp"
	}
	if s.cfg.Releases.Repositories.UITagPrefix == "" {
		s.cfg.Releases.Repositories.UITagPrefix = "ui"
	}
	s.clearUpdatesCache()
	return nil
}

// loadYouEyeConfig reads the youeye.yaml config file
func loadYouEyeConfig() (*YouEyeConfig, error) {
	cfg := &YouEyeConfig{
		SiteName: "YouEye",
		Subdomains: map[string]string{
			"control":  "control",
			"identity": "id",
			"dns":      "dns",
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

	// Collect foreign top-level keys so they round-trip through GET/PATCH.
	// release_channels is excluded: it is exposed via the channelsView instead.
	var raw map[string]interface{}
	if yaml.Unmarshal(data, &raw) == nil {
		for key, val := range raw {
			if structOwnedConfigKeys[key] || key == "release_channels" {
				continue
			}
			if cfg.Foreign == nil {
				cfg.Foreign = make(map[string]interface{})
			}
			cfg.Foreign[key] = val
		}
	}

	return cfg, nil
}

// configJSON merges the struct-owned fields with foreign blocks for API
// responses, so keys like the CP's identity config round-trip through GET.
func configJSON(cfg *YouEyeConfig) map[string]interface{} {
	out := map[string]interface{}{}
	if data, err := json.Marshal(cfg); err == nil {
		_ = json.Unmarshal(data, &out)
	}
	for key, val := range cfg.Foreign {
		if val == nil {
			continue
		}
		if _, present := out[key]; !present {
			out[key] = val
		}
	}
	return out
}

// saveYouEyeConfig writes the youeye.yaml config file. The struct marshal only
// produces struct-owned keys, so every foreign top-level block in the existing
// file (release_channels, identity, …) is preserved, and cfg.Foreign edits are
// applied on top (nil = delete).
func saveYouEyeConfig(cfg *YouEyeConfig) error {
	if err := os.MkdirAll(filepath.Dir(youeyeConfigPath), 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	// The struct marshal only produces struct-owned keys. Preserve every
	// foreign block from the existing file (release_channels, identity, …),
	// then overlay cfg.Foreign edits (nil value = delete the key).
	var merged map[string]yaml.Node
	if yaml.Unmarshal(data, &merged) != nil || merged == nil {
		merged = map[string]yaml.Node{}
	}
	if existing, err := os.ReadFile(youeyeConfigPath); err == nil {
		var doc map[string]yaml.Node
		if yaml.Unmarshal(existing, &doc) == nil {
			for key, node := range doc {
				if structOwnedConfigKeys[key] {
					continue
				}
				if _, present := merged[key]; !present {
					merged[key] = node
				}
			}
		}
	}
	for key, val := range cfg.Foreign {
		if val == nil {
			delete(merged, key)
			continue
		}
		encoded, err := yaml.Marshal(val)
		if err != nil {
			return fmt.Errorf("failed to marshal foreign key %q: %w", key, err)
		}
		var node yaml.Node
		if err := yaml.Unmarshal(encoded, &node); err != nil {
			return fmt.Errorf("failed to encode foreign key %q: %w", key, err)
		}
		// Unmarshal wraps the value in a document node — unwrap it.
		if node.Kind == yaml.DocumentNode && len(node.Content) == 1 {
			merged[key] = *node.Content[0]
		} else {
			merged[key] = node
		}
	}
	if remarshaled, err := yaml.Marshal(merged); err == nil {
		data = remarshaled
	} else {
		return fmt.Errorf("failed to merge config document: %w", err)
	}

	header := "# YouEye Configuration\n# Managed by Spine API - do not edit manually unless you know what you're doing\n\n"
	directory := filepath.Dir(youeyeConfigPath)
	temporary, err := os.CreateTemp(directory, ".youeye.yaml.*.tmp")
	if err != nil {
		return fmt.Errorf("failed to create temporary config: %w", err)
	}
	temporaryPath := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	if err := temporary.Chmod(0600); err != nil {
		cleanup()
		return fmt.Errorf("failed to protect temporary config: %w", err)
	}
	if _, err := temporary.Write([]byte(header + string(data))); err != nil {
		cleanup()
		return fmt.Errorf("failed to write temporary config: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("failed to sync temporary config: %w", err)
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("failed to close temporary config: %w", err)
	}
	if err := os.Rename(temporaryPath, youeyeConfigPath); err != nil {
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("failed to replace config atomically: %w", err)
	}
	dir, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("failed to open config directory for sync: %w", err)
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return fmt.Errorf("failed to sync config directory: %w", err)
	}
	return nil
}

// handleYouEyeConfig handles GET/PUT/PATCH for the site-level youeye.yaml config
func (s *Server) handleYouEyeConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPut || r.Method == http.MethodPatch {
		youeyeConfigMu.Lock()
		defer youeyeConfigMu.Unlock()
	}
	switch r.Method {
	case "GET":
		cfg, err := loadYouEyeConfig()
		if err != nil {
			errorResponse(w, err.Error(), http.StatusInternalServerError)
			return
		}
		cfg.ReleaseSource = s.releaseSource()
		s.attachChannels(cfg)
		jsonResponse(w, configJSON(cfg))

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
				"control":  "control",
				"identity": "id",
				"dns":      "dns",
			}
		}
		if err := saveYouEyeConfig(&newCfg); err != nil {
			errorResponse(w, err.Error(), http.StatusInternalServerError)
			return
		}
		newCfg.ReleaseSource = s.releaseSource()
		s.attachChannels(&newCfg)
		jsonResponse(w, map[string]interface{}{
			"status": "saved",
			"config": configJSON(&newCfg),
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
			s.clearUpdatesCache()
		}
		if v, ok := patch["language"].(string); ok {
			existing.Language = v
		}
		if repoURL, ok, err := releaseRepoURLFromPatch(patch); err != nil {
			errorResponse(w, err.Error(), http.StatusBadRequest)
			return
		} else if ok {
			if err := s.applyReleaseRepoURL(repoURL); err != nil {
				errorResponse(w, err.Error(), http.StatusBadRequest)
				return
			}
		}

		// Validate release_channels up-front so a bad patch fails before we
		// write anything. The actual channel write happens AFTER
		// saveYouEyeConfig below, because saveYouEyeConfig marshals a partial
		// struct that would otherwise clobber the release_channels block.
		var chCfg *channels.Config
		if raw, ok := patch["release_channels"]; ok {
			chPatch, ok := raw.(map[string]interface{})
			if !ok {
				errorResponse(w, "release_channels must be an object", http.StatusBadRequest)
				return
			}
			loaded, err := channels.Load()
			if err != nil {
				errorResponse(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if err := applyChannelsPatch(loaded, chPatch); err != nil {
				errorResponse(w, err.Error(), http.StatusBadRequest)
				return
			}
			chCfg = loaded
		}

		// Store unrecognized keys so the Control Panel can persist arbitrary
		// settings without Spine knowing each field: strings go to Extra
		// (legacy behavior — TLS certs, ACME keys), any other JSON value
		// (nested identity config, lists, …) round-trips as a foreign yaml
		// block, and an explicit null deletes the foreign key.
		knownKeys := map[string]bool{
			"site_name": true, "domain": true, "subdomains": true,
			"setup_completed": true, "release_branch": true, "language": true,
			"release_source": true, "repo_url": true, "extra": true,
			"release_channels": true,
		}
		for key, val := range patch {
			if knownKeys[key] {
				continue
			}
			if s, ok := val.(string); ok {
				if existing.Extra == nil {
					existing.Extra = make(map[string]string)
				}
				existing.Extra[key] = s
				continue
			}
			if existing.Foreign == nil {
				existing.Foreign = make(map[string]interface{})
			}
			existing.Foreign[key] = val // nil (JSON null) marks deletion
		}

		if err := saveYouEyeConfig(existing); err != nil {
			errorResponse(w, err.Error(), http.StatusInternalServerError)
			return
		}

		// Persist channels AFTER the youeye.yaml write. channels.Save does a
		// read-modify-write of the full document, re-adding release_channels (and
		// mirroring the default branch into release_branch) without disturbing the
		// keys just written.
		if chCfg != nil {
			if err := chCfg.Save(); err != nil {
				errorResponse(w, err.Error(), http.StatusInternalServerError)
				return
			}
			s.clearUpdatesCache()
		}

		existing.ReleaseSource = s.releaseSource()
		s.attachChannels(existing)
		jsonResponse(w, map[string]interface{}{
			"status": "updated",
			"config": configJSON(existing),
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
//	"ghcr.io/example/app"           → ("ghcr.io",   "example/app")
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
	decoder := json.NewDecoder(io.LimitReader(r.Body, 2*1024*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cfg); err != nil {
		errorResponse(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if cfg.TargetPath == "" {
		errorResponse(w, "target_path is required", http.StatusBadRequest)
		return
	}
	if cfg.Passphrase == "" && cfg.UseStoredPassphrase {
		stored, err := backup.ReadPassphrase("/var/lib/youeye/control/.deploy_secret")
		if err != nil {
			errorResponse(w, "stored recovery key is unavailable", http.StatusBadRequest)
			return
		}
		cfg.Passphrase = stored
	}
	if cfg.Passphrase == "" {
		errorResponse(w, "passphrase is required", http.StatusBadRequest)
		return
	}
	if cfg.StagingDir == "" {
		errorResponse(w, "staging_dir is required", http.StatusBadRequest)
		return
	}
	if cfg.BackupType != "core" && cfg.BackupType != "app" {
		errorResponse(w, "backup_type must be core or app", http.StatusBadRequest)
		return
	}
	if cfg.BackupType == "app" && cfg.AppID == "" {
		errorResponse(w, "app_id is required for app backups", http.StatusBadRequest)
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

// handleBackupMedia detects eligible non-system drives without mutating them.
func (s *Server) handleBackupMedia(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	media, err := backup.ListMedia()
	if err != nil {
		errorResponse(w, fmt.Sprintf("Failed to inspect backup drives: %v", err), http.StatusInternalServerError)
		return
	}
	jsonResponse(w, map[string]interface{}{"media": media})
}

func (s *Server) handleBackupMediaPrepare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var request struct {
		MediaID      string `json:"media_id"`
		Confirmation string `json:"confirmation"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 64*1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || request.MediaID == "" {
		errorResponse(w, "media_id and confirmation are required", http.StatusBadRequest)
		return
	}
	media, err := backup.PrepareMedia(request.MediaID, request.Confirmation)
	if err != nil {
		errorResponse(w, fmt.Sprintf("Could not prepare backup drive: %v", err), http.StatusBadRequest)
		return
	}
	jsonResponse(w, media)
}

func (s *Server) handleBackupMediaEject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var request struct {
		MediaID string `json:"media_id"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 16*1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || request.MediaID == "" {
		errorResponse(w, "media_id is required", http.StatusBadRequest)
		return
	}
	if err := backup.UnmountMedia(request.MediaID); err != nil {
		errorResponse(w, fmt.Sprintf("Could not eject backup drive: %v", err), http.StatusBadRequest)
		return
	}
	jsonResponse(w, map[string]string{"status": "ejected"})
}

func (s *Server) handleBackupRepositoryStore(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var request backup.RepositoryStoreRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, 128*1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil {
		errorResponse(w, "invalid repository store request", http.StatusBadRequest)
		return
	}
	if request.Passphrase == "" && request.UseStoredPassphrase {
		stored, err := backup.ReadPassphrase("/var/lib/youeye/control/.deploy_secret")
		if err != nil {
			errorResponse(w, "stored recovery key is unavailable", http.StatusBadRequest)
			return
		}
		request.Passphrase = stored
	}
	if err := backup.StoreBackupSet(request); err != nil {
		errorResponse(w, fmt.Sprintf("Could not store recovery point: %v", err), http.StatusBadRequest)
		return
	}
	jsonResponse(w, map[string]string{"status": "stored", "backup_id": request.BackupID})
}

func (s *Server) handleBackupRepositoryImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var request backup.RepositoryImportRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, 64*1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil {
		errorResponse(w, "invalid repository import request", http.StatusBadRequest)
		return
	}
	if request.Passphrase == "" && request.UseStoredPassphrase {
		stored, err := backup.ReadPassphrase("/var/lib/youeye/control/.deploy_secret")
		if err != nil {
			errorResponse(w, "stored recovery key is unavailable", http.StatusBadRequest)
			return
		}
		request.Passphrase = stored
	}
	importPath, err := backup.ImportBackupSet(request)
	if err != nil {
		errorResponse(w, fmt.Sprintf("Could not import recovery point: %v", err), http.StatusBadRequest)
		return
	}
	jsonResponse(w, map[string]string{"status": "imported", "backup_path": importPath})
}

func (s *Server) handleBackupRepositoryCatalog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	mediaID := r.URL.Query().Get("media_id")
	if mediaID == "" {
		errorResponse(w, "media_id is required", http.StatusBadRequest)
		return
	}
	points, err := backup.RecoveryPoints(mediaID)
	if err != nil {
		errorResponse(w, fmt.Sprintf("Could not read recovery catalog: %v", err), http.StatusBadRequest)
		return
	}
	jsonResponse(w, map[string]interface{}{"recovery_points": points})
}

func (s *Server) handleBackupRecoveryKey(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var request struct {
		Passphrase string `json:"passphrase"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 8*1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || len(request.Passphrase) < 12 || len(request.Passphrase) > 256 {
		errorResponse(w, "recovery key must contain 12 to 256 characters", http.StatusBadRequest)
		return
	}
	if err := backup.StorePassphrase(request.Passphrase, "/var/lib/youeye/control/.deploy_secret"); err != nil {
		errorResponse(w, "could not protect the recurring backup recovery key", http.StatusInternalServerError)
		return
	}
	jsonResponse(w, map[string]string{"status": "stored"})
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

// handleBackupApplyVolumes atomically restores the persistent-data paths
// declared by a decrypted, validated YouEye backup archive.
// POST /api/backup/apply-volumes
func (s *Server) handleBackupApplyVolumes(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var request struct {
		StagingDir string `json:"staging_dir"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 64*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil || request.StagingDir == "" {
		errorResponse(w, "staging_dir is required", http.StatusBadRequest)
		return
	}
	restored, err := backup.ApplyVolumes(request.StagingDir)
	if err != nil {
		errorResponse(w, fmt.Sprintf("Volume restore failed: %v", err), http.StatusBadRequest)
		return
	}
	jsonResponse(w, map[string]interface{}{"status": "ok", "restored": restored})
}

func (s *Server) handleBackupIncusPrepare(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var request backup.IncusPrepareRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, 64*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil || request.StagingDir == "" {
		errorResponse(w, "invalid Incus recovery request", http.StatusBadRequest)
		return
	}
	result, err := backup.PrepareIncusRecovery(request)
	if err != nil {
		errorResponse(w, fmt.Sprintf("Incus recovery preparation failed: %v", err), http.StatusBadRequest)
		return
	}
	jsonResponse(w, result)
}

func (s *Server) handleBackupIncusImportInstance(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var request backup.IncusInstanceImportRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, 64*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		errorResponse(w, "invalid Incus instance import request", http.StatusBadRequest)
		return
	}
	if err := backup.ImportIncusInstance(request); err != nil {
		errorResponse(w, fmt.Sprintf("Incus instance import failed: %v", err), http.StatusBadRequest)
		return
	}
	jsonResponse(w, map[string]string{"status": "imported", "name": request.Name})
}

// handleMetrics returns real host-level CPU, memory, disk, and system info.
// This runs on the host (not in a container), so /proc and df reflect the
// actual Linux server metrics.
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	result := map[string]interface{}{}

	// Hostname
	hostname, err := os.Hostname()
	if err != nil {
		hostname = "unknown"
	}
	result["hostname"] = hostname
	result["primary_ip"] = util.GetPrimaryIP()

	// OS
	result["os"] = getOSRelease()

	// Kernel
	kernel := "unknown"
	if data, err := os.ReadFile("/proc/version"); err == nil {
		parts := strings.SplitN(strings.TrimSpace(string(data)), " ", 4)
		if len(parts) >= 3 {
			kernel = parts[2]
		}
	}
	result["kernel"] = kernel

	// Uptime
	uptime := "unknown"
	if data, err := os.ReadFile("/proc/uptime"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) >= 1 {
			var secs float64
			fmt.Sscanf(fields[0], "%f", &secs)
			totalSec := int(secs)
			days := totalSec / 86400
			hours := (totalSec % 86400) / 3600
			minutes := (totalSec % 3600) / 60
			uptime = fmt.Sprintf("%dd %dh %dm", days, hours, minutes)
		}
	}
	result["uptime"] = uptime

	// Load average
	loadAvg := "unknown"
	if data, err := os.ReadFile("/proc/loadavg"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) >= 3 {
			loadAvg = strings.Join(fields[:3], " ")
		}
	}
	result["load_average"] = loadAvg

	// CPU
	cpuCores := 0
	cpuModel := "unknown"
	if data, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		lines := strings.Split(string(data), "\n")
		for _, line := range lines {
			if strings.HasPrefix(line, "processor") {
				cpuCores++
			}
			if strings.HasPrefix(line, "model name") && cpuModel == "unknown" {
				parts := strings.SplitN(line, ":", 2)
				if len(parts) == 2 {
					cpuModel = strings.TrimSpace(parts[1])
				}
			}
		}
	}
	if cpuCores == 0 {
		cpuCores = 1
	}

	// CPU usage from /proc/stat (two samples, 200ms apart)
	cpuUsage := 0.0
	readCPUStat := func() (idle, total uint64) {
		data, err := os.ReadFile("/proc/stat")
		if err != nil {
			return 0, 0
		}
		lines := strings.Split(string(data), "\n")
		if len(lines) == 0 {
			return 0, 0
		}
		fields := strings.Fields(lines[0]) // "cpu" aggregate line
		if len(fields) < 5 {
			return 0, 0
		}
		var vals [10]uint64
		for i := 1; i < len(fields) && i <= 10; i++ {
			fmt.Sscanf(fields[i], "%d", &vals[i-1])
		}
		for _, v := range vals {
			total += v
		}
		idle = vals[3] // idle is 4th field
		return idle, total
	}
	idle1, total1 := readCPUStat()
	time.Sleep(200 * time.Millisecond)
	idle2, total2 := readCPUStat()
	if total2 > total1 {
		totalDelta := float64(total2 - total1)
		idleDelta := float64(idle2 - idle1)
		cpuUsage = ((totalDelta - idleDelta) / totalDelta) * 100
	}

	result["cpu"] = map[string]interface{}{
		"cores":         cpuCores,
		"model":         cpuModel,
		"usage_percent": fmt.Sprintf("%.1f", cpuUsage),
	}

	// Memory
	totalMB, usedMB, freeMB := 0, 0, 0
	if data, err := os.ReadFile("/proc/meminfo"); err == nil {
		lines := strings.Split(string(data), "\n")
		memMap := map[string]int{}
		for _, line := range lines {
			parts := strings.Fields(line)
			if len(parts) >= 2 {
				key := strings.TrimSuffix(parts[0], ":")
				var val int
				fmt.Sscanf(parts[1], "%d", &val)
				memMap[key] = val
			}
		}
		totalKB := memMap["MemTotal"]
		availKB := memMap["MemAvailable"]
		totalMB = totalKB / 1024
		freeMB = availKB / 1024
		usedMB = totalMB - freeMB
	}
	result["memory"] = map[string]interface{}{
		"total_mb": totalMB,
		"used_mb":  usedMB,
		"free_mb":  freeMB,
	}

	// Disk (root filesystem)
	totalGB, usedGB, freeGB := 0, 0, 0
	if out, err := exec.Command("df", "-BG", "/").Output(); err == nil {
		lines := strings.Split(strings.TrimSpace(string(out)), "\n")
		if len(lines) >= 2 {
			fields := strings.Fields(lines[1])
			if len(fields) >= 4 {
				fmt.Sscanf(strings.TrimSuffix(fields[1], "G"), "%d", &totalGB)
				fmt.Sscanf(strings.TrimSuffix(fields[2], "G"), "%d", &usedGB)
				fmt.Sscanf(strings.TrimSuffix(fields[3], "G"), "%d", &freeGB)
			}
		}
	}
	result["disk"] = map[string]interface{}{
		"total_gb": totalGB,
		"used_gb":  usedGB,
		"free_gb":  freeGB,
	}

	jsonResponse(w, result)
}
