package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"

	"strings"
	"sync"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/backup"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/consoleaccess"
	"github.com/youeye-platform/YouEye/spine/internal/container"
	"github.com/youeye-platform/YouEye/spine/internal/networkstatus"
	"github.com/youeye-platform/YouEye/spine/internal/remoteaccess"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
	"github.com/youeye-platform/YouEye/spine/internal/update"
	"github.com/youeye-platform/YouEye/spine/internal/util"
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
	coreUpdateOperations CoreUpdateOperations
	coreStatePath        string
	sourceTree           string
	coreBootstrapPath    string
	version              string
	socketPath           string
	mux                  *http.ServeMux
	cfg                  *config.Config
	authLimiter          *authRateLimiter
	runtimeDetect        func() (appliance.RuntimeStatus, *appliance.Manifest, error)
	systemUpdate         systemUpdateService
	remoteAccess         remoteAccessService
	consoleAccess        consoleAccessService
	networkStatus        networkStatusService
	controlRestart       *controlRestarter

	// Status cache — avoids shelling out on every request
	statusMu     sync.Mutex
	statusCache  map[string]interface{}
	statusTime   time.Time
	metricsMu    sync.Mutex
	metricsCache map[string]interface{}
	metricsTime  time.Time
	metricsCPU   hostCPUCounters

	// Updates cache
	updatesMu    sync.Mutex
	updatesCache map[string]interface{}
	releaseIndex releaseIndexCache
	updatesTime  time.Time
}

func NewServer(version string, cfg *config.Config) *Server {
	s := &Server{
		version:       version,
		socketPath:    cfg.API.SocketPath,
		mux:           http.NewServeMux(),
		cfg:           cfg,
		authLimiter:   newAuthRateLimiter(cfg),
		runtimeDetect: appliance.Detect,
		systemUpdate:  systemupdate.NewDefault(),
		remoteAccess:  remoteaccess.NewDefault(),
		consoleAccess: consoleaccess.Default(),
		networkStatus: networkstatus.NewDefault(),
	}
	s.controlRestart = newControlRestarter(cfg.Deployment.Container.Name)
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
	s.mux.HandleFunc("/api/auth/verify", s.handleAuthVerify)
	s.mux.HandleFunc("/api/postgres/credentials", s.handlePostgresCredentials)
	s.mux.HandleFunc("/api/pihole/credentials", s.handlePiholeCredentials)
	s.mux.HandleFunc("/api/control/sso", s.handleControlSSO)
	s.mux.HandleFunc("/api/control/restart", s.handleControlRestart)
	s.mux.HandleFunc("/api/ui/sso", s.handleUISSO)
	// UI updates are handled by the Control Panel directly (lxd-updater), not Spine
	s.mux.HandleFunc("/api/config", s.handleYouEyeConfig)
	s.mux.HandleFunc("/api/releases/channel", s.handleReleaseChannel)
	s.mux.HandleFunc("/api/releases/index", s.handleReleaseIndex)
	s.mux.HandleFunc("/api/spine/status", s.handleSpineStatus)
	s.mux.HandleFunc("/api/update/status", s.handleUpdateStatus)
	s.mux.HandleFunc("/api/appliance/core-update/status", s.handleCoreUpdateStatus)
	s.mux.HandleFunc("/api/appliance/core-update/check", s.handleCoreUpdateCheck)
	for _, action := range []string{"stage", "activate", "resume", "recover", "cancel"} {
		s.mux.HandleFunc("/api/appliance/core-update/"+action, s.handleCoreUpdateAction(action))
	}
	s.mux.HandleFunc("/api/appliance/system-update/status", s.handleSystemUpdateStatus)
	s.mux.HandleFunc("/api/appliance/remote-access/keys", s.handleRemoteAccessKeys)
	s.mux.HandleFunc("/api/appliance/remote-access/keys/", s.handleRemoteAccessKey)
	s.mux.HandleFunc("/api/console", s.handleConsoleAccess)
	s.mux.HandleFunc("/api/console/", s.handleConsoleAccess)
	s.mux.HandleFunc("/api/appliance/network", s.handleNetworkStatus)
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
	s.controlRestart.resume()

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

// handleVersion answers what this Spine binary calls itself (version: its
// baked value, which a 0.6.11 Spine compares during a Spine trial), the
// installed release's version (release; what callers show and compare) and
// the git tree this binary was built from (source_tree).
func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	out := map[string]string{
		"version": s.version,
		"service": "youeye",
	}
	if receipt, err := (systemupdate.CoreManager{Root: s.coreRoot()}).ReadReceipt(); err == nil {
		out["release"] = receipt.Release.Version
	}
	if releasecache.ValidGitTree(s.sourceTree) {
		out["source_tree"] = s.sourceTree
	}
	jsonResponse(w, out)
}

