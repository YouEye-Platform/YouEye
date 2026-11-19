package installer

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// The graphical installer: `youeye-installer serve` is a small JSON API over the
// text wizard's functions plus the embedded web UI that a kiosk browser (cog)
// shows on the machine's own screen. It listens on loopback only and runs one
// installation session; the answer it writes is the text wizard's answer.

const defaultServeListen = "127.0.0.1:8090"

//go:embed web
var installerWebFiles embed.FS

type installerServer struct {
	config     installConfig
	runner     applianceCommandRunner
	answerPath string
	start      func(installConfig) <-chan engineMsg
	// log receives plain progress text (the live ISO sends it to the serial console).
	log  io.Writer
	port string

	finished   chan struct{}
	finishOnce sync.Once

	mu        sync.Mutex
	loaded    bool
	inventory applianceWizardModel
	loadErr   error
	console   consoleAccessPolicy
	install   *serveInstall
}

type serveInstall struct {
	events   []serveProgress
	finished bool
	failed   bool
	changed  chan struct{}
}

type serveProgress struct {
	Stage   string  `json:"stage"`
	Detail  string  `json:"detail,omitempty"`
	Percent float64 `json:"percent"`
	Done    bool    `json:"done,omitempty"`
	Error   string  `json:"error,omitempty"`
}

type serveDisk struct {
	Path     string   `json:"path"`
	Model    string   `json:"model"`
	Serial   string   `json:"serial"`
	Size     string   `json:"size"`
	Contents []string `json:"contents"`
	// Installed: the drive holds a readable YouEye installation.
	// InstalledRelease is the release version its State records, when readable.
	Installed           bool   `json:"installed,omitempty"`
	InstalledRelease    string `json:"installed_release,omitempty"`
	Warning             string `json:"warning,omitempty"`
	Unavailable         string `json:"unavailable,omitempty"`
	PreserveUnavailable string `json:"preserve_unavailable,omitempty"`
}

type serveAdapter struct {
	Name string `json:"name"`
	MAC  string `json:"mac"`
}

type serveState struct {
	Phase           string         `json:"phase"`
	Error           string         `json:"error,omitempty"`
	SourceTree      string         `json:"source_tree,omitempty"`
	MinimumSize     string         `json:"minimum_size"`
	RecommendedSize string         `json:"recommended_size"`
	Disks           []serveDisk    `json:"disks"`
	DefaultDisk     string         `json:"default_disk,omitempty"`
	Adapters        []serveAdapter `json:"adapters"`
	Console         string         `json:"console"`
	Progress        *serveProgress `json:"progress,omitempty"`
}

type serveConsoleRequest struct {
	RootPassword bool   `json:"root_password"`
	PasswordSSH  bool   `json:"password_ssh"`
	Password     string `json:"password"`
	Confirm      string `json:"confirm"`
}

type serveInstallRequest struct {
	Choices        applianceChoices `json:"choices"`
	EraseConfirmed bool             `json:"erase_confirmed"`
}

// RunInstallerServe runs the graphical installer's API and web UI until the
// owner turns the machine off from it; the live ISO launcher then powers off.
func RunInstallerServe(opts CLIOptions) error {
	listen := opts.Listen
	if listen == "" {
		listen = defaultServeListen
	}
	port, err := validateServeListen(listen)
	if err != nil {
		return err
	}
	server := newInstallerServer(configFromOptions(opts), shellApplianceRunner{}, os.Stdout)
	server.port = port
	listener, err := net.Listen("tcp", listen)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", listen, err)
	}
	httpServer := &http.Server{Handler: server.handler(), ReadHeaderTimeout: 10 * time.Second}
	go server.load()
	served := make(chan error, 1)
	go func() { served <- httpServer.Serve(listener) }()
	fmt.Fprintf(server.log, "YouEye installer: choose the installation on this machine's screen (http://%s/).\n", listen)
	select {
	case err := <-served:
		return err
	case <-server.finished:
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(ctx)
	return nil
}

func newInstallerServer(config installConfig, runner applianceCommandRunner, log io.Writer) *installerServer {
	return &installerServer{
		config: config, runner: runner, answerPath: defaultInteractiveApplianceAnswerPath,
		start: startEngine, log: log, port: "8090", finished: make(chan struct{}),
		console: defaultConsoleAccessPolicy(),
	}
}

// validateServeListen accepts only loopback addresses: the installer must
// never be reachable from the network. It returns the port.
func validateServeListen(listen string) (string, error) {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return "", fmt.Errorf("--listen must be host:port: %w", err)
	}
	if !loopbackHost(host) {
		return "", fmt.Errorf("--listen must be a loopback address such as %s, not %q", defaultServeListen, host)
	}
	var number int
	if _, err := fmt.Sscanf(port, "%d", &number); err != nil || number < 1 || number > 65535 || fmt.Sprint(number) != port {
		return "", fmt.Errorf("--listen port must be 1-65535")
	}
	return port, nil
}

func loopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (s *installerServer) load() {
	loaded := loadApplianceWizardInventory(s.config.ApplianceManifestPath, s.runner)
	inventory := newApplianceWizardModel(s.config, s.runner)
	inventory, _ = inventory.Update(loaded)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.inventory, s.loadErr, s.loaded = inventory, loaded.err, true
	if loaded.err != nil {
		fmt.Fprintf(s.log, "YouEye installer: preflight failed: %v\n", loaded.err)
	}
}

func (s *installerServer) handler() http.Handler {
	static, err := fs.Sub(installerWebFiles, "web")
	if err != nil {
		panic(err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET /", http.FileServerFS(static))
	mux.HandleFunc("GET /api/state", s.handleState)
	mux.HandleFunc("POST /api/check", s.handleCheck)
	mux.HandleFunc("POST /api/console", s.handleConsole)
	mux.HandleFunc("POST /api/install", s.handleInstall)
	mux.HandleFunc("GET /api/progress", s.handleProgress)
	mux.HandleFunc("POST /api/poweroff", s.handlePowerOff)
	mux.HandleFunc("POST /api/ui-ready", s.handleUIReady)
	return s.guard(mux)
}

// guard rejects requests that do not come from this machine's own page: the
// Host header must name loopback on our port (DNS rebinding), and writes must
// be same-origin JSON.
func (s *installerServer) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.allowedHost(r.Host) {
			http.Error(w, "this installer only answers on 127.0.0.1", http.StatusMisdirectedRequest)
			return
		}
		header := w.Header()
		header.Set("Content-Security-Policy", "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		header.Set("X-Content-Type-Options", "nosniff")
		header.Set("Referrer-Policy", "no-referrer")
		header.Set("Cache-Control", "no-store")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if origin := r.Header.Get("Origin"); origin != "" && !s.allowedOrigin(origin) {
				http.Error(w, "cross-origin request refused", http.StatusForbidden)
				return
			}
			if mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mediaType != "application/json" {
				http.Error(w, "JSON required", http.StatusUnsupportedMediaType)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		}
		next.ServeHTTP(w, r)
	})
}

func (s *installerServer) allowedHost(hostHeader string) bool {
	host, port, err := net.SplitHostPort(hostHeader)
	if err != nil {
		return false
	}
	return port == s.port && loopbackHost(host)
}

func (s *installerServer) allowedOrigin(origin string) bool {
	rest, ok := strings.CutPrefix(origin, "http://")
	return ok && s.allowedHost(rest)
}