// SetSourceTree records the git tree this Spine binary was built from.
func (s *Server) SetSourceTree(tree string) { s.sourceTree = tree }

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	const cacheTTL = 30 * time.Second

	s.statusMu.Lock()
	if s.statusCache != nil && time.Since(s.statusTime) < cacheTTL {
		cached := s.statusCache
		s.statusMu.Unlock()
		jsonResponse(w, cached)
		return
	}
	// Keep the collector serialized until the cache is populated. Waiting
	// readers reuse this result instead of launching duplicate Incus execs.

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
	var persistent *appliance.PersistentStatus
	warning := ""
	if runtimeStatus.Kind == appliance.RuntimeApplianceImage && manifest != nil {
		inspected, err := appliance.InspectPersistentStatus(*manifest)
		persistent = &inspected
		if err != nil {
			warning = inspected.ErrorCode
		}
	}
	if runtimeErr != nil {
		warning = "appliance_recovery_required"
	}
	status := statusDocument(s.version, incusVer, osRel, controlSt, uiSt, runtimeStatus, persistent, warning)

	s.statusCache = status
	s.statusTime = time.Now()
	s.statusMu.Unlock()

	jsonResponse(w, status)
}

// statusDocument is the body of GET /api/status. The Control Panel builds its
// backup identity from it (contracts/spine-cp/status-appliance.json).
func statusDocument(spineVersion, incusVersion, osRelease string, controlPanel, ui map[string]interface{}, runtime appliance.RuntimeStatus, persistent *appliance.PersistentStatus, warning string) map[string]interface{} {
	status := map[string]interface{}{
		"spine":         map[string]string{"version": spineVersion},
		"incus":         map[string]string{"version": incusVersion},
		"control_panel": controlPanel,
		"ui":            ui,
		"host":          map[string]string{"os": osRelease},
		"runtime":       runtime,
	}
	if persistent != nil {
		status["persistent_state"] = *persistent
	}
	if warning != "" {
		status["runtime_warning"] = warning
	}
	return status
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

// handleUpdateStatus returns the current update status from the status file.
func (s *Server) handleUpdateStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	jsonResponse(w, update.ReadStatus())
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

// Read status metadata without starting an operation/process inside the guest.
func readStatusContainerFile(container, path string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "incus", "file", "pull", container+path, "-").Output()
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
		// version.json says what the installed tree was built from: a version,
		// and from 0.6.12 builds on the git tree, which is its identity.
		verOut, err := readStatusContainerFile("youeye-control", "/opt/app/version.json")
		if err == nil {
			identity := container.ParseInstalledIdentity(verOut)
			if identity.Version != "" {
				result["version"] = identity.Version
			}
			if identity.SourceTree != "" {
				result["source_tree"] = identity.SourceTree
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

// getControlVersion gets the current Control Panel version from container
func (s *Server) getControlVersion() string {
	return container.GetInstalledVersion(s.cfg.Deployment.Container.Name, s.cfg.Deployment.ControlPanel.AppDir)
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
	if version := readPackageIdentityFromContainer(containerName, appDirs...).Version; version != "" {
		return version
	}
	return "unknown"
}

// readPackageIdentityFromContainer reads what the first installed tree among
// appDirs says about itself: its version, and its git tree when its
// version.json has one (builds from 0.6.12 on).
func readPackageIdentityFromContainer(containerName string, appDirs ...string) container.InstalledIdentity {
	seen := map[string]bool{}
	for _, appDir := range appDirs {
		appDir = strings.TrimSpace(appDir)
		if appDir == "" || seen[appDir] {
			continue
		}
		seen[appDir] = true
		// version.json is written by the build; package.json carries a placeholder in newer builds.
		for _, name := range []string{"/version.json", "/package.json"} {
			out, err := readStatusContainerFile(containerName, appDir+name)
			if err != nil {
				continue
			}
			identity := container.ParseInstalledIdentity(out)
			if identity.Version != "" && identity.Version != "0.0.0" {
				if name != "/version.json" {
					identity.SourceTree = ""
				}
				return identity
			}
		}
	}
	return container.InstalledIdentity{}
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

		// The Control Panel reads the file at its next start: the caller asks for that restart
		// (/api/control/restart), which waits for running app and platform work.
		jsonResponse(w, map[string]string{
			"status":  "configured",
			"message": "SSO environment configured",
		})

	default:
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleControlRestart schedules a restart of the Control Panel service: after the delay, as soon as no app or
// platform work is running (controlRestarter). It answers at once.
// POST /api/control/restart?delay=5 (delay in seconds, default 2, max 30)
// GET answers whether a restart waits, since when, and since when it is known to wait past its longest wait under
// a platform backup or restore (controlRestartStatus); the Control Panel's health monitor reads it.
func (s *Server) handleControlRestart(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		jsonResponse(w, s.controlRestart.status())
		return
	}
	if r.Method != "POST" {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	delay := 2
	if d := r.URL.Query().Get("delay"); d != "" {
		var parsed int
		if _, err := fmt.Sscanf(d, "%d", &parsed); err == nil && parsed > 0 && parsed <= 30 {
			delay = parsed
		}
	}

	s.controlRestart.schedule(time.Duration(delay) * time.Second)
	jsonResponse(w, map[string]string{
		"status":  "scheduled",
		"message": fmt.Sprintf("Control Panel will restart in %d seconds, or when the app or platform work running then has finished", delay),
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
		var ip string
		var identity container.InstalledIdentity
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
			identity = readPackageIdentityFromContainer(containerName, serviceDir, "/opt/youeye-ui", cfg.Deployment.UI.AppDir, "/opt/app")
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
			envOut, err := readStatusContainerFile(containerName, "/etc/youeye-ui.env")
			ssoConfigured = err == nil && strings.Contains(string(envOut), "IDENTITY_CLIENT_ID")
		}()
		wg.Wait()

		if serviceActive {
			result["enabled"] = true
			result["status"] = "running"
		} else {
			result["status"] = "installed"
		}
		// As before, an unreadable version is reported as "unknown".
		result["version"] = "unknown"
		if identity.Version != "" {
			result["version"] = identity.Version
		}
		if identity.SourceTree != "" {
			result["source_tree"] = identity.SourceTree
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
	Language       string            `yaml:"language,omitempty" json:"language"`
	// Extra holds arbitrary key-value pairs that the Control Panel needs
	// to persist (settings it owns). Spine doesn't
	// interpret these — it just stores and returns them.
	Extra map[string]string `yaml:"extra,omitempty" json:"extra,omitempty"`
	// Foreign holds top-level yaml blocks Spine doesn't model (e.g. the CP's
	// nested identity config). They round-trip through GET/PATCH and survive
	// every save. A nil value marks the key for deletion on save.
	Foreign map[string]interface{} `yaml:"-" json:"-"`
}

// structOwnedConfigKeys are the top-level youeye.yaml keys produced by the
// YouEyeConfig struct marshal. Anything else in the file is foreign and is
// preserved verbatim across saves (identity, …).
var structOwnedConfigKeys = map[string]bool{
	"site_name": true, "domain": true, "subdomains": true,
	"setup_completed": true, "language": true,
	"extra": true,
}

var youeyeConfigPath = "/var/lib/youeye/config/youeye.yaml"
var youeyeConfigMu sync.Mutex

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
	// Retired release settings from older files are not exposed.
	var raw map[string]interface{}
	if yaml.Unmarshal(data, &raw) == nil {
		for key, val := range raw {
			if structOwnedConfigKeys[key] || key == "release_channels" || key == "release_branch" || key == "releases" {
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
// file (identity, …) is preserved, and cfg.Foreign edits are
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
	// foreign block from the existing file (identity, …),
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
		if v, ok := patch["language"].(string); ok {
			existing.Language = v
		}

		// Store unrecognized keys so the Control Panel can persist arbitrary
		// settings without Spine knowing each field: strings go to Extra
		// (TLS certs, ACME keys), any other JSON value
		// (nested identity config, lists, …) round-trips as a foreign yaml
		// block, and an explicit null deletes the foreign key.
		knownKeys := map[string]bool{
			"site_name": true, "domain": true, "subdomains": true,
			"setup_completed": true, "language": true, "extra": true,
			// Retired release settings: the box's repository and channel live
			// only in protected State (youeye channel / /api/releases/channel).
			"release_branch": true, "release_source": true, "repo_url": true, "release_channels": true,
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

		jsonResponse(w, map[string]interface{}{
			"status": "updated",
			"config": configJSON(existing),
		})

	default:
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
	}
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

	backupID, err := backup.Run(r.Context(), cfg)
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

// stepRequestContext is the context of a long backup or restore step (backup.StepCeiling): it ends when the
// caller hangs up, which stops the step's commands. Go's server only notices a caller that went away once the
// request body has been read to its end, and a JSON decoder stops at the end of the value, before the end of
// the Control Panel's chunked body; so the rest is read here.
func stepRequestContext(r *http.Request) context.Context {
	_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, 1024*1024))
	return r.Context()
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
	if err := backup.StoreBackupSet(stepRequestContext(r), request); err != nil {
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
	importPath, err := backup.ImportBackupSet(stepRequestContext(r), request)
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

	result, err := backup.RestoreArchive(stepRequestContext(r), cfg)
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
	restored, err := backup.ApplyVolumes(stepRequestContext(r), request.StagingDir)
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
	result, err := backup.PrepareIncusRecovery(stepRequestContext(r), request)
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
	if err := backup.ImportIncusInstance(stepRequestContext(r), request); err != nil {
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
	s.metricsMu.Lock()
	if s.metricsCache != nil && time.Since(s.metricsTime) < 15*time.Second {
		cached := s.metricsCache
		s.metricsMu.Unlock()
		jsonResponse(w, cached)
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

	// Steady observations cover the interval between shared snapshots rather
	// than repeatedly measuring only the request's own short startup burst.
	cpuUsage := s.sampleHostCPU()

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

	s.metricsCache = result
	s.metricsTime = time.Now()
	s.metricsMu.Unlock()
	jsonResponse(w, result)
}