// handleUIReady: the page has painted. The live launcher waits for this
// (YOUEYE_KIOSK_READY_FILE) and falls back to the text installer when the
// kiosk never gets this far (for example a WebKit renderer that crashes on
// this machine's graphics).
func (s *installerServer) handleUIReady(w http.ResponseWriter, _ *http.Request) {
	if path := os.Getenv("YOUEYE_KIOSK_READY_FILE"); path != "" {
		if err := os.WriteFile(path, []byte("ready\n"), 0600); err != nil {
			http.Error(w, "could not record readiness", http.StatusInternalServerError)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *installerServer) handleState(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := serveState{
		Phase: "loading", MinimumSize: formatBytes(applianceTargetMinBytes),
		RecommendedSize: formatBytes(applianceRecommendedBytes), Disks: []serveDisk{}, Adapters: []serveAdapter{},
		Console: consoleAccessSummary(s.console),
	}
	switch {
	case !s.loaded:
	case s.loadErr != nil:
		state.Phase, state.Error = "error", s.loadErr.Error()
	default:
		state.Phase = "choose"
		inv := s.inventory
		// The image's own version is internal and never shown; the release to
		// install is chosen from the channel when the installation starts.
		state.SourceTree = inv.bundle.Manifest.SourceTree
		for index, disk := range inv.disks {
			entry := serveDisk{
				Path: disk.Path, Model: strings.TrimSpace(disk.Model), Serial: disk.Serial,
				Size: formatBytes(disk.SizeBytes), Contents: nonBlankSignatures(disk.Signatures),
				Warning: inv.identityWarnings[disk.Path],
			}
			if entry.Contents == nil {
				entry.Contents = []string{}
			}
			if err := inv.diskCandidateError(index); err != nil {
				entry.Unavailable = err.Error()
			}
			if installed, ok := inv.installed[disk.Path]; ok {
				entry.Installed, entry.InstalledRelease = true, installed.ReleaseVersion
				candidate := inv
				candidate.targetCur = index
				if err := candidate.preserveEligibility(); err != nil {
					entry.PreserveUnavailable = err.Error()
				}
			}
			state.Disks = append(state.Disks, entry)
		}
		if first := inv.firstValidDisk(); first >= 0 {
			state.DefaultDisk = inv.disks[first].Path
		}
		for _, adapter := range inv.adapters {
			state.Adapters = append(state.Adapters, serveAdapter{Name: adapter.Name, MAC: adapter.MAC})
		}
	}
	if s.install != nil {
		state.Phase = "installing"
		if count := len(s.install.events); count > 0 {
			last := s.install.events[count-1]
			state.Progress = &last
		}
		if s.install.finished {
			state.Phase = "complete"
			if s.install.failed {
				state.Phase = "failed"
			}
		}
	}
	writeServeJSON(w, http.StatusOK, state)
}

// handleCheck validates the choices so far, as the text wizard does when the
// owner leaves a screen.
func (s *installerServer) handleCheck(w http.ResponseWriter, r *http.Request) {
	var choices applianceChoices
	if !decodeServeJSON(w, r, &choices) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.readyForChoices(); err != nil {
		writeServeError(w, http.StatusConflict, err)
		return
	}
	if _, err := s.inventory.answerFor(choices, s.console, true, "00000000000000000000000000000000"); err != nil {
		writeServeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeServeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *installerServer) handleConsole(w http.ResponseWriter, r *http.Request) {
	var request serveConsoleRequest
	if !decodeServeJSON(w, r, &request) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.readyForChoices(); err != nil {
		writeServeError(w, http.StatusConflict, err)
		return
	}
	policy, err := buildConsoleAccess(request.RootPassword, request.PasswordSSH, request.Password, request.Confirm, s.console)
	if err != nil {
		writeServeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	s.console = policy
	writeServeJSON(w, http.StatusOK, map[string]any{"console": consoleAccessSummary(policy), "root_password_set": policy.RootPasswordHash != ""})
}

func (s *installerServer) handleInstall(w http.ResponseWriter, r *http.Request) {
	var request serveInstallRequest
	if !decodeServeJSON(w, r, &request) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.readyForChoices(); err != nil {
		writeServeError(w, http.StatusConflict, err)
		return
	}
	if !request.EraseConfirmed {
		writeServeError(w, http.StatusUnprocessableEntity, errors.New("confirm the installation first"))
		return
	}
	transactionID, err := newApplianceTransactionID()
	if err != nil {
		writeServeError(w, http.StatusInternalServerError, err)
		return
	}
	answer, err := s.inventory.answerFor(request.Choices, s.console, true, transactionID)
	if err != nil {
		writeServeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	if err := writeApplianceAnswerFile(s.answerPath, answer); err != nil {
		writeServeError(w, http.StatusInternalServerError, err)
		return
	}
	config := s.config
	config.ApplianceAnswerPath = s.answerPath
	install := &serveInstall{changed: make(chan struct{})}
	install.events = []serveProgress{{Stage: "Starting installation..."}}
	s.install = install
	go s.follow(install, s.start(config))
	writeServeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
}

func (s *installerServer) readyForChoices() error {
	if !s.loaded {
		return errors.New("the installer is still checking this machine")
	}
	if s.loadErr != nil {
		return s.loadErr
	}
	if s.install != nil {
		return errors.New("the installation has already started")
	}
	return nil
}

// follow records engine progress for the page and prints it as plain text.
func (s *installerServer) follow(install *serveInstall, engine <-chan engineMsg) {
	percent := 0.0
	record := func(event serveProgress) {
		s.mu.Lock()
		defer s.mu.Unlock()
		install.events = append(install.events, event)
		if event.Done {
			install.finished, install.failed = true, event.Error != ""
		}
		close(install.changed)
		install.changed = make(chan struct{})
	}
	for message := range engine {
		if message.Percent > percent {
			percent = message.Percent
		}
		event := serveProgress{Stage: message.StepName, Detail: message.LogLine, Percent: percent}
		if message.Err != nil {
			event = serveProgress{Stage: "Installation failed", Error: message.Err.Error(), Percent: percent, Done: true}
			fmt.Fprintf(s.log, "YouEye installer: installation failed: %v\n", message.Err)
		} else if message.Done {
			event = serveProgress{Stage: "Installation complete", Percent: 1, Done: true}
			fmt.Fprintln(s.log, "YouEye installer: installation complete. Remove the USB stick after the machine turns off.")
		} else {
			line := fmt.Sprintf("YouEye installer: [%3d%%] %s", int(percent*100), message.StepName)
			if message.LogLine != "" {
				line += ": " + message.LogLine
			}
			fmt.Fprintln(s.log, line)
		}
		record(event)
		if event.Done {
			return
		}
	}
	err := "the installer stopped before completion"
	fmt.Fprintf(s.log, "YouEye installer: installation failed: %s\n", err)
	record(serveProgress{Stage: "Installation failed", Error: err, Percent: percent, Done: true})
}

// handleProgress streams the installation's progress as server-sent events,
// from the first event, so a reloaded page catches up.
func (s *installerServer) handleProgress(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	install := s.install
	s.mu.Unlock()
	if install == nil {
		writeServeError(w, http.StatusConflict, errors.New("the installation has not started"))
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeServeError(w, http.StatusInternalServerError, errors.New("streaming is unavailable"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	sent := 0
	for {
		s.mu.Lock()
		pending := append([]serveProgress(nil), install.events[sent:]...)
		finished, changed := install.finished, install.changed
		s.mu.Unlock()
		for _, event := range pending {
			raw, _ := json.Marshal(event)
			fmt.Fprintf(w, "event: progress\ndata: %s\n\n", raw)
		}
		sent += len(pending)
		flusher.Flush()
		if finished {
			return
		}
		select {
		case <-changed:
		case <-r.Context().Done():
			return
		}
	}
}

// handlePowerOff ends the session; the launcher turns the machine off. It is
// refused while the installation is writing to the drive.
func (s *installerServer) handlePowerOff(w http.ResponseWriter, r *http.Request) {
	var ignored map[string]any
	if !decodeServeJSON(w, r, &ignored) {
		return
	}
	s.mu.Lock()
	running := s.install != nil && !s.install.finished
	s.mu.Unlock()
	if running {
		writeServeError(w, http.StatusConflict, errors.New("the installation is still running"))
		return
	}
	writeServeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	fmt.Fprintln(s.log, "YouEye installer: turning the machine off.")
	s.finishOnce.Do(func() { close(s.finished) })
}

func decodeServeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeServeError(w, http.StatusBadRequest, fmt.Errorf("invalid request: %w", err))
		return false
	}
	return true
}

func writeServeError(w http.ResponseWriter, status int, err error) {
	writeServeJSON(w, status, map[string]string{"error": err.Error()})
}

func writeServeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
